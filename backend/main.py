import os
import logging
import asyncio
import json
import re
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
WHALE_ALERT_API_KEY = os.getenv("WHALE_ALERT_API_KEY")
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

VALID_GEMINI_MODELS = {
    "gemini-2.0-flash",
    "gemini-2.0-flash-thinking-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-2.5-pro-preview-03-25",
}
DEFAULT_MODEL = "gemini-2.0-flash"

def _safe_model(name: str) -> str:
    """Return a validated model name, falling back to default."""
    return name if name in VALID_GEMINI_MODELS else DEFAULT_MODEL

class AnalysisRequest(BaseModel):
    symbol: str
    price: float
    netDelta: float
    totalVolume: float
    pocPrice: float
    cvdTrend: str
    candleCount: int
    model: str = DEFAULT_MODEL

class MacroStrategyRequest(BaseModel):
    symbol: str
    price: float
    skewness: float
    bayesianPosterior: float
    zScore: float
    rsi: float
    ofi: float
    cvd: float
    tapeSpeed: str
    tapeDominant: str
    wallContext: str
    allWalls: str = ""  # All detected walls, not just nearest
    model: str = DEFAULT_MODEL

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
async def analyze_market(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), model: str = DEFAULT_MODEL):
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
            "verdict": "WAIT", "confidence": 0.1, "analysis": "Mathematical Pivot Analysis (AI Offline).",
            "risk_reward_ratio": 2.0, "entry_price": current_price, "stop_loss": s1, "take_profit": r1,
            "is_simulated": True
        }

    prices_str = "\n".join([f"T:{x[0]} O:{x[1]} H:{x[2]} L:{x[3]} C:{x[4]}" for x in klines])
    prompt = f"HFT Algo: Analyze OHLCV for {symbol}.\n{prices_str}\nOutput JSON: {{support:[num], resistance:[num], decision_price:num, verdict:ENTRY|EXIT|WAIT, confidence:0-1, analysis:str, risk_reward_ratio:num}}"

    try:
        gen_model = genai.GenerativeModel(model)
        response = await gen_model.generate_content_async(prompt)
        match = re.search(r'\{.*\}', response.text.replace('\n', ' '), re.DOTALL)
        if match:
            text = match.group(0)
        else:
            text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception:
        return {
            "support": [s1], "resistance": [r1], "decision_price": pivot,
            "verdict": "WAIT", "confidence": 0.1, "analysis": "Degraded Mode: Pivot Logic Applied.",
            "is_simulated": True
        }

@app.post("/analyze/flow")
async def analyze_order_flow(req: AnalysisRequest):
    if not GEMINI_API_KEY:
        return {"verdict": "NEUTRAL", "explanation": "Statistical baseline maintained.", "confidence": 0.1, "flow_type": "NEUTRAL", "is_simulated": True}
    prompt = f"Analyze Flow for {req.symbol}: Price:{req.price} NetDelta:{req.netDelta} Vol:{req.totalVolume} POC:{req.pocPrice} CVD:{req.cvdTrend}. JSON Output: {{verdict:BULLISH|BEARISH|NEUTRAL, confidence:num, explanation:str, flow_type:str}}"
    try:
        model = genai.GenerativeModel(_safe_model(req.model))
        response = await model.generate_content_async(prompt)
        match = re.search(r'\{.*\}', response.text.replace('\n', ' '), re.DOTALL)
        if match:
            text = match.group(0)
        else:
            text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception:
        return {"verdict": "NEUTRAL", "explanation": "Synthesis failed.", "confidence": 0, "is_simulated": True}

