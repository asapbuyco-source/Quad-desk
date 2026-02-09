import os
import sys
import json
import asyncio
import numpy as np
import pandas as pd
import httpx
from datetime import datetime
from collections import deque
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from binance import AsyncClient, BinanceSocketManager
import google.generativeai as genai
from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError
from typing import List, Literal, Optional
import logging

# Setup Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("QuantDesk")

# 1. Setup & Configuration
load_dotenv()

# Validate Environment on Startup
REQUIRED_ENV_VARS = ["GEMINI_API_KEY"]
missing_vars = [var for var in REQUIRED_ENV_VARS if not os.getenv(var)]
if missing_vars:
    logger.warning(f"⚠️ Missing environment variables: {missing_vars}")

app = FastAPI()

# Enable CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Update this to specific domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# AI Configuration
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    logger.error("❌ GEMINI_API_KEY not set! AI features will not work.")
    logger.error("Set it in Railway dashboard: Settings → Variables")
    pro_model = None
    flash_model = None
else:
    genai.configure(api_key=api_key)
    try:
        # Using Gemini 3 series as per architectural standards
        pro_model = genai.GenerativeModel('gemini-3-pro-preview')
        flash_model = genai.GenerativeModel('gemini-3-flash-preview')
        logger.info("✅ Gemini models initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Gemini: {e}")
        pro_model = None
        flash_model = None

# 2. In-Memory Data Store
candle_cache = deque(maxlen=1000)

# 3. Pydantic Models for Validation
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

# 4. Background Data Ingestion
async def binance_listener():
    retry_count = 0
    while True:
        try:
            logger.info("🔌 Connecting to Binance WebSocket...")
            client = await AsyncClient.create()
            bm = BinanceSocketManager(client)
            ts = bm.kline_socket('BTCUSDT', interval=AsyncClient.KLINE_INTERVAL_1MINUTE)

            async with ts as tscm:
                logger.info("✅ Binance WebSocket Connected")
                retry_count = 0
                while True:
                    res = await tscm.recv()
                    if res:
                        k = res['k']
                        candle = {
                            'time': k['t'],
                            'open': float(k['o']),
                            'high': float(k['h']),
                            'low': float(k['l']),
                            'close': float(k['c']),
                            'volume': float(k['v'])
                        }
                        
                        if len(candle_cache) > 0 and candle_cache[-1]['time'] == candle['time']:
                            candle_cache[-1] = candle
                        else:
                            candle_cache.append(candle)
        except Exception as e:
            logger.error(f"⚠️ WebSocket Error: {e}")
            retry_count += 1
            await asyncio.sleep(min(5 * retry_count, 60)) # Exponential backoff
        finally:
            try:
                await client.close_connection()
            except:
                pass

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(binance_listener())

# 5. Helper Functions
def calculate_z_score_bands(candles):
    if not candles:
        return {}
    closes = np.array([c['close'] for c in candles])
    mean = np.mean(closes)
    std = np.std(closes)
    
    return {
        "mean": float(mean),
        "std": float(std),
        "upper_1": float(mean + 1.5 * std),
        "lower_1": float(mean - 1.5 * std),
        "upper_2": float(mean + 2.5 * std),
        "lower_2": float(mean - 2.5 * std),
    }

