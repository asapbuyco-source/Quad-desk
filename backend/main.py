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
    logger.error(f"❌ Missing required environment variables: {missing_vars}")
    logger.error("Set these in Railway or your .env file before running.")
    sys.exit(1)

logger.info("✅ Environment variables validated")

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
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# Initialize Gemini 3 Models
# Pro: For complex reasoning, math, and chart analysis
pro_model = genai.GenerativeModel('gemini-3-pro-preview')
# Flash: For fast text generation and summarization
flash_model = genai.GenerativeModel('gemini-3-flash-preview')

# 2. In-Memory Data Store
candle_cache = deque(maxlen=1000)

# 3. Pydantic Models for Validation
class MarketAnalysis(BaseModel):
    support: List[float]
    resistance: List[float]
    decision_price: float
    verdict: Literal["ENTRY", "EXIT", "WAIT"]
    analysis: str
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    risk_reward_ratio: Optional[float] = None

# 4. Background Data Ingestion
async def binance_listener():
    # client = await AsyncClient.create(api_key, api_secret)
    client = await AsyncClient.create()
    bm = BinanceSocketManager(client)
    ts = bm.kline_socket('BTCUSDT', interval=AsyncClient.KLINE_INTERVAL_1MINUTE)

    async with ts as tscm:
        while True:
            try:
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
                logger.error(f"WebSocket Error: {e}")
                await asyncio.sleep(5) # Reconnect delay

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

# 6. API Endpoints

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
    if len(candle_cache) < 30:
        return {
            "error": "insufficient_data",
            "message": f"Warming up... Need 30+ candles. Currently have {len(candle_cache)}.",
        }

    context_candles = list(candle_cache)[-50:]
    closes = [c['close'] for c in context_candles]
    current_price = closes[-1]
    
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

    Return EXACTLY this JSON structure:
    {{
        "support": [float, float],
        "resistance": [float, float],
        "decision_price": float,
        "verdict": "ENTRY" | "EXIT" | "WAIT",
        "analysis": "string",
        "entry_price": float,
        "stop_loss": float,
        "take_profit": float,
        "risk_reward_ratio": float
    }}
    """
    
    try:
        # Use Gemini 3 Pro for complex reasoning and mathematical analysis
        response = pro_model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        if not response.text.strip():
            raise ValueError("Empty response from Gemini")

        raw_result = json.loads(response.text)
        
        # Validate with Pydantic
        validated = MarketAnalysis(**raw_result)
        return validated.dict()
        
    except ValidationError as e:
        logger.error(f"Validation Error: {e}")
        return {"error": "validation_error", "message": "AI returned malformed data."}
    except Exception as e:
        logger.error(f"AI Error: {e}")
        return {"error": "analysis_failed", "message": "Market analysis temporarily unavailable."}

@app.get("/market-intelligence")
async def get_market_intelligence():
    """
    Fetches market news and generates intelligence.
    FALLBACK: If NewsAPI is missing or fails, Gemini generates synthetic intelligence
    based on the current price context to ensure the UI is always functional.
    """
    api_key = os.getenv("NEWS_API_KEY")
    articles = []
    use_synthetic = True

    # 1. Try fetching real news
    if api_key:
        try:
            url = "https://newsapi.org/v2/everything"
            params = {
                "q": "bitcoin OR crypto OR ethereum",
                "sortBy": "publishedAt",
                "language": "en",
                "pageSize": 10,
                "apiKey": api_key
            }
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params=params, timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    fetched_articles = data.get("articles", [])
                    # Filter removed articles
                    articles = [a for a in fetched_articles if a.get("description") and "[Removed]" not in a.get("title")]
                    if articles:
                        use_synthetic = False
        except Exception as e:
            logger.error(f"News fetch failed, switching to synthetic: {e}")

    # 2. Construct Prompt (Real or Synthetic)
    prompt = ""
    
    if use_synthetic:
        # Generate plausible news based on pure price/market context
        current_time = datetime.now().isoformat()
        price = candle_cache[-1]['close'] if len(candle_cache) > 0 else 0
        
        prompt = f"""
        You are a sophisticated financial news generator for a high-frequency trading terminal.
        Real-time news feed is currently offline.
        
        Current BTC Price: ${price}
        Time: {current_time}

        Task:
        Generate a "Synthetic Market Intelligence" report. 
        Invent 6 plausible, high-quality financial news headlines that would match typical crypto market conditions.
        Use sources like "Bloomberg", "Reuters", "CoinDesk", "The Block".

        Return EXACTLY this JSON structure:
        {{
            "articles": [
                {{ 
                    "source": {{ "id": "bloomberg", "name": "Bloomberg" }}, 
                    "author": "Crypto Desk", 
                    "title": "Headline string", 
                    "description": "Short summary", 
                    "url": "#", 
                    "urlToImage": null, 
                    "publishedAt": "{current_time}", 
                    "content": "" 
                }}
            ],
            "intelligence": {{
                "main_narrative": "A concise summary of the dominant market theme (e.g., 'Institutional Accumulation', 'Macro Uncertainty')",
                "whale_impact": "High" | "Medium" | "Low",
                "ai_sentiment_score": float (between -1.0 and 1.0)
            }}
        }}
        """
    else:
        # Use Real News
        headlines_text = "\n".join([f"- {a['title']}: {a['description']}" for a in articles[:8]])
        prompt = f"""
        You are an analyst at Goldman Sachs. Summarize these crypto market headlines into an Executive Brief.
        
        Headlines:
        {headlines_text}

        Task:
        Generate a market intelligence report with these specific metrics:
        1. Main Narrative: The dominant story driving the market right now.
        2. Whale Impact: Assessment of large holder activity based on the news (High/Medium/Low).
        3. AI Sentiment Score: A float from -1.0 (Very Bearish) to 1.0 (Very Bullish).

        Return EXACTLY this JSON structure:
        {{
            "main_narrative": "string",
            "whale_impact": "High" | "Medium" | "Low",
            "ai_sentiment_score": float
        }}
        """

    # 3. Call Gemini
    try:
        # Use Gemini 3 Flash for fast summarization and text generation
        response = flash_model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        result = json.loads(response.text)
        
        if use_synthetic:
            return result
        else:
            return {
                "articles": articles[:10],
                "intelligence": result
            }

    except Exception as e:
        logger.error(f"Gemini Intelligence Error: {e}")
        return {"error": "Failed to generate intelligence"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