@app.post("/analyze/strategy")
async def analyze_strategy(req: MacroStrategyRequest):
    if not GEMINI_API_KEY:
        return {"verdict": "NEUTRAL", "analysis": "Degraded Mode: Hardware rules override enabled.", "confidence": 0.1, "is_simulated": True}
    
    # FIX #4: Pre-classify RSI into strategy-aligned states
    if req.rsi < 30:
        rsi_state = "Capitulation (< 30) — Prepare for High Velocity Reversal"
    elif req.rsi > 70:
        rsi_state = "Capitulation (> 70) — Prepare for High Velocity Reversal (Overbought)"
    elif 55 <= req.rsi <= 70:
        rsi_state = "Building (55-70) — Bullish Trend"
    elif 40 <= req.rsi < 50:
        rsi_state = "Reset (40-50) — Sideways / Distribution"
    elif 30 <= req.rsi < 40:
        rsi_state = "Oversold Recovery (30-40) — Potential Bullish Reversal Setup"
    else:
        rsi_state = "Neutral (50-55)"

    # FIX #3 (backend): Z-Score state label
    if req.zScore >= 2.5:
        z_state = "Sentiment Wash (> +2.5) — Mean Reversal Expected SHORT"
    elif req.zScore <= -2.5:
        z_state = "Sentiment Wash (< -2.5) — Mean Reversal Expected LONG"
    elif req.zScore > 0.5:
        z_state = "Bullish Trend (+0.5 to +2.5)"
    elif req.zScore < -0.5:
        z_state = "Bearish Trend (-0.5 to -2.5)"
    else:
        z_state = "Neutral (-0.5 to +0.5)"

    # FIX #1 (backend): Bayesian Posterior display
    bayes_state = "Confirming Upside" if req.bayesianPosterior > 0.6 else \
                  "Confirming Downside" if req.bayesianPosterior < 0.4 else "Neutral"

    prompt = f"""
    Analyze Macro Statistical Filter Strategy for {req.symbol}.
    Current Market Data:
    Price: {req.price}
    Skewness (log-return): {req.skewness:.4f} — {'Downside tail risk' if req.skewness < 0 else 'Upside tail risk' if req.skewness > 0 else 'Neutral'}
    Bayesian Posterior P(Bull|Evidence): {req.bayesianPosterior:.3f} — {bayes_state}
    Z-Score (VWAP-anchored 20p): {req.zScore:.3f} — {z_state}
    RSI: {req.rsi:.1f} — {rsi_state}
    OFI (Order Flow Imbalance): {req.ofi:.1f} — {'Bullish Pressure' if req.ofi > 10 else 'Bearish Pressure' if req.ofi < -10 else 'Balanced'}
    CVD (Cumulative Delta): {req.cvd:.0f} — {'Aggressive Buyers Dominating' if req.cvd > 0 else 'Aggressive Sellers Dominating'}
    Tape Speed: {req.tapeSpeed} | Dominant Side: {req.tapeDominant}
    Nearest Wall Context: {req.wallContext}
    All Detected Walls: {req.allWalls if req.allWalls else 'None identified'}

    Strategy Rules to apply:
    1. Skewness: Negative = Downside tail risk, Positive = Upside tail risk, Zero = Neutral.
    2. Bayesian Posterior: 0-1 probability range. >0.6 = Confirm Upside, <0.4 = Confirm Downside, 0.4-0.6 = Neutral.
    3. Z-Score: +2.5 to +5 = Sentiment Wash (Mean Reversal), 0.5 to +1 = Bullish Trend, 0 to -1 = Bearish Trend, 0 to 0.5 & 0 to -0.5 = Neutral.
    4. LOB Wall: Price should be above buy wall for long, below sell wall for short. Buy/Sell walls define support/resistance.
    5. RSI: Capitulation = Prepare for High Velocity Reversal; Building = Bullish Trend; Reset = Sideways.
    6. OFI Trigger: First leading indicator. Positive jumps against resistance = Bullish Continuation Breakout. Positive during pullback = Re-accumulation. Positive during breakdown = Failed Breakout Trap (Go Long). Negative jumps against support = Bearish Continuation Breakdown. Negative during pullback = Distribution. Negative during rally = Trapped Buyers (Go Short).
    7. CVD: Positive Net = Aggressive Buyers dominate (Bullish). Negative Net = Aggressive Sellers dominate (Bearish). Zero cross = Shift in control. Divergence against price/walls = Iceberg activity.

    Output JSON rigidly structured: 
    {{"verdict":"BUY|SELL|WAIT|MEAN_REVERSAL", "confidence":0-1, "analysis":"str"}}
    """
    try:
        model = genai.GenerativeModel(_safe_model(req.model))
        response = await model.generate_content_async(prompt)
        match = re.search(r'\{.*\}', response.text.replace('\n', ' '), re.DOTALL)
        if match:
            text = match.group(0)
        else:
            text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception as e:
        logger.error(f"Strategy API fail: {e}")
        return {"verdict": "ERROR", "analysis": "Strategy Synthesis failed due to upstream error.", "confidence": 0, "is_simulated": True}

@app.get("/market-intelligence")
async def get_market_intel(model: str = DEFAULT_MODEL):
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
            match = re.search(r'\{.*\}', resp.text.replace('\n', ' '), re.DOTALL)
            if match:
                text = match.group(0)
            else:
                text = resp.text.replace('```json', '').replace('```', '').strip()
            intelligence = json.loads(text)
        except Exception: pass
    result = {"articles": articles, "intelligence": intelligence, "timestamp": now}
    state["market_intel_cache"] = {"data": result, "timestamp": now}
    return result

@app.get("/alerts/status")
async def alerts_status():
    """Called by AlertEngine.tsx every 60s to detect autonomous mode."""
    return {"autonomous_mode": state.get("autonomous_active", False)}


class AlertEvaluateRequest(BaseModel):
    symbol: str
    price: float
    zScore: float
    tacticalProbability: float
    aiScore: float
    model: str = DEFAULT_MODEL
    class Config:
        extra = "allow"


