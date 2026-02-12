
import os
import sys
import json
import asyncio
import numpy as np
import httpx
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai
from dotenv import load_dotenv
from pydantic import BaseModel
from typing import List, Literal, Optional, Dict, Any
import logging

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("QuantDesk")

# 1. Setup & Configuration
load_dotenv()

# API Keys with provided fallbacks
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
NEWS_API_KEY = os.getenv("NEWS_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
# Binance keys (Optional for public data, but good to have ready)
BINANCE_API_KEY = os.getenv("BINANCE_API_KEY")
BINANCE_API_SECRET = os.getenv("BINANCE_API_SECRET")

# Initialize AI Client
if GEMINI_API_KEY:
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        logger.info("✅ Google Gemini initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Google Gemini: {e}")
else:
    logger.error("❌ GEMINI_API_KEY not set! AI features will not work.")

# 3. Pydantic Models
class MarketAnalysis(BaseModel):
    support: List[float]
    resistance: List[float]
    decision_price: float
    verdict: Literal["ENTRY", "EXIT", "WAIT"]
    confidence: float 
    analysis: str
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    risk_reward_ratio: Optional[float] = None
    is_simulated: bool = False

# --- ALERT SYSTEM MODELS ---

class LiquidityEvent(BaseModel):
    side: str # BUY or SELL
    timestamp: float # in ms

class MarketSnapshot(BaseModel):
    symbol: str
    price: float
    zScore: float
    skewness: float
    bayesianPosterior: float
    expectedValueRR: float
    
    # Tactical
    tacticalProbability: float
    biasAlignment: bool
    liquidityAgreement: bool
    regimeAgreement: bool
    aiScore: float
    
    # Liquidity History
    sweeps: List[LiquidityEvent]
    bosDirection: Optional[str] = None # BULLISH or BEARISH or None
    
    # Regime
    regimeType: str
    trendDirection: str
    volatilityPercentile: float
    
    # Metrics
    institutionalCVD: float
    ofi: float
    toxicity: float
    retailSentiment: float
    
    # Biases (for AI Context)
    dailyBias: str
    h4Bias: str
    h1Bias: str

class AlertDecision(BaseModel):
    shouldAlert: bool
    reason: str
    score: int
    passedConditions: List[str]
    aiAnalysis: Optional[Dict[str, Any]] = None

class TelegramPayload(BaseModel):
    symbol: str
    direction: str
    confidence: float
    entry: float
    stop: float
    target: float
    rrRatio: float
    reasoning: str
    conditions: List[str]

app = FastAPI()

# Frontend URL configuration
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://quandt-desk.netlify.app")
ALLOWED_ORIGINS = [
    FRONTEND_URL,
    "https://quandt-desk.netlify.app", # Explicit add for robustness
    "http://localhost:5173", # Local development
    "http://localhost:3000", # Alternative local port
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["*"],
)

# 5. Helper Functions
async def fetch_binance_candles(symbol: str, limit: int = 50):
    """
    Fetches recent kline data with fallback logic for restricted regions.
    """
    clean_symbol = symbol.replace("/", "").upper()
    endpoints = [
        "https://api.binance.com",
        "https://api.binance.us"
    ]
    
    async with httpx.AsyncClient() as client:
        for base_url in endpoints:
            url = f"{base_url}/api/v3/klines"
            params = {
                "symbol": clean_symbol,
                "interval": "1m",
                "limit": limit
            }
            try:
                resp = await client.get(url, params=params)
                if resp.status_code == 200:
                    data = resp.json()
                    # Format to dict list
                    candles = []
                    for k in data:
                        candles.append({
                            'time': k[0],
                            'open': float(k[1]),
                            'high': float(k[2]),
                            'low': float(k[3]),
                            'close': float(k[4]),
                            'volume': float(k[5])
                        })
                    return candles
            except Exception as e:
                logger.warning(f"Fetch failed for {base_url}: {e}")
                continue
    
    logger.error(f"All providers failed for {clean_symbol}")
    return []

def calculate_z_score_bands(candles):
    """
    Calculate statistical Z-Score volatility bands.
    """
    if not candles:
        return {}
    closes = np.array([c['close'] for c in candles])
    mean = np.mean(closes)
    std = np.std(closes)
    
    return {
        "mean": float(mean),
        "std": float(std),
        "upper_1": float(mean + 1.0 * std),
        "lower_1": float(mean - 1.0 * std),
        "upper_2": float(mean + 2.0 * std),
        "lower_2": float(mean - 2.0 * std),
    }

async def send_telegram_alert(symbol: str, analysis: MarketAnalysis):
    """
    Sends a high-priority alert to Telegram if configured. (Legacy function)
    """
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return

    # Only alert on High Confidence Entries
    if analysis.verdict != "ENTRY" or analysis.confidence < 0.75:
        return

    message = (
        f"🚨 <b>QUANT DESK SIGNAL: {symbol}</b>\n\n"
        f"<b>Verdict:</b> {analysis.verdict} (Conf: {analysis.confidence*100:.0f}%)\n"
        f"<b>Entry:</b> {analysis.entry_price or analysis.decision_price}\n"
        f"<b>Target:</b> {analysis.take_profit}\n"
        f"<b>Stop:</b> {analysis.stop_loss}\n\n"
        f"<i>{analysis.analysis}</i>"
    )
    
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient() as client:
        try:
            await client.post(url, json={
                "chat_id": TELEGRAM_CHAT_ID, 
                "text": message, 
                "parse_mode": "HTML"
            })
            logger.info(f"Telegram alert sent for {symbol}")
        except Exception as e:
            logger.error(f"Failed to send Telegram alert: {e}")

async def fetch_real_news():
    """
    Fetches real crypto news using NewsAPI if key is present.
    """
    if not NEWS_API_KEY:
        return []
        
    url = "https://newsapi.org/v2/everything"
    params = {
        "q": "crypto OR bitcoin OR ethereum",
        "language": "en",
        "sortBy": "publishedAt",
        "pageSize": 5,
        "apiKey": NEWS_API_KEY
    }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("articles", [])
            return []
        except Exception as e:
            logger.error(f"NewsAPI Error: {e}")
            return []

# 6. API Endpoints

@app.get("/")
async def root():
    return {"status": "ok", "service": "Quant Desk Terminal Backend", "version": "1.1.0 (Geo-Fix)"}

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "gemini_api_key_set": bool(GEMINI_API_KEY),
        "telegram_configured": bool(TELEGRAM_BOT_TOKEN),
        "timestamp": datetime.now().isoformat()
    }

