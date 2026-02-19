import os
import logging
import asyncio
import json
import time
import psutil
import numpy as np
import httpx
from collections import deque
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import google.generativeai as genai
from dotenv import load_dotenv
from newsapi import NewsApiClient

load_dotenv()

class ListHandler(logging.Handler):
    def __init__(self, log_queue):
        super().__init__()
        self.log_queue = log_queue

    def emit(self, record):
        try:
            log_entry = {
                "timestamp": datetime.fromtimestamp(record.created).isoformat(),
                "level": record.levelname,
                "message": record.getMessage(),
                "module": record.module
            }
            self.log_queue.append(log_entry)
        except Exception:
            self.handleError(record)

log_buffer = deque(maxlen=100)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        ListHandler(log_buffer) 
    ]
)
logger = logging.getLogger("QuantDesk")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
NEWS_API_KEY = os.getenv("NEWS_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
FRONTEND_URL = os.getenv("FRONTEND_URL", "*")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

newsapi = NewsApiClient(api_key=NEWS_API_KEY) if NEWS_API_KEY else None

state = {
    "start_time": time.time(),
    "market_intel_cache": {
        "data": None,
        "timestamp": 0
    },
    "autonomous_active": False,
    "alert_config": {
        "symbol": "BTCUSDT",
        "bot_token": TELEGRAM_BOT_TOKEN,
        "chat_id": TELEGRAM_CHAT_ID
    }
}

# --- Pydantic Models ---

class AlertSnapshot(BaseModel):
    symbol: str
    price: float
    zScore: float
    tacticalProbability: float
    aiScore: float
    # Flexible extra fields for frontend state snapshots
    skewness: Optional[float] = 0
    bayesianPosterior: Optional[float] = 0.5
    expectedValueRR: Optional[float] = 0
    biasAlignment: Optional[bool] = False
    liquidityAgreement: Optional[bool] = False
    regimeAgreement: Optional[bool] = False
    sweeps: Optional[List[Any]] = []
    bosDirection: Optional[str] = None
    regimeType: Optional[str] = "UNCERTAIN"
    trendDirection: Optional[str] = "NEUTRAL"
    volatilityPercentile: Optional[float] = 0
    institutionalCVD: Optional[float] = 0
    ofi: Optional[float] = 0
    toxicity: Optional[float] = 0
    retailSentiment: Optional[float] = 50
    dailyBias: Optional[str] = "NEUTRAL"
    h4Bias: Optional[str] = "NEUTRAL"
    h1Bias: Optional[str] = "NEUTRAL"

    class Config:
        extra = "allow"

class TelegramPayload(BaseModel):
    symbol: str
    direction: str
    confidence: float
    entry: float
    stop: float
    target: float
    reasoning: str
    rrRatio: Optional[float] = 0
    conditions: Optional[List[str]] = []
    botToken: Optional[str] = None
    chatId: Optional[str] = None

class AnalysisRequest(BaseModel):
    symbol: str
    price: float
    netDelta: float
    totalVolume: float
    pocPrice: float
    cvdTrend: str
    candleCount: int

class AlertConfigPayload(BaseModel):
    symbol: str
    telegram_bot_token: Optional[str]
    telegram_chat_id: Optional[str]

# --- Helper Functions ---

async def fetch_binance_candles(symbol: str, interval: str, limit: int = 300):
    """Fetches historical k-lines from Binance REST API."""
    url = "https://api.binance.com/api/v3/klines"
    params = {"symbol": symbol.upper(), "interval": interval, "limit": limit}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, params=params, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
            # Binance Format: [t, o, h, l, c, v, T, q, n, V, Q, B]
            # Map to consistent internal format: [time_ms, open, high, low, close, volume]
            formatted_data = []
            for d in data:
                formatted_data.append([
                    int(d[0]),          # Open time
                    float(d[1]),        # Open
                    float(d[2]),        # High
                    float(d[3]),        # Low
                    float(d[4]),        # Close
                    float(d[5])         # Volume
                ])
            return formatted_data
        except Exception as e:
            logger.error(f"Binance Fetch Error: {e}")
            return []

# --- Lifespan & App ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    state["start_time"] = time.time()
    logger.info("🚀 Quant Desk Backend Active.")
    yield

app = FastAPI(lifespan=lifespan)

origins = [FRONTEND_URL]
if FRONTEND_URL == "*":
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routes ---

@app.get("/health")
def health_check():
    return {"status": "ok", "timestamp": time.time()}

@app.get("/history")
async def get_history(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), interval: str = "1m", limit: int = 300):
    return await fetch_binance_candles(symbol, interval, limit)