@app.post("/alerts/evaluate")
async def alerts_evaluate(req: AlertEvaluateRequest):
    """Evaluate whether conditions are met to fire an alert."""
    score = 0
    if abs(req.zScore) >= 2.0:
        score += 1
    if req.tacticalProbability >= 0.65:
        score += 1
    if req.aiScore >= 0.7:
        score += 1

    should_alert = score >= 3

    ai_analysis = None
    if should_alert and GEMINI_API_KEY:
        try:
            model = genai.GenerativeModel(_safe_model(req.model))
            prompt = (
                f"Trading Alert Analysis for {req.symbol} at price {req.price}.\n"
                f"Z-Score: {req.zScore:.3f}, AI Probability: {req.tacticalProbability:.2f}, AI Score: {req.aiScore:.2f}.\n"
                "Based on these signals determine the best trade setup.\n"
                'Output JSON: {"direction":"LONG|SHORT","confidence":0.0-1.0,"entry":num,"stop":num,"target":num,"reasoning":"str"}'
            )
            response = await model.generate_content_async(prompt)
            match = re.search(r'\{.*\}', response.text.replace('\n', ' '), re.DOTALL)
            if match:
                ai_analysis = json.loads(match.group(0))
        except Exception as e:
            logger.error(f"Alert AI analysis failed: {e}")

    return {
        "shouldAlert": should_alert,
        "score": score,
        "passedConditions": score,
        "aiAnalysis": ai_analysis
    }