# --- NEW ALERT SYSTEM ENDPOINTS ---

@app.post("/alerts/evaluate")
async def evaluate_alert(snapshot: MarketSnapshot):
    """
    Evaluates 5 trading conditions. If 4/5 pass, queries AI for confirmation.
    """
    passed_conditions = []
    
    # 1. Sentinel Stats
    # Z-Score > 2.0 OR < -2.0, Positive Skew (safety), High Bayesian, Good RR
    cond1 = (
        abs(snapshot.zScore) > 2.0 and
        snapshot.skewness > -0.5 and
        snapshot.bayesianPosterior > 0.6 and
        snapshot.expectedValueRR >= 2.0
    )
    if cond1: passed_conditions.append("Sentinel Stats (Z>2, RR>2)")

    # 2. AI Tactical
    cond2 = (
        snapshot.tacticalProbability > 75 and
        snapshot.biasAlignment and
        snapshot.liquidityAgreement and
        snapshot.regimeAgreement and
        snapshot.aiScore > 0.7
    )
    if cond2: passed_conditions.append("AI Tactical (Prob > 75%)")

    # 3. Liquidity Pattern (Directional Sweep)
    # Check for recent sweep (last 10 mins = 600,000ms) matching BOS logic
    now = datetime.now().timestamp() * 1000
    recent_sweeps = [s for s in snapshot.sweeps if (now - s.timestamp) < 600000]
    
    has_bullish_liq = any(s.side == 'SELL' for s in recent_sweeps) and snapshot.bosDirection == 'BULLISH'
    has_bearish_liq = any(s.side == 'BUY' for s in recent_sweeps) and snapshot.bosDirection == 'BEARISH'
    
    cond3 = has_bullish_liq or has_bearish_liq
    if cond3: passed_conditions.append("Liquidity (Recent Sweep + BOS)")

    # 4. Regime Support
    cond4 = False
    if snapshot.regimeType == 'TRENDING':
        cond4 = snapshot.trendDirection != 'NEUTRAL'
    elif snapshot.regimeType == 'RANGING':
        cond4 = abs(snapshot.zScore) > 2.0
    elif snapshot.regimeType == 'EXPANDING':
        cond4 = snapshot.volatilityPercentile > 70
    
    if cond4: passed_conditions.append(f"Regime Support ({snapshot.regimeType})")

    # 5. CVD Divergence
    # Bullish Div: Price Down (Z < -2) but CVD Up (> 50)
    # Bearish Div: Price Up (Z > 2) but CVD Down (< -50)
    bull_div = snapshot.zScore < -2.0 and snapshot.institutionalCVD > 50
    bear_div = snapshot.zScore > 2.0 and snapshot.institutionalCVD < -50
    cond5 = bull_div or bear_div
    
    if cond5: passed_conditions.append("CVD Divergence")

    score = len(passed_conditions)
    
    # FAIL FAST if score < 4
    if score < 4:
        return AlertDecision(
            shouldAlert=False,
            reason=f"Only {score}/5 conditions met.",
            score=score,
            passedConditions=passed_conditions
        )

    # --- AI CONFIRMATION STEP ---
    if not GEMINI_API_KEY:
        return AlertDecision(shouldAlert=False, reason="Conditions Met but AI Key Missing", score=score, passedConditions=passed_conditions)

    try:
        model = genai.GenerativeModel('gemini-3-flash-preview')
        
        prompt = f"""
        You are a senior trading analyst. Analyze this market snapshot and respond ONLY with JSON.
        
        MARKET DATA:
        - Symbol: {snapshot.symbol}
        - Price: {snapshot.price}
        - Z-Score: {snapshot.zScore}
        - OFI: {snapshot.ofi}
        - Toxicity: {snapshot.toxicity}
        - Retail Sentiment: {snapshot.retailSentiment}% Long
        - Institutional CVD: {snapshot.institutionalCVD}

        TIMEFRAME BIAS:
        - Daily: {snapshot.dailyBias}
        - 4H: {snapshot.h4Bias}
        - 1H: {snapshot.h1Bias}

        REGIME: {snapshot.regimeType} ({snapshot.trendDirection})

        CONDITIONS MET: {score}/5
        Reasons: {', '.join(passed_conditions)}

        Response format:
        {{
          "should_trade": true/false,
          "direction": "LONG" or "SHORT",
          "confidence": 0.0 to 1.0,
          "entry": float,
          "stop": float,
          "target": float,
          "reasoning": "Brief 1-sentence explanation"
        }}
        """
        
        response = await model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        ai_res = json.loads(response.text)
        
        # Final Decision
        if ai_res.get("should_trade") is True:
            return AlertDecision(
                shouldAlert=True,
                reason="AI Confirmed Setup",
                score=score,
                passedConditions=passed_conditions,
                aiAnalysis=ai_res
            )
        else:
            return AlertDecision(
                shouldAlert=False,
                reason=f"AI Rejected: {ai_res.get('reasoning')}",
                score=score,
                passedConditions=passed_conditions,
                aiAnalysis=ai_res
            )

    except Exception as e:
        logger.error(f"AI Alert Evaluation Error: {e}")
        # Fallback if AI fails but math is good? No, safer to fail.
        return AlertDecision(
            shouldAlert=False,
            reason=f"AI Error: {str(e)}",
            score=score,
            passedConditions=passed_conditions
        )

