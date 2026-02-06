import os
import json
import asyncio
import numpy as np
import pandas as pd
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
# Ensure GEMINI_API_KEY is set in your environment or .env file
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
model = genai.GenerativeModel('gemini-pro')

# 2. In-Memory Data Store
# We store the last 50 candles to calculate rolling metrics
# Format: [timestamp, open, high, low, close, volume]
candle_cache = deque(maxlen=50)

# 3. Quant Engine Functions
def calculate_metrics(df):
    if len(df) < 20:
        return None, None

    # Calculate Z-Score (20 period)
    df['close'] = pd.to_numeric(df['close'])
    df['volume'] = pd.to_numeric(df['volume'])
    
    rolling_mean = df['close'].rolling(window=20).mean()
    rolling_std = df['close'].rolling(window=20).std()
    
    # Get last Z-Score
    last_close = df['close'].iloc[-1]
    last_mean = rolling_mean.iloc[-1]
    last_std = rolling_std.iloc[-1]
    
    z_score = (last_close - last_mean) / last_std if last_std != 0 else 0

    # Calculate VPIN Approximation (Volume-Synchronized Probability of Informed Trading)
    # Since we only have 1m candles, we estimate buy/sell volume delta
    # If Close > Open, we treat volume as Buy-dominant, else Sell-dominant
    df['price_change'] = df['close'] - df['open']
    df['buy_vol'] = np.where(df['price_change'] > 0, df['volume'], 0)
    df['sell_vol'] = np.where(df['price_change'] < 0, df['volume'], 0)
    
    # VPIN proxy: Absolute Order Imbalance / Total Volume over window
    rolling_buy = df['buy_vol'].rolling(window=20).sum()
    rolling_sell = df['sell_vol'].rolling(window=20).sum()
    total_vol = rolling_buy + rolling_sell
    
    # Calculate Order Imbalance
    oi = np.abs(rolling_buy - rolling_sell)
    # Get the last valid VPIN value
    vpin = (oi / total_vol).iloc[-1] if total_vol.iloc[-1] != 0 else 0

    return z_score, vpin

# 4. Background Data Ingestion
async def binance_listener():
    # Public client - no keys needed for public streams usually, 
    # but python-binance AsyncClient requires them for init if strictly following docs, 
    # passing None/None works for public endpoints often, but let's be safe.
    api_key = os.getenv("BINANCE_API_KEY")
    api_secret = os.getenv("BINANCE_API_SECRET")
    
    client = await AsyncClient.create(api_key, api_secret)
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
    if len(candle_cache) < 20:
        return {"status": "warming_up", "count": len(candle_cache)}

    df = pd.DataFrame(candle_cache)
    z_score, vpin = calculate_metrics(df)
    
    # Prepare payload for AI
    # LEVEL 3 UPGRADE: Increased context window (30 candles) for better hybrid context analysis
    context_candles = list(candle_cache)[-30:]
    
    prompt = f"""
    You are an institutional execution trader. Analyze this market data for BTC/USDT.
    
    Technical Metrics:
    - Z-Score (20 period): {z_score:.4f} (High > 2.0 Overbought, Low < -2.0 Oversold)
    - VPIN (Whale Activity Proxy): {vpin:.4f} (High values > 0.3 indicate informed trading/whales)
    
    Recent Price Action (Last 30 candles):
    {context_candles}
    
    Task: Return a valid JSON object.
    1. Identify if there is a high-probability setup.
    2. STRICT RULE: Only output 'BUY' or 'SELL' if the Risk/Reward ratio is at least 1:3. Otherwise 'WAIT'.
    3. Define Entry, Stop Loss, and Take Profit levels that satisfy the 1:3 R:R.
    
    Format:
    {{
        "signal": "BUY" | "SELL" | "WAIT",
        "confidence": <float between 0.0 and 1.0>,
        "entry": <float price>,
        "stop_loss": <float price>,
        "take_profit": <float price>,
        "reason": "<short explanation, max 15 words>"
    }}
    """
    
    try:
        response = model.generate_content(prompt)
        # Clean response string to ensure JSON parsing
        clean_text = response.text.replace('```json', '').replace('```', '').strip()
        analysis = json.loads(clean_text)
        
        return {
            "metrics": {
                "z_score": z_score,
                "vpin": vpin
            },
            "ai_analysis": analysis
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