@app.get("/heatmap")
async def get_heatmap():
    # Real-time Z-Score calculation using Binance data
    pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
    results = []
    for p in pairs:
        klines = await fetch_binance_candles(p, "1h", 21)
        if len(klines) < 21: continue
        closes = [x[4] for x in klines]
        mean = np.mean(closes[:-1])
        std = np.std(closes[:-1])
        z = (closes[-1] - mean) / (std or 1e-6)
        results.append({"pair": p, "zScore": float(z), "price": float(closes[-1])})
    return results

@app.get("/analyze")
async def analyze_market(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), model: str = "gemini-1.5-flash"):
    klines = await fetch_binance_candles(symbol, "15m", 30)
    if not klines: raise HTTPException(status_code=502, detail="Upstream Down")
    
    current_price = float(klines[-1][4])
    high = max([x[2] for x in klines])
    low = min([x[3] for x in klines])
    close = current_price
    
    # Calculate Pivot Points as fallback
    pivot = (high + low + close) / 3
    r1 = 2 * pivot - low
    s1 = 2 * pivot - high

    if not GEMINI_API_KEY:
        return {
            "support": [s1], "resistance": [r1], "decision_price": pivot,
            "verdict": "WAIT", "confidence": 0.6, "analysis": "Mathematical Pivot Analysis (AI Offline).",
            "risk_reward_ratio": 2.0, "entry_price": current_price, "stop_loss": s1, "take_profit": r1
        }

    prices_str = "\n".join([f"T:{x[0]} O:{x[1]} H:{x[2]} L:{x[3]} C:{x[4]}" for x in klines])
    prompt = f"HFT Algo: Analyze OHLCV for {symbol}.\n{prices_str}\nOutput JSON only: {{support:[num], resistance:[num], decision_price:num, verdict:ENTRY|EXIT|WAIT, confidence:0-1, analysis:str, risk_reward_ratio:num}}"

    try:
        # Use valid model name
        gen_model = genai.GenerativeModel(model if "gemini" in model else "gemini-1.5-flash")
        response = await gen_model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        # Clean potential markdown wrapping
        if "{" in text:
            text = text[text.find("{"):text.rfind("}")+1]
        return json.loads(text)
    except Exception as e:
        logger.error(f"AI Analysis Failed: {e}")
        return {
            "support": [s1], "resistance": [r1], "decision_price": pivot,
            "verdict": "WAIT", "confidence": 0.5, "analysis": "Degraded Mode: Pivot Logic Applied."
        }

@app.post("/analyze/flow")
async def analyze_order_flow(req: AnalysisRequest):
    if not GEMINI_API_KEY:
        return {"verdict": "NEUTRAL", "explanation": "Statistical baseline maintained.", "confidence": 0.5, "flow_type": "NEUTRAL"}
    prompt = f"Analyze Flow for {req.symbol}: Price:{req.price} NetDelta:{req.netDelta} Vol:{req.totalVolume} POC:{req.pocPrice} CVD:{req.cvdTrend}. JSON Output only: {{verdict:str, confidence:num, explanation:str, flow_type:str}}"
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        response = await model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        if "{" in text:
            text = text[text.find("{"):text.rfind("}")+1]
        return json.loads(text)
    except Exception:
        return {"verdict": "NEUTRAL", "explanation": "Synthesis failed.", "confidence": 0, "flow_type": "Unknown"}

@app.get("/market-intelligence")
async def get_market_intel(model: str = "gemini-1.5-flash"):
    now = datetime.now().timestamp() * 1000
    cache = state["market_intel_cache"]
    if cache["data"] and (now - cache["timestamp"] < 600000): return cache["data"]
    
    articles = []
    if newsapi:
        try:
            # Using thread executor for blocking NewsAPI call
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: newsapi.get_everything(q="crypto market", language="en", sort_by="publishedAt", page_size=5))
            articles = response.get('articles', [])
        except Exception as e:
            logger.error(f"NewsAPI Error: {e}")

    intelligence = {"main_narrative": "Structural consolidation identified across primary pairs.", "whale_impact": "Medium", "ai_sentiment_score": 0.0}
    
    if GEMINI_API_KEY and articles:
        headlines = "\n".join([f"- {a['title']}" for a in articles])
        prompt = f"Read: {headlines}\nOutput JSON only: {{main_narrative:str, whale_impact:High|Medium|Low, ai_sentiment_score:num}}"
        try:
            gen_model = genai.GenerativeModel(model)
            resp = await gen_model.generate_content_async(prompt)
            text = resp.text.replace('```json', '').replace('```', '').strip()
            if "{" in text:
                text = text[text.find("{"):text.rfind("}")+1]
            intelligence = json.loads(text)
        except Exception as e:
            logger.error(f"Gemini Intel Error: {e}")

    result = {"articles": articles, "intelligence": intelligence, "timestamp": now}
    state["market_intel_cache"] = {"data": result, "timestamp": now}
    return result