@app.post("/alerts/send-telegram")
async def process_telegram_alert(payload: TelegramPayload):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        raise HTTPException(status_code=500, detail="Telegram not configured")

    conditions_list = "\n".join([f"✅ {c}" for c in payload.conditions])
    
    emoji = "🟢" if payload.direction == "LONG" else "🔴"
    
    msg = (
        f"{emoji} <b>TIER 1 ALERT: {payload.symbol}</b>\n\n"
        f"<b>Direction:</b> {payload.direction}\n"
        f"<b>Confidence:</b> {payload.confidence*100:.0f}%\n\n"
        f"📊 <b>Levels:</b>\n"
        f"• Entry: {payload.entry}\n"
        f"• Stop: {payload.stop}\n"
        f"• Target: {payload.target}\n"
        f"• R:R: {payload.rrRatio:.1f}:1\n\n"
        f"🤖 <b>AI Analysis:</b>\n"
        f"<i>{payload.reasoning}</i>\n\n"
        f"<b>Conditions Met:</b>\n"
        f"{conditions_list}\n\n"
        f"⏰ {datetime.now().strftime('%H:%M:%S UTC')}"
    )

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(url, json={
                "chat_id": TELEGRAM_CHAT_ID, 
                "text": msg, 
                "parse_mode": "HTML"
            })
            if resp.status_code != 200:
                logger.error(f"Telegram Error: {resp.text}")
                raise HTTPException(status_code=500, detail="Telegram API Error")
            return {"status": "sent"}
        except Exception as e:
            logger.error(f"Telegram Network Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/history")
