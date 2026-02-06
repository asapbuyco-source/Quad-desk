import os
import json
import asyncio
import numpy as np
import pandas as pd
import httpx
from collections import deque
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from binance import AsyncClient, BinanceSocketManager
import google.generativeai as genai
from dotenv import load_dotenv

# 1. Setup & Configuration
load_dotenv()
app = FastAPI()

# Enable CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# AI Configuration
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
# Using Gemini 1.5 Flash for speed and JSON capabilities
model = genai.GenerativeModel('gemini-1.5-flash')

# 2. In-Memory Data Store
# Increased cache size for better context
candle_cache = deque(maxlen=1000)

# 4. Background Data Ingestion
async def binance_listener():
    api_key = os.getenv("BINANCE_API_KEY")
    api_secret = os.getenv("BINANCE_API_SECRET")
    
    # client = await AsyncClient.create(api_key, api_secret)
    # Using public client creation often works better without keys for public streams if keys aren't set
    client = await AsyncClient.create()
    bm = BinanceSocketManager(client)
    # Stream BTCUSDT 1 minute klines
    ts = bm.kline_socket('BTCUSDT', interval=AsyncClient.KLINE_INTERVAL_1MINUTE)

    async with ts as tscm:
        while True:
            res = await tscm.recv()
            if res:
                k = res['k']
                # Append data: [time, open, high, low, close, volume]
                # Note: Binance timestamps are ms
                candle = {
                    'time': k['t'],
                    'open': float(k['o']),
                    'high': float(k['h']),
                    'low': float(k['l']),
                    'close': float(k['c']),
                    'volume': float(k['v'])
                }
                
                # Check if this timestamp already exists to update it (candle update), or append new
                if len(candle_cache) > 0 and candle_cache[-1]['time'] == candle['time']:
                    candle_cache[-1] = candle
                else:
                    candle_cache.append(candle)

@app.on_event("startup")
async def startup_event():
    # Start the websocket listener in the background
    asyncio.create_task(binance_listener())

# 5. API Endpoints
@app.get("/analyze")
async def analyze_market():
    if len(candle_cache) < 50:
        return {"error": "Not enough data yet, warming up..."}

    # Get last 100 candles for context
    context_candles = list(candle_cache)[-100:]
    
    # Calculate simple stats for the prompt
    closes = [c['close'] for c in context_candles]
    current_price = closes[-1]
    
    prompt = f"""
    You are a Quant Analyst. Analyze these {len(context_candles)} candlestick data points for BTC/USDT.
    Current Price: {current_price}
    
    Candle Data (JSON format):
    {json.dumps(context_candles[-30:])} 
    (Last 30 shown for brevity, but assume trend context from last 100)

    Task:
    1. Identify key Support and Resistance levels based on recent swing highs/lows.
    2. determine a "Decision Price" (pivot point).
    3. Provide a Verdict (ENTRY, EXIT, or WAIT).
    4. Provide a short 1-sentence analysis.

    Return EXACTLY this JSON structure:
    {{
        "support": [float, float],
        "resistance": [float, float],
        "decision_price": float,
        "verdict": "ENTRY" | "EXIT" | "WAIT",
        "analysis": "string"
    }}
    """
    
    try:
        response = model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        
        # Parse the JSON response
        result = json.loads(response.text)
        return result
        
    except Exception as e:
        print(f"AI Error: {e}")
        return {"error": str(e)}

@app.get("/market-intelligence")
async def get_market_intelligence():
    # 1. Fetch News from NewsAPI
    api_key = os.getenv("NEWS_API_KEY")
    if not api_key:
         return {"error": "NEWS_API_KEY not configured"}

    url = "https://newsapi.org/v2/everything"
    params = {
        "q": "bitcoin OR crypto OR ethereum",
        "sortBy": "publishedAt",
        "language": "en",
        "pageSize": 12, # Fetch a few extra to filter
        "apiKey": api_key
    }
    
    articles = []
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            if data.get("status") == "ok":
                articles = data.get("articles", [])
            else:
                print(f"NewsAPI Error: {data}")
    except Exception as e:
        print(f"News Fetch Error: {e}")
        return {"error": "Failed to fetch news"}

    if not articles:
        return {"error": "No articles found"}

    # 2. Prepare Context for Gemini
    # Filter out articles with no description or removed content
    valid_articles = [a for a in articles if a.get("description") and "[Removed]" not in a.get("title")]
    top_articles = valid_articles[:10]
    
    headlines_text = "\n".join([f"- {a['title']}: {a['description']}" for a in top_articles])
    
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
    ai_summary = {}
    try:
        response = model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        ai_summary = json.loads(response.text)
    except Exception as e:
        print(f"Gemini Error: {e}")
        ai_summary = {
            "main_narrative": "Market analysis temporarily unavailable.",
            "whale_impact": "Unknown",
            "ai_sentiment_score": 0
        }

    return {
        "articles": top_articles,
        "intelligence": ai_summary
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