async def send_vantage_alert(data: MarketAnalysis, current_price: float, z_score: float):
    """
    Sends a formatted alert to Telegram if credentials are present.
    """
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    
    if not token or not chat_id:
        return

    # Determine emoji based on Z-Score
    z_emoji = "🟢"
    if abs(z_score) > 2.0: z_emoji = "🔴"
    elif abs(z_score) > 1.0: z_emoji = "🟡"

    message = (
        f"⚡ <b>VANTAGE ENTRY SIGNAL</b> ⚡\n\n"
        f"💎 <b>Pair:</b> BTC/USDT\n"
        f"💰 <b>Price:</b> ${current_price:,.2f}\n"
        f"📊 <b>Z-Score:</b> {z_emoji} {z_score:.2f}σ\n"
        f"🎯 <b>Confidence:</b> {data.confidence * 100:.0f}%\n"
        f"⚖️ <b>Risk/Reward:</b> {data.risk_reward_ratio}\n"
        f"🛡️ <b>Stop Loss:</b> ${data.stop_loss}\n"
        f"🚀 <b>Target:</b> ${data.take_profit}\n\n"
        f"🧠 <b>AI Reasoning:</b>\n<i>{data.analysis}</i>"
    )

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML"
    }

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(url, json=payload, timeout=5.0)
            if resp.status_code == 200:
                logger.info(f"📲 Telegram alert sent for Price: {current_price}")
        except Exception as e:
            logger.error(f"❌ Failed to send Telegram alert: {e}")

# 6. API Endpoints

@app.get("/health")
async def health_check():
    """Health check endpoint for Railway"""
    return {
        "status": "healthy",
        "gemini_available": pro_model is not None,
        "timestamp": datetime.now().isoformat()
    }

@app.get("/bands")
async def get_volatility_bands():
    if len(candle_cache) < 20:
        return {"error": "Not enough data"}
    
    # Use last 50 candles for calculation
    analysis_window = list(candle_cache)[-50:]
    bands = calculate_z_score_bands(analysis_window)
    return bands

@app.get("/analyze")
async def analyze_market():
    # Context gathering
    if len(candle_cache) > 0:
        context_candles = list(candle_cache)[-50:]
        closes = [c['close'] for c in context_candles]
        current_price = closes[-1]
        mean = np.mean(closes)
        std = np.std(closes)
        z_score = (current_price - mean) / std if std > 0 else 0
    else:
        current_price = 64000.00
        context_candles = []
        z_score = 0

    try:
        if not pro_model:
            raise Exception("Gemini API Key missing or model initialization failed")

        if len(candle_cache) < 30:
            raise Exception("Insufficient Data")

        prompt = f"""
        You are a Quant Analyst. Analyze these {len(context_candles)} candlestick data points for BTC/USDT.
        Current Price: {current_price}
        
        Candle Data (JSON format, last 30):
        {json.dumps(context_candles[-30:])} 

        Task:
        1. Identify key Support and Resistance levels.
        2. Determine a "Decision Price" (pivot point).
        3. Calculate Entry, Stop Loss, and Take Profit levels if a setup exists.
        4. Calculate Risk/Reward Ratio.
        5. Provide a Verdict (ENTRY, EXIT, or WAIT). 
           CRITICAL: If Risk/Reward Ratio is < 2.0, Verdict MUST be "WAIT".
        6. Provide a Confidence Score (0.0 to 1.0) based on signal clarity.

        Return EXACTLY this JSON structure:
        {{
            "support": [float, float],
            "resistance": [float, float],
            "decision_price": float,
            "verdict": "ENTRY" | "EXIT" | "WAIT",
            "confidence": float,
            "analysis": "string",
            "entry_price": float,
            "stop_loss": float,
            "take_profit": float,
            "risk_reward_ratio": float
        }}
        """
        
        # Use async generate_content to avoid blocking the event loop
        response = await pro_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text.strip():
            raise ValueError("Empty response from Gemini")

        raw_result = json.loads(response.text)
        validated = MarketAnalysis(**raw_result)
        
        # Trigger Alert
        if validated.verdict == "ENTRY" and validated.confidence >= 0.80:
            asyncio.create_task(send_vantage_alert(validated, current_price, z_score))
        
        return validated.dict()
        
    except Exception as e:
        logger.error(f"AI Analysis Error: {e}. Returning SIMULATION data.")
        # Fallback Simulation
        is_bullish = np.random.random() > 0.5
        sim_result = {
            "support": [current_price * 0.98, current_price * 0.96],
            "resistance": [current_price * 1.02, current_price * 1.04],
            "decision_price": current_price * (0.99 if is_bullish else 1.01),
            "verdict": "ENTRY" if is_bullish else "WAIT",
            "confidence": 0.85,
            "analysis": f"[SIMULATION MODE] Gemini API unavailable or errored. System detected volatility contraction near key levels. { 'Bullish' if is_bullish else 'Bearish' } divergence on CVD indicates potential move.",
            "entry_price": current_price,
            "stop_loss": current_price * 0.98,
            "take_profit": current_price * 1.05,
            "risk_reward_ratio": 2.5,
            "is_simulated": True
        }
        return sim_result

