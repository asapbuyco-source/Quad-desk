
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

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import google.generativeai as genai
from dotenv import load_dotenv
from newsapi import NewsApiClient

# --- CONFIGURATION & LOGGING ---
load_dotenv()

# Custom Log Handler to store logs in memory
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

# Global Log Buffer (Last 100 logs)
log_buffer = deque(maxlen=100)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        ListHandler(log_buffer) # Attach our memory handler
    ]
)
logger = logging.getLogger("QuantDesk")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
NEWS_API_KEY = os.getenv("NEWS_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://quantdesk.netlify.app")

# Initialize AI & News
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

newsapi = NewsApiClient(api_key=NEWS_API_KEY) if NEWS_API_KEY else None

# --- GLOBAL STATE ---
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

# --- DATA MODELS ---
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

# --- UTILITIES ---

def map_symbol_to_kraken(symbol: str) -> str:
    """Maps internal symbols (BTCUSDT) to Kraken format (XBTUSDT or XBTUSD)."""
    base = ""
    quote = ""
    
    # Base Mapping
    if symbol.startswith("BTC"): base = "XBT"
    elif symbol.startswith("ETH"): base = "ETH"
    elif symbol.startswith("SOL"): base = "SOL"
    else: base = symbol[:3] # Fallback
    
    # Quote Mapping
    if symbol.endswith("USDT"): quote = "USDT"
    elif symbol.endswith("USD"): quote = "USD"
    else: quote = "USD"
    
    return f"{base}{quote}"

def map_interval_to_kraken(interval: str) -> int:
    """Maps Binance-style intervals to Kraken minutes."""
    mapping = {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "1h": 60,
        "4h": 240,
        "1d": 1440
    }
    return mapping.get(interval, 1)

async def fetch_kraken_candles(symbol: str, interval: str, limit: int = 300):
    """
    Fetch historical candles from Kraken Public REST API.
    Docs: https://docs.kraken.com/rest/#tag/Market-Data/operation/getOHLCData
    """
    pair = map_symbol_to_kraken(symbol)
    kraken_interval = map_interval_to_kraken(interval)
    
    url = "https://api.kraken.com/0/public/OHLC"
    params = {
        "pair": pair,
        "interval": kraken_interval
    }
    
    async with httpx.AsyncClient() as client:
        try:
            # Fake User-Agent to prevent 403s on some cloud providers
            headers = {"User-Agent": "Mozilla/5.0"}
            resp = await client.get(url, params=params, headers=headers, timeout=10.0)
            
            resp.raise_for_status()
            data = resp.json()
            
            # Kraken returns errors in a list, empty if successful
            if data.get("error"):
                error_msg = data["error"][0]
                logger.error(f"Kraken API Error: {error_msg}")
                # Handle generic unknown pair error
                if "Unknown asset pair" in error_msg:
                    raise HTTPException(status_code=404, detail="Symbol not found on Kraken")
                raise HTTPException(status_code=502, detail=f"Kraken Error: {error_msg}")

            # Kraken Result is a dict where the key is the pair name (which might differ from request)
            # e.g. Request XBTUSD -> Result XXBTZUSD
            result = data.get("result", {})
            
            # Find the first value that is a list (the OHLC data)
            ohlc_list = next((v for k, v in result.items() if isinstance(v, list)), [])
            
            # Kraken Format: [int <time>, string <open>, string <high>, string <low>, string <close>, string <vwap>, string <volume>, int <count>]
            formatted_data = []
            
            for d in ohlc_list:
                formatted_data.append([
                    int(d[0]) * 1000,   # Time to ms
                    float(d[1]),        # Open
                    float(d[2]),        # High
                    float(d[3]),        # Low
                    float(d[4]),        # Close
                    float(d[6])         # Volume
                ])
            
            # Sort by time ascending (Kraken usually returns ascending, but ensure safety)
            # Limit logic: Kraken returns last 720 points by default. We slice the last `limit`.
            return sorted(formatted_data, key=lambda x: x[0])[-limit:]
            
        except httpx.HTTPStatusError as e:
            logger.error(f"Kraken HTTP Error: {e.response.text}")
            raise HTTPException(status_code=502, detail=f"Kraken Data Error: {e.response.status_code}")
        except StopIteration:
            logger.error(f"Kraken parsing error: No OHLC list found in {data}")
            raise HTTPException(status_code=500, detail="Invalid Data Structure from Kraken")
        except Exception as e:
            logger.error(f"Fetch failed: {e}")
            raise HTTPException(status_code=500, detail="Internal Data Fetch Error")

