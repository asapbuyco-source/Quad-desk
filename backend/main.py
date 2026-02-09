import os
import sys
import json
import asyncio
import numpy as np
import httpx
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query
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

# AI Configuration
api_key = os.getenv("GEMINI_API_KEY")
pro_model = None
flash_model = None

if not api_key:
    logger.error("❌ GEMINI_API_KEY not set! AI features will not work.")
    pro_model = None
    flash_model = None
else:
    genai.configure(api_key=api_key)
    try:
        # Use actual available models
        pro_model = genai.GenerativeModel('gemini-1.5-pro-latest')
        flash_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        logger.info("✅ Gemini models initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Gemini: {e}")
        pro_model = None
        flash_model = None

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
    url = f"https://api.binance.com/api/v3/klines"
    params = {
        "symbol": symbol,
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
            logger.error(f"Binance Fetch Error for {symbol}: {e}")
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

# 6. API Endpoints

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "gemini_available": pro_model is not None,
        "timestamp": datetime.now().isoformat()
    }

@app.get("/history")
async def proxy_history(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 1000):
    """
    Proxies historical data fetching to avoid CORS issues on the frontend
    """
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}"
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
async def analyze_market(symbol: str = Query("BTCUSDT", min_length=3)):
    # Fetch fresh data on demand
    context_candles = await fetch_binance_candles(symbol, limit=30)
    
    if len(context_candles) > 0:
        current_price = context_candles[-1]['close']
    else:
        # Fallback if fetch fails
        current_price = 0.0

    try:
        if not pro_model:
            raise Exception("Gemini API Key missing")

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
        """
        
        response = await pro_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        raw_result = json.loads(response.text)
        validated = MarketAnalysis(**raw_result)
        return validated.dict()
        
    except Exception as e:
        logger.error(f"AI Analysis Error: {e}")
        # Fallback Simulation
        is_bullish = np.random.random() > 0.5
        # Prevent zero division if price is 0
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
        if not flash_model:
            raise Exception("Gemini API Key missing")

        prompt = f"""
        Generate a 'Market Intelligence' JSON object for Crypto Markets at {current_time}.
        Include:
        1. 'articles': 5 realistic fake news headlines (Bloomberg, Reuters style).
        2. 'intelligence': {{ main_narrative, whale_impact (High/Med/Low), ai_sentiment_score (-1 to 1) }}
        """

        response = await flash_model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        result = json.loads(response.text)
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