@app.post("/alerts/send-telegram")
async def send_telegram_alert(payload: TelegramPayload):
    """Send a formatted trading alert via Telegram."""
    bot_token = payload.botToken or TELEGRAM_BOT_TOKEN
    chat_id = payload.chatId or TELEGRAM_CHAT_ID

    if not bot_token or not chat_id:
        raise HTTPException(status_code=400, detail="Telegram credentials not configured")

    emoji = "🟢" if payload.direction == "LONG" else "🔴"
    message = (
        f"{emoji} *QUAD-DESK ALERT — {payload.symbol}*\n"
        f"Direction: *{payload.direction}*\n"
        f"Confidence: {payload.confidence*100:.0f}%\n"
        f"Entry: `{payload.entry}`\n"
        f"Stop Loss: `{payload.stop}`\n"
        f"Take Profit: `{payload.target}`\n"
        f"R:R Ratio: `{abs(payload.target - payload.entry) / max(abs(payload.entry - payload.stop), 0.0001):.2f}`\n"
        f"📝 {payload.reasoning}"
    )

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(url, json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"}, timeout=10.0)
            resp.raise_for_status()
            logger.info(f"Telegram alert sent for {payload.symbol}")
            return {"success": True, "message_id": resp.json().get("result", {}).get("message_id")}
        except Exception as e:
            logger.error(f"Telegram send failed: {e}")
            raise HTTPException(status_code=502, detail=f"Telegram delivery failed: {str(e)}")


# ── Whale Alert cache (5-min TTL) ───────────────────────────────────────────
_whale_cache: Dict[str, Any] = {"data": None, "ts": 0}
WHALE_CACHE_TTL = 300  # seconds


@app.get("/whale-alerts")
async def get_whale_alerts(min_value: int = 10_000_000):
    """
    Proxy for the Whale Alert /v1/transactions endpoint.
    Returns normalised whale feed, block trades, inflow/outflow histogram,
    and a rolling 4-hour bias value (-1 to +1) — same shape as the frontend
    DarkPoolState expects.
    """
    # Serve cache if fresh
    if _whale_cache["data"] and (time.time() - _whale_cache["ts"]) < WHALE_CACHE_TTL:
        return _whale_cache["data"]

    if not WHALE_ALERT_API_KEY:
        logger.warning("WHALE_ALERT_API_KEY not set — returning empty dark pool response")
        return {
            "whaleFeed": [], "blockTrades": [], "inflowOutflow": [],
            "rawBias": 0.0, "isReal": False,
            "notice": "WHALE_ALERT_API_KEY not configured",
        }

    # Whale Alert only allows `start` up to 3600 s in the past on the free plan
    start_ts = int(time.time()) - 3600
    btc_price = 0  # will be updated from transaction data

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(
                "https://api.whale-alert.io/v1/transactions",
                params={
                    "api_key": WHALE_ALERT_API_KEY,
                    "limit": 100,
                    "start": start_ts,
                    "min_value": min_value,
                    "currency": "btc",  # BTC only
                },
            )
            resp.raise_for_status()
            raw = resp.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"Whale Alert HTTP error: {e.response.status_code} — {e.response.text}")
            return {
                "whaleFeed": [], "blockTrades": [], "inflowOutflow": [],
                "rawBias": 0.0, "isReal": False,
                "notice": f"Whale Alert API error {e.response.status_code}",
            }
        except Exception as e:
            logger.error(f"Whale Alert fetch failed: {e}")
            return {
                "whaleFeed": [], "blockTrades": [], "inflowOutflow": [],
                "rawBias": 0.0, "isReal": False,
                "notice": "Could not reach Whale Alert API",
            }

    transactions: list = raw.get("transactions", [])

    # ── Map to WhaleTransfer (whaleFeed) ────────────────────────────────
    whale_feed = []
    for tx in transactions:
        amount_usd = float(tx.get("amount_usd", 0))
        amount_coin = float(tx.get("amount", 0))
        if amount_coin > 0:
            derived_price = amount_usd / amount_coin
            if derived_price > 0:
                btc_price = derived_price  # keep latest price estimate

        to_ex = tx.get("to", {})
        from_ex = tx.get("from", {})
        to_exchange = to_ex.get("owner_type") == "exchange"
        from_label = from_ex.get("owner") or from_ex.get("owner_type") or "Unknown Wallet"
        to_label = to_ex.get("owner") or to_ex.get("owner_type") or "Unknown Wallet"

        whale_feed.append({
            "id": tx.get("hash", f"wh-{tx.get('id', '')}"),
            "timestamp": int(tx.get("timestamp", 0)) * 1000,  # → ms
            "amountBTC": amount_coin,
            "amountUSD": amount_usd,
            "fromLabel": from_label,
            "toLabel": to_label,
            "direction": "INFLOW" if to_exchange else "OUTFLOW",
            "exchangeFlag": to_exchange,
        })

    # ── Map to DarkPrint (blockTrades) — flag low-price-impact BTC txs ─
    DAILY_VOLUME_BTC = 25000
    block_trades = []
    for tx in transactions:
        amount_coin = float(tx.get("amount", 0))
        if amount_coin < 100:
            continue  # ignore small ones
        price_impact = 0.003  # Whale Alert doesn't provide this; use conservative estimate
        is_significant = amount_coin / DAILY_VOLUME_BTC >= 0.005
        to_ex_type = tx.get("to", {}).get("owner_type", "")
        side = "BUY" if to_ex_type == "exchange" else "SELL"
        block_trades.append({
            "id": tx.get("hash", f"dp-{tx.get('id', '')}"),
            "timestamp": int(tx.get("timestamp", 0)) * 1000,
            "price": btc_price or 65000,
            "volumeBTC": amount_coin,
            "volumeUSD": float(tx.get("amount_usd", 0)),
            "priceImpactPct": price_impact,
            "exchange": tx.get("to", {}).get("owner") or tx.get("from", {}).get("owner") or "Unknown",
            "side": side,
            "isSignificant": is_significant,
        })

    # ── Build hourly inflow/outflow histogram (last 8 h) ────────────────
    now_ms = int(time.time()) * 1000
    buckets: Dict[int, Dict[str, float]] = {}
    for h in range(8):
        bucket_start = now_ms - (8 - h) * 3_600_000
        buckets[h] = {"hour_ts": bucket_start, "inflow": 0.0, "outflow": 0.0}

    for tx in whale_feed:
        age_h = (now_ms - tx["timestamp"]) / 3_600_000
        bucket_idx = 7 - int(age_h)
        if 0 <= bucket_idx <= 7:
            if tx["direction"] == "INFLOW":
                buckets[bucket_idx]["inflow"] += tx["amountBTC"]
            else:
                buckets[bucket_idx]["outflow"] += tx["amountBTC"]

    inflow_outflow = [
        {
            "hour": datetime.fromtimestamp(b["hour_ts"] / 1000).strftime("%H:%M"),
            "netBTC": round(b["inflow"] - b["outflow"], 1),
            "inflowBTC": round(b["inflow"], 1),
            "outflowBTC": round(b["outflow"], 1),
        }
        for b in buckets.values()
    ]

    # ── Bias gauge: rolling 4-hour net signed flow ────────────────────
    cutoff_ms = now_ms - 4 * 3_600_000
    recent = [t for t in whale_feed if t["timestamp"] >= cutoff_ms]
    buy_vol = sum(t["amountBTC"] for t in recent if t["direction"] == "INFLOW")
    sell_vol = sum(t["amountBTC"] for t in recent if t["direction"] == "OUTFLOW")
    total_vol = buy_vol + sell_vol or 1
    raw_bias = (buy_vol - sell_vol) / total_vol

    result = {
        "whaleFeed": whale_feed[:40],
        "blockTrades": block_trades[:30],
        "inflowOutflow": inflow_outflow,
        "rawBias": round(raw_bias, 4),
        "isReal": True,
    }

    _whale_cache["data"] = result
    _whale_cache["ts"] = time.time()
    logger.info(f"Whale Alert: fetched {len(whale_feed)} transfers, bias={raw_bias:.3f}")
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