@app.get("/market-intelligence")
async def get_market_intelligence():
    """
    Generates market intelligence using Gemini 3.
    Falls back to robust simulation if AI is unavailable.
    """
    current_time = datetime.now().isoformat()
    
    if len(candle_cache) > 0:
        current_price = candle_cache[-1]['close']
        start_price = candle_cache[0]['close']
        change_pct = ((current_price - start_price) / start_price) * 100
        trend_desc = f"{'up' if change_pct > 0 else 'down'} {abs(change_pct):.2f}% over the last {len(candle_cache)} minutes"
    else:
        current_price = 64000.00
        trend_desc = "consolidating"

    try:
        if not flash_model:
            raise Exception("Gemini API Key missing or model initialization failed")

        prompt = f"""
        You are a senior financial data simulator.
        Market Context: Asset: BTC/USDT, Price: ${current_price:,.2f}, Trend: {trend_desc}, Time: {current_time}

        Task:
        Generate a comprehensive 'Market Intelligence' payload containing:
        1. A 'Main Narrative' summarizing the current market driver.
        2. A 'Whale Impact' assessment (High/Medium/Low).
        3. An 'AI Sentiment Score' (-1.0 to 1.0).
        4. An array of 6 realistic, simulated financial news articles.
           - Sources: Bloomberg, Reuters, Coindesk, The Block, Deribit Insights.
           - 'url' should be '#'.

        Return EXACTLY this JSON structure:
        {{
            "articles": [
                {{ 
                    "source": {{ "id": "source-id", "name": "Source Name" }}, 
                    "author": "Author Name", 
                    "title": "Headline", 
                    "description": "Brief summary", 
                    "url": "#", 
                    "urlToImage": null, 
                    "publishedAt": "{current_time}", 
                    "content": "..." 
                }}
            ],
            "intelligence": {{
                "main_narrative": "string",
                "whale_impact": "High" | "Medium" | "Low",
                "ai_sentiment_score": float
            }}
        }}
        """

        # Use async generate_content to avoid blocking the event loop
        response = await flash_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        result = json.loads(response.text)
        result['is_simulated'] = False
        return result

    except Exception as e:
        logger.error(f"Gemini Intelligence Error: {e}. Returning SIMULATION data.")
        
        # Fallback Simulation Data
        return {
            "articles": [
                {
                    "source": { "id": "sim-bloomberg", "name": "BLOOMBERG (SIM)" },
                    "author": "System",
                    "title": "Simulation: Institutional Flows Detected in Dark Pools",
                    "description": "Backend AI is offline. This is generated placeholder data representing potential market conditions.",
                    "url": "#",
                    "urlToImage": None,
                    "publishedAt": current_time,
                    "content": ""
                },
                {
                    "source": { "id": "sim-reuters", "name": "REUTERS (SIM)" },
                    "author": "System",
                    "title": "Simulation: Volatility Expected to Expand",
                    "description": "System warning: Live intelligence feed interrupted. Displaying cached logic.",
                    "url": "#",
                    "urlToImage": None,
                    "publishedAt": current_time,
                    "content": ""
                }
            ],
            "intelligence": {
                "main_narrative": "SIMULATION MODE: AI Uplink Interrupted. Market consolidating.",
                "whale_impact": "Low",
                "ai_sentiment_score": 0.0
            },
            "is_simulated": True
        }

if __name__ == "__main__":
    import uvicorn
    # Use PORT env var if available (Railway/Heroku), else default to 8000
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