async def proxy_history(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 1000):
    """
    Proxies historical data fetching with automated fallback for Geo-Restricted regions (US).
    Attempts Global Binance first, then Binance US.
    """
    clean_symbol = symbol.replace("/", "").upper()
    endpoints = [
        "https://api.binance.com", 
        "https://api.binance.us"
    ]
    
    async with httpx.AsyncClient() as client:
        for base_url in endpoints:
            url = f"{base_url}/api/v3/klines?symbol={clean_symbol}&interval={interval}&limit={limit}"
            try:
                resp = await client.get(url)
                data = resp.json()
                
                # Success: List of klines
                if isinstance(data, list):
                    return data
                
                # Check for Restriction Error in Dict response
                if isinstance(data, dict):
                    msg = data.get("msg", "")
                    if "restricted" in msg.lower() or "unavailable" in msg.lower():
                        logger.warning(f"Geo-Blocking detected at {base_url}. Switching to fallback.")
                        continue # Try next endpoint
                    
                    # Return actual API errors that aren't geo-blocks
                    return {"error": f"Upstream ({base_url}): {msg}"}

            except Exception as e:
                logger.error(f"Failed to fetch from {base_url}: {e}")
                continue

    return {"error": "Data unavailable. Service is restricted in your region and fallback failed."}

@app.get("/bands")
async def get_volatility_bands(symbol: str = Query("BTCUSDT", min_length=3)):
    candles = await fetch_binance_candles(symbol, limit=50)
    if len(candles) < 20:
        return {"error": "Not enough data"}
    
    bands = calculate_z_score_bands(candles)
    return bands

