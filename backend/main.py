import os
import sys
import json
import asyncio
import numpy as np
import httpx
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai
from dotenv import load_dotenv
from pydantic import BaseModel
from typing import List, Literal, Optional
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
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyAm0ClHA2jRLk53m53GVwqVQHBcFDr4EEY")
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "ddd54f78ffa8407597d9cfb6d4f72027")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8510816299:AAH2m3XKfQCMiH7ceXjlwZaoiMT5JQ94rN8")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "8078378739")
# Binance keys (Optional for public data, but good to have ready)
BINANCE_API_KEY = os.getenv("BINANCE_API_KEY", "hWXChMsrNZ7UsjYCHvbYqIIs2wZ1qWbZGVfCv2vLp6DXBBGmsVzu241uavuGtYMY")
BINANCE_API_SECRET = os.getenv("BINANCE_API_SECRET", "H6VGtEcVfqXF9eD9ACIbG2fJI6rmStlHdjkp8xSSgohfUKJZHdRaqRRFFx0Z4P2z")

# Initialize AI Client
if GEMINI_API_KEY:
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        # Initialize models
        # Using gemini-1.5-pro for analysis and 1.5-flash for speed/news
        model_pro = genai.GenerativeModel('gemini-1.5-pro-latest')
        model_flash = genai.GenerativeModel('gemini-1.5-flash-latest')
        logger.info("✅ Google Gemini initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Google Gemini: {e}")
        model_pro = None
        model_flash = None
else:
    logger.error("❌ GEMINI_API_KEY not set! AI features will not work.")
    model_pro = None
    model_flash = None

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

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 5. Helper Functions
async def fetch_binance_candles(symbol: str, limit: int = 50):
    """
    Fetches recent kline data from Binance REST API.
    """
    # Standardize symbol format
    clean_symbol = symbol.replace("/", "").upper()
    url = f"https://api.binance.com/api/v3/klines"
    params = {
        "symbol": clean_symbol,
        "interval": "1m",
        "limit": limit
    }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
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
            logger.error(f"Binance Fetch Error for {clean_symbol}: {e}")
            return []

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

async def send_telegram_alert(symbol: str, analysis: MarketAnalysis):
    """
    Sends a high-priority alert to Telegram if configured.
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

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "gemini_available": model_pro is not None,
        "telegram_configured": bool(TELEGRAM_BOT_TOKEN),
        "timestamp": datetime.now().isoformat()
    }

@app.get("/history")
async def proxy_history(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 1000):
    """
    Proxies historical data fetching to avoid CORS issues on the frontend
    """
    clean_symbol = symbol.replace("/", "").upper()
    url = f"https://api.binance.com/api/v3/klines?symbol={clean_symbol}&interval={interval}&limit={limit}"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url)
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to fetch history: {e}")
            return {"error": "Failed to fetch upstream data"}

@app.get("/bands")
async def get_volatility_bands(symbol: str = Query("BTCUSDT", min_length=3)):
    candles = await fetch_binance_candles(symbol, limit=50)
    if len(candles) < 20:
        return {"error": "Not enough data"}
    
    bands = calculate_z_score_bands(candles)
    return bands

@app.get("/analyze")
async def analyze_market(background_tasks: BackgroundTasks, symbol: str = Query("BTCUSDT", min_length=3)):
    # Fetch fresh data on demand
    context_candles = await fetch_binance_candles(symbol, limit=30)
    
    if len(context_candles) > 0:
        current_price = context_candles[-1]['close']
    else:
        current_price = 0.0

    try:
        if not model_pro:
            raise Exception("Gemini Not Initialized")

        if len(context_candles) < 20:
            raise Exception("Insufficient Data")

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
        
        response = await model_pro.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text:
             raise Exception("Empty response from AI")

        raw_result = json.loads(response.text)
        validated = MarketAnalysis(**raw_result)
        
        # Trigger Telegram Alert in background
        background_tasks.add_task(send_telegram_alert, symbol, validated)
        
        return validated.dict()
        
    except Exception as e:
        logger.error(f"AI Analysis Error: {e}")
        # Fallback Simulation
        is_bullish = np.random.random() > 0.5
        base_price = current_price if current_price > 0 else 64000
        
        return {
            "support": [base_price * 0.98, base_price * 0.96],
            "resistance": [base_price * 1.02, base_price * 1.04],
            "decision_price": base_price * (0.99 if is_bullish else 1.01),
            "verdict": "ENTRY" if is_bullish else "WAIT",
            "confidence": 0.85,
            "analysis": f"[SIMULATION] AI Connection Issue. Analyzed {symbol} locally.",
            "risk_reward_ratio": 2.5,
            "is_simulated": True
        }

@app.get("/market-intelligence")
async def get_market_intelligence():
    current_time = datetime.now().isoformat()
    try:
        if not model_flash:
            raise Exception("Gemini Not Initialized")

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

        response = await model_flash.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text:
             raise Exception("Empty response from AI")

        result = json.loads(response.text)
        
        # If we had real articles, merge them into the result structure
        if real_articles:
            result['articles'] = real_articles

        result['is_simulated'] = False
        return result

    except Exception as e:
        logger.error(f"Gemini Intelligence Error: {e}")
        return {
            "articles": [],
            "intelligence": {
                "main_narrative": "SIMULATION MODE: AI Uplink Interrupted.",
                "whale_impact": "Low",
                "ai_sentiment_score": 0.0
            },
            "is_simulated": True
        }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)