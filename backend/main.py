import os
import logging
import asyncio
import json
import time
import psutil
import numpy as np
import pandas as pd
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
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://quantdesk.netlify.app")

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

class AlertSnapshot(BaseModel):
    symbol: str
    price: float
    zScore: float
    tacticalProbability: float
    aiScore: float
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

# Binance.US is accessible from US-based servers.
# Response format per kline: [openTime, open, high, low, close, volume, closeTime,
#   quoteAssetVolume, numTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]
BINANCE_BASE = "https://api.binance.us"

VALID_INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"}

async def fetch_binance_candles(symbol: str, interval: str, limit: int = 300):
    if interval not in VALID_INTERVALS:
        interval = "1m"
    url = f"{BINANCE_BASE}/api/v3/klines"
    params = {"symbol": symbol.upper(), "interval": interval, "limit": min(limit, 1000)}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, params=params, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, list):
                logger.error(f"Binance unexpected response for {symbol}: {data}")
                return []
            # Return 7 values: openTime(ms), open, high, low, close, volume, takerBuyBaseVolume
            # Index 9 of the Binance response is takerBuyBaseVolume — used for accurate CVD
            return [
                [
                    int(k[0]),      # 0: openTime in ms (already ms, no conversion needed)
                    float(k[1]),    # 1: open
                    float(k[2]),    # 2: high
                    float(k[3]),    # 3: low
                    float(k[4]),    # 4: close
                    float(k[5]),    # 5: total base asset volume
                    float(k[9]),    # 6: takerBuyBaseVolume (NEW) — for accurate historical delta
                ]
                for k in data
            ]
        except Exception as e:
            logger.error(f"Binance candle fetch error ({symbol} {interval}): {e}")
            return []

@asynccontextmanager
async def lifespan(app: FastAPI):
    state["start_time"] = time.time()
    logger.info("🚀 Quant Desk Backend Active.")
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.get("/history")
async def get_history(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), interval: str = "1m", limit: int = 300):
    return await fetch_binance_candles(symbol, interval, limit)

@app.get("/heatmap")
async def get_heatmap():
    pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    results = []
    for p in pairs:
        klines = await fetch_binance_candles(p, "1h", 21)
        if len(klines) < 21: continue
        closes = [x[4] for x in klines]
        mean = np.mean(closes[:-1])
        std = np.std(closes[:-1])
        z = (closes[-1] - mean) / (std or 1)
        results.append({"pair": p, "zScore": float(z), "price": float(closes[-1])})
    return results

@app.get("/analyze")
async def analyze_market(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), model: str = "gemini-3-flash-preview"):
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
    prompt = f"HFT Algo: Analyze OHLCV for {symbol}.\n{prices_str}\nOutput JSON: {{support:[num], resistance:[num], decision_price:num, verdict:ENTRY|EXIT|WAIT, confidence:0-1, analysis:str, risk_reward_ratio:num}}"

    try:
        gen_model = genai.GenerativeModel(model)
        response = await gen_model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception:
        return {
            "support": [s1], "resistance": [r1], "decision_price": pivot,
            "verdict": "WAIT", "confidence": 0.5, "analysis": "Degraded Mode: Pivot Logic Applied."
        }

@app.post("/analyze/flow")
async def analyze_order_flow(req: AnalysisRequest):
    if not GEMINI_API_KEY:
        return {"verdict": "NEUTRAL", "explanation": "Statistical baseline maintained.", "confidence": 0.5, "flow_type": "NEUTRAL"}
    prompt = f"Analyze Flow for {req.symbol}: Price:{req.price} NetDelta:{req.netDelta} Vol:{req.totalVolume} POC:{req.pocPrice} CVD:{req.cvdTrend}. JSON Output: {{verdict:str, confidence:num, explanation:str, flow_type:str}}"
    try:
        model = genai.GenerativeModel("gemini-3-flash-preview")
        response = await model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception:
        return {"verdict": "NEUTRAL", "explanation": "Synthesis failed.", "confidence": 0}

@app.get("/market-intelligence")
async def get_market_intel(model: str = "gemini-3-flash-preview"):
    now = datetime.now().timestamp() * 1000
    cache = state["market_intel_cache"]
    if cache["data"] and (now - cache["timestamp"] < 600000): return cache["data"]
    articles = []
    if newsapi:
        try:
            response = newsapi.get_everything(q="crypto market", language="en", sort_by="publishedAt", page_size=5)
            articles = response.get('articles', [])
        except Exception: pass
    intelligence = {"main_narrative": "Structural consolidation identified across primary pairs.", "whale_impact": "Medium", "ai_sentiment_score": 0.0}
    if GEMINI_API_KEY and articles:
        headlines = "\n".join([f"- {a['title']}" for a in articles])
        prompt = f"Read: {headlines}\nOutput JSON: {{main_narrative:str, whale_impact:High|Medium|Low, ai_sentiment_score:num}}"
        try:
            gen_model = genai.GenerativeModel(model)
            resp = await gen_model.generate_content_async(prompt)
            text = resp.text.replace('```json', '').replace('```', '').strip()
            intelligence = json.loads(text)
        except Exception: pass
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))