@app.get("/analyze")
async def analyze_market(
    background_tasks: BackgroundTasks, 
    symbol: str = Query("BTCUSDT", min_length=3),
    model: str = Query("gemini-3-pro-preview")
):
    # Fetch fresh data on demand
    context_candles = await fetch_binance_candles(symbol, limit=30)
    
    if len(context_candles) > 0:
        current_price = context_candles[-1]['close']
    else:
        current_price = 0.0

    try:
        if not GEMINI_API_KEY:
            raise Exception("Gemini API Key Missing")

        if len(context_candles) < 20:
            raise Exception("Insufficient Data")
            
        # Initialize selected model dynamically
        try:
            ai_model = genai.GenerativeModel(model)
        except Exception:
            logger.warning(f"Invalid model {model}, falling back to gemini-3-pro-preview")
            ai_model = genai.GenerativeModel('gemini-3-pro-preview')

        prompt = f"""
        Act as a high-frequency trading algorithm. Analyze these candles for {symbol}.
        Current Price: {current_price}
        Data (Last 30): {json.dumps(context_candles)} 

        Provide a JSON response with:
        - support (array of 2 floats)
        - resistance (array of 2 floats)
        - decision_price (float)
        - verdict (ENTRY/EXIT/WAIT) - Be conservative.
        - confidence (0.0-1.0)
        - analysis (concise reason)
        - risk_reward_ratio (float)
        - entry_price (float)
        - stop_loss (float)
        - take_profit (float)
        """
        
        response = await ai_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text:
             raise Exception("Empty response from AI")

        raw_result = json.loads(response.text)
        validated = MarketAnalysis(**raw_result)
        
        # Trigger Telegram Alert in background (Legacy)
        background_tasks.add_task(send_telegram_alert, symbol, validated)
        
        return validated.dict()
        
    except json.JSONDecodeError as e:
        logger.error(f"JSON Parse Error: {e}")
        return {
            "support": [current_price * 0.98, current_price * 0.96],
            "resistance": [current_price * 1.02, current_price * 1.04],
            "decision_price": current_price,
            "verdict": "WAIT",
            "confidence": 0.5,
            "analysis": f"[ERROR] AI response parsing failed. Using fallback analysis.",
            "risk_reward_ratio": 1.5,
            "is_simulated": True
        }
    except Exception as e:
        logger.error(f"AI Analysis Error: {e}")
        
        # Sanitize error message for UI
        error_msg = str(e)
        if "429" in error_msg or "Quota" in error_msg:
            clean_msg = "AI Rate Limit Exceeded (Free Tier). Switched to Local Simulation."
        elif "503" in error_msg or "Overloaded" in error_msg:
            clean_msg = "AI Service Overloaded. Switched to Local Simulation."
        else:
            clean_msg = f"Connection Issue: {error_msg[:50]}..."
            
        # Fallback Simulation
        is_bullish = np.random.random() > 0.5
        base_price = current_price if current_price > 0 else 64000
        
        return {
            "support": [base_price * 0.98, base_price * 0.96],
            "resistance": [base_price * 1.02, base_price * 1.04],
            "decision_price": base_price * (0.99 if is_bullish else 1.01),
            "verdict": "ENTRY" if is_bullish else "WAIT",
            "confidence": 0.85,
            "analysis": f"[SIMULATION] {clean_msg}",
            "risk_reward_ratio": 2.5,
            "is_simulated": True
        }

@app.get("/market-intelligence")
async def get_market_intelligence(model: str = Query("gemini-3-flash-preview")):
    current_time = datetime.now().isoformat()
    try:
        if not GEMINI_API_KEY:
             raise Exception("Gemini API Key Missing")

        # Initialize selected model dynamically
        try:
            ai_model = genai.GenerativeModel(model)
        except Exception:
            logger.warning(f"Invalid model {model}, falling back to gemini-3-flash-preview")
            ai_model = genai.GenerativeModel('gemini-3-flash-preview')

        # 1. Try to fetch real news
        real_articles = await fetch_real_news()
        
        # 2. Use Gemini to analyze the news (or generate insights if news fetch failed)
        
        if real_articles:
            news_context = json.dumps([{"title": a["title"], "desc": a["description"]} for a in real_articles])
            prompt = f"""
            Analyze these real crypto news headlines at {current_time}:
            {news_context}

            Generate a 'Market Intelligence' JSON object:
            1. 'intelligence': {{ main_narrative, whale_impact (High/Med/Low), ai_sentiment_score (-1 to 1) }}
            """
        else:
            # Fallback if NewsAPI key is missing or failed
            prompt = f"""
            Generate a 'Market Intelligence' JSON object for Crypto Markets at {current_time}.
            Include:
            1. 'articles': 5 realistic fake news headlines (Bloomberg, Reuters style).
            2. 'intelligence': {{ main_narrative, whale_impact (High/Med/Low), ai_sentiment_score (-1 to 1) }}
            """

        response = await ai_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text:
             raise Exception("Empty response from AI")

        try:
            result = json.loads(response.text)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON from Gemini Intelligence: {e}")
            raise Exception("AI returned invalid JSON")
        
        # If we had real articles, merge them into the result structure
        if real_articles:
            result['articles'] = real_articles

        result['is_simulated'] = False
        return result

    except Exception as e:
        logger.error(f"Gemini Intelligence Error: {e}")
        error_msg = str(e)
        if "429" in error_msg or "Quota" in error_msg:
            clean_msg = "AI Rate Limit Exceeded. Using synthetic data."
        else:
            clean_msg = f"Simulation Mode Active ({error_msg[:30]}...)"

        return {
            "articles": [],
            "intelligence": {
                "main_narrative": clean_msg,
                "whale_impact": "Low",
                "ai_sentiment_score": 0.0
            },
            "is_simulated": True
        }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