def calculate_bands_logic(closes: List[float], period: int = 20):
    """Numpy calculation for Z-Score Bands."""
    if len(closes) < period:
        return None
        
    series = pd.Series(closes)
    sma = series.rolling(window=period).mean()
    std = series.rolling(window=period).std()
    
    upper1 = sma + std
    lower1 = sma - std
    upper2 = sma + (std * 2)
    lower2 = sma - (std * 2)
    
    return {
        "upper_1": upper1.iloc[-1],
        "lower_1": lower1.iloc[-1],
        "upper_2": upper2.iloc[-1],
        "lower_2": lower2.iloc[-1],
        "sma": sma.iloc[-1],
        "std": std.iloc[-1]
    }

# --- 24/7 KEEPER LOOP ---
async def self_ping():
    port = int(os.getenv("PORT", 8000))
    url = f"http://127.0.0.1:{port}/health"
    while True:
        await asyncio.sleep(60 * 14)
        try:
            async with httpx.AsyncClient() as client:
                await client.get(url, timeout=5.0)
                logger.info("💓 Self-Ping: Maintained active state")
        except Exception:
            pass

# --- FASTAPI APP ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    state["start_time"] = time.time()
    logger.info("🚀 Quant Desk Backend Starting (Kraken Integrated)...")
    asyncio.create_task(self_ping())
    yield
    logger.info("🛑 Shutting down...")

app = FastAPI(lifespan=lifespan)

origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://quantdesk.netlify.app",
    "https://www.quantdesk.netlify.app",
    FRONTEND_URL
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- ENDPOINTS ---

@app.get("/")
def root():
    return {"status": "online", "service": "Quant Desk API (Kraken)"}

@app.get("/health")
def health_check():
    return {"status": "operational", "version": "2.6.0"}

@app.get("/admin/system-status")
def system_status():
    process = psutil.Process(os.getpid())
    uptime_seconds = time.time() - state["start_time"]
    return {
        "status": "ONLINE",
        "uptime": str(timedelta(seconds=int(uptime_seconds))),
        "cpu_percent": psutil.cpu_percent(),
        "memory_mb": process.memory_info().rss / 1024 / 1024,
        "threads": process.num_threads(),
        "autonomous_active": state["autonomous_active"],
        "logs": list(log_buffer)
    }

@app.get("/history")
async def get_history(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 300):
    """
    Get historical candles from Kraken.
    """
    data = await fetch_kraken_candles(symbol, interval, limit)
    return data

@app.get("/bands")
async def get_bands(symbol: str = "BTCUSDT"):
    """
    Calculates dynamic Z-Score bands based on Kraken data.
    """
    # Fetch wider context (1h granularity)
    raw_data = await fetch_kraken_candles(symbol, "1h", 50)
    
    if not raw_data:
        raise HTTPException(status_code=404, detail="No data found")
    
    # Raw data format is [time, o, h, l, c, v]
    closes = [float(x[4]) for x in raw_data]
    bands = calculate_bands_logic(closes, 20)
    
    if not bands:
        raise HTTPException(status_code=400, detail="Insufficient data for calculation")
        
    return {
        "symbol": symbol,
        "period": "20H",
        **bands
    }

@app.get("/analyze")
async def analyze_market(symbol: str = "BTCUSDT", model: str = "gemini-3-flash-preview"):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="AI Service Config Missing")

    # Use 15m candles
    klines = await fetch_kraken_candles(symbol, "15m", 30)
    
    prices_str = "\n".join([
        f"Time: {datetime.fromtimestamp(x[0]/1000).strftime('%H:%M')} | O:{x[1]} H:{x[2]} L:{x[3]} C:{x[4]} V:{x[5]}"
        for x in klines
    ])
    
    prompt = f"""
    Act as a High-Frequency Trading Algorithm. Analyze this OHLCV data for {symbol} (15m timeframe).
    
    DATA:
    {prices_str}
    
    TASK:
    1. Identify key Support and Resistance levels.
    2. Determine a "Decision Price" (Pivot).
    3. Issue a Verdict: ENTRY (Long/Short), EXIT, or WAIT.
    4. Provide confidence (0.0 - 1.0).
    5. Calculate Risk:Reward ratio.

    OUTPUT JSON ONLY:
    {{
      "support": [number, number],
      "resistance": [number, number],
      "decision_price": number,
      "verdict": "string",
      "confidence": number,
      "analysis": "string (max 20 words)",
      "risk_reward_ratio": number,
      "entry_price": number,
      "stop_loss": number,
      "take_profit": number
    }}
    """

    try:
        gen_model = genai.GenerativeModel(model)
        response = await gen_model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception as e:
        logger.error(f"AI Analysis failed: {e}")
        current_price = float(klines[-1][4])
        return {
            "support": [current_price * 0.98],
            "resistance": [current_price * 1.02],
            "decision_price": current_price,
            "verdict": "WAIT",
            "confidence": 0.5,
            "analysis": "AI Service unavailable. Holding neutral.",
            "risk_reward_ratio": 1.0,
            "is_simulated": True
        }