@app.get("/admin/system-status")
def system_status():
    process = psutil.Process(os.getpid())
    return {
        "status": "ONLINE", "uptime": str(timedelta(seconds=int(time.time() - state["start_time"]))),
        "cpu_percent": psutil.cpu_percent(), "memory_mb": process.memory_info().rss / 1024 / 1024,
        "threads": process.num_threads(), "autonomous_active": state["autonomous_active"], "logs": list(log_buffer)
    }

# --- Alert Endpoints ---

@app.get("/alerts/status")
def get_alert_status():
    return {"autonomous_mode": state["autonomous_active"], "config": state["alert_config"]}

@app.post("/alerts/configure")
def configure_alerts(config: AlertConfigPayload):
    state["alert_config"]["symbol"] = config.symbol
    if config.telegram_bot_token:
        state["alert_config"]["bot_token"] = config.telegram_bot_token
    if config.telegram_chat_id:
        state["alert_config"]["chat_id"] = config.telegram_chat_id
    # Enable autonomous if creds present
    if state["alert_config"]["bot_token"] and state["alert_config"]["chat_id"]:
        state["autonomous_active"] = True
    return {"status": "updated", "autonomous_active": state["autonomous_active"]}

@app.post("/alerts/evaluate")
async def evaluate_alerts(snapshot: AlertSnapshot):
    """
    Evaluates market conditions sent by frontend to determine if an alert is needed.
    Acts as the brain for the frontend alert loop.
    """
    score = 0
    conditions = []
    
    # Logic: Basic scoring engine
    if abs(snapshot.zScore) > 2.0:
        score += 2
        conditions.append(f"Z-Score Extreme: {snapshot.zScore:.2f}")
    
    if snapshot.tacticalProbability > 75:
        score += 2
        conditions.append(f"AI Probability: {snapshot.tacticalProbability}%")
        
    if snapshot.biasAlignment:
        score += 1
        conditions.append("Bias Alignment")
        
    if snapshot.institutionalCVD != 0 and (snapshot.institutionalCVD > 0) == (snapshot.trendDirection == 'BULL'):
        score += 1
        conditions.append("CVD Confirmation")

    should_alert = score >= 4
    
    analysis = None
    if should_alert:
        analysis = {
            "direction": "LONG" if snapshot.trendDirection == 'BULL' else "SHORT",
            "confidence": min(score / 6, 0.99),
            "entry": snapshot.price,
            "stop": snapshot.price * 0.98 if snapshot.trendDirection == 'BULL' else snapshot.price * 1.02,
            "target": snapshot.price * 1.04 if snapshot.trendDirection == 'BULL' else snapshot.price * 0.96,
            "reasoning": f"Confluence of factors: {', '.join(conditions)}"
        }

    return {"shouldAlert": should_alert, "score": score, "passedConditions": conditions, "aiAnalysis": analysis}

@app.post("/alerts/send-telegram")
async def send_telegram(payload: TelegramPayload):
    token = payload.botToken or state["alert_config"]["bot_token"]
    chat_id = payload.chatId or state["alert_config"]["chat_id"]
    
    if not token or not chat_id:
        raise HTTPException(status_code=400, detail="Missing Telegram credentials")
    
    icon = "🟢" if payload.direction == "LONG" else "🔴"
    msg = (
        f"{icon} *QUANT DESK ALERT: {payload.symbol}*\n"
        f"**Direction:** {payload.direction}\n"
        f"**Confidence:** {int(payload.confidence * 100)}%\n"
        f"**Entry:** {payload.entry:.2f}\n"
        f"**Stop:** {payload.stop:.2f}\n"
        f"**Target:** {payload.target:.2f} (R:R {payload.rrRatio:.2f})\n\n"
        f"_{payload.reasoning}_"
    )
    
    telegram_url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(telegram_url, json={"chat_id": chat_id, "text": msg, "parse_mode": "Markdown"})
            resp.raise_for_status()
            return {"status": "sent"}
        except Exception as e:
            logger.error(f"Telegram Send Error: {e}")
            raise HTTPException(status_code=502, detail=str(e))

@app.post("/alerts/test")
async def test_alert(payload: TelegramPayload):
    # Reuse send logic
    payload.reasoning = "Test Alert from Quant Desk Profile Config."
    return await send_telegram(payload)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))