@app.post("/analyze/flow")
async def analyze_order_flow(req: AnalysisRequest):
    if not GEMINI_API_KEY:
        return {"verdict": "NEUTRAL", "explanation": "AI Disabled", "confidence": 0}

    prompt = f"""
    Analyze the Order Flow for {req.symbol}.
    Price: {req.price}
    Net Delta: {req.netDelta}
    Total Volume: {req.totalVolume}
    Point of Control (POC): {req.pocPrice}
    CVD Trend: {req.cvdTrend}
    
    JSON Output: {{ "verdict": "BULLISH"|"BEARISH"|"NEUTRAL", "confidence": 0.0-1.0, "explanation": "string", "flow_type": "ABSORPTION"|"INITIATIVE"|"EXHAUSTION" }}
    """
    
    try:
        model = genai.GenerativeModel("gemini-3-flash-preview")
        response = await model.generate_content_async(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception:
        return {"verdict": "NEUTRAL", "explanation": "Flow analysis failed", "confidence": 0, "flow_type": "UNKNOWN"}

@app.get("/market-intelligence")
async def get_market_intel(model: str = "gemini-3-flash-preview"):
    now = datetime.now().timestamp() * 1000
    cache = state["market_intel_cache"]
    if cache["data"] and (now - cache["timestamp"] < 600000):
        return cache["data"]

    articles = []
    if newsapi:
        try:
            response = newsapi.get_everything(q="bitcoin OR ethereum OR crypto", language="en", sort_by="publishedAt", page_size=5)
            articles = response.get('articles', [])
        except Exception:
            pass

    intelligence = {
        "main_narrative": "Consolidating market structure amidst quiet news cycle.",
        "whale_impact": "Medium",
        "ai_sentiment_score": 0.1
    }

    if GEMINI_API_KEY and articles:
        headlines = "\n".join([f"- {a['title']}" for a in articles])
        prompt = f"""
        Read these headlines:
        {headlines}
        Output JSON: {{ "main_narrative": "...", "whale_impact": "...", "ai_sentiment_score": 0.0 }}
        """
        try:
            gen_model = genai.GenerativeModel(model)
            resp = await gen_model.generate_content_async(prompt)
            text = resp.text.replace('```json', '').replace('```', '').strip()
            intelligence = json.loads(text)
        except Exception:
            pass

    result = {
        "articles": articles,
        "intelligence": intelligence,
        "timestamp": now
    }
    state["market_intel_cache"] = {"data": result, "timestamp": now}
    return result

@app.get("/alerts/status")
def get_alert_status():
    return {"autonomous_active": state["autonomous_active"], "config": state["alert_config"]}

@app.post("/alerts/configure")
async def configure_alerts(config: dict):
    state["alert_config"].update({
        "symbol": config.get("symbol", "BTCUSDT"),
        "bot_token": config.get("telegram_bot_token"),
        "chat_id": config.get("telegram_chat_id")
    })
    state["autonomous_active"] = True
    return {"status": "configured", "mode": "autonomous"}

@app.post("/alerts/evaluate")
async def evaluate_alert(snapshot: AlertSnapshot):
    should_alert = False
    reasons = []

    if abs(snapshot.zScore) > 2.0:
        reasons.append(f"Z-Score Dislocation ({snapshot.zScore})")
    
    if snapshot.tacticalProbability > 75:
        reasons.append(f"AI Tactical High Prob ({snapshot.tacticalProbability}%)")
        should_alert = True
    
    if snapshot.sweeps and len(snapshot.sweeps) > 0:
        if snapshot.sweeps[0]['side'] == 'SELL' and snapshot.tacticalProbability > 60:
             reasons.append("Liquidity Sweep (Long)")
             should_alert = True

    return {
        "shouldAlert": should_alert,
        "passedConditions": reasons,
        "score": len(reasons),
        "aiAnalysis": {
            "direction": "LONG" if snapshot.aiScore > 0 else "SHORT",
            "confidence": snapshot.aiScore,
            "entry": snapshot.price,
            "stop": snapshot.price * 0.99, 
            "target": snapshot.price * 1.02,
            "reasoning": " & ".join(reasons) if reasons else "Monitoring"
        }
    }

@app.post("/alerts/send-telegram")
async def send_telegram(payload: TelegramPayload):
    token = payload.botToken or state["alert_config"]["bot_token"]
    chat_id = payload.chatId or state["alert_config"]["chat_id"]

    if not token or not chat_id:
        raise HTTPException(status_code=400, detail="Telegram credentials missing")

    message = f"🚨 **QUANT DESK ALERT: {payload.symbol}**\n\n**Dir:** {payload.direction} ({int(payload.confidence * 100)}%)\n**Price:** {payload.entry}\n**Logic:** {payload.reasoning}"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient() as client:
        try:
            await client.post(url, json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"})
            return {"success": True}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@app.post("/alerts/test")
async def test_alert(payload: TelegramPayload):
    return await send_telegram(payload)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
