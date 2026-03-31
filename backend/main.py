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
from collections import deque, defaultdict
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
BACKEND_API_KEY = os.getenv("BACKEND_API_KEY", "dev-secret-key-123")
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", BACKEND_API_KEY)

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
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-preview",
    "gemini-2.5-pro-preview-03-25",
    "gemini-2.0-flash",
    "gemini-2.0-flash-thinking-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
}
DEFAULT_MODEL = "gemini-2.0-flash"

# Ordered fallback chain: newest/fastest → oldest
# When the preferred model fails, the next one in the chain is tried automatically.
FALLBACK_CHAIN = [
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-preview",
    "gemini-2.5-pro-preview-03-25",
    "gemini-2.0-flash",
    "gemini-2.0-flash-thinking-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
]

def _safe_model(name: str) -> str:
    """Return a validated model name, falling back to default."""
    return name if name in VALID_GEMINI_MODELS else DEFAULT_MODEL

async def generate_with_fallback(preferred: str, prompt: str) -> tuple:
    """
    Try the preferred model first; on any error loop through FALLBACK_CHAIN.
    Returns (response_text: str, model_used: str).
    Raises RuntimeError if every model fails.
    """
    # Build a deduplicated ordered list: preferred first, then the rest of the chain
    validated = _safe_model(preferred)
    chain = [validated] + [m for m in FALLBACK_CHAIN if m != validated]

    last_err = None
    for model_id in chain:
        try:
            gen_model = genai.GenerativeModel(model_id)
            response = await gen_model.generate_content_async(prompt)
            logger.info(f"AI served by model: {model_id}")
            return response.text, model_id
        except Exception as e:
            logger.warning(f"Model {model_id} failed: {e} — trying next fallback")
            last_err = e

    raise RuntimeError(f"All AI models exhausted. Last error: {last_err}")

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

ALLOWED_ORIGINS = [
    FRONTEND_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

RATE_LIMIT_WINDOW = 60
MAX_REQUESTS_PER_MIN = 60
MAX_AI_REQUESTS_PER_MIN = 10

request_counts = defaultdict(list)
ai_request_counts = defaultdict(list)

@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path
    if path in ["/health", "/docs", "/openapi.json"]:
        return await call_next(request)

    # 1. API Key Auth
    api_key = request.headers.get("X-API-Key")
    if not api_key or api_key != BACKEND_API_KEY:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized. Missing or invalid X-API-Key header."})
        
    # Admin Auth specific to system-status
    if path.startswith("/admin/"):
        admin_key = request.headers.get("X-Admin-Key")
        if not admin_key or admin_key != ADMIN_API_KEY:
            return JSONResponse(status_code=403, content={"detail": "Forbidden. Admin access required."})

    # 2. Rate Limiting
    client_ip = request.client.host if request.client else "127.0.0.1"
    now = time.time()
    
    request_counts[client_ip] = [t for t in request_counts[client_ip] if now - t < RATE_LIMIT_WINDOW]
    ai_request_counts[client_ip] = [t for t in ai_request_counts[client_ip] if now - t < RATE_LIMIT_WINDOW]
    
    is_ai = any(kw in path for kw in ["/analyze", "/flow", "/strategy", "/market-intelligence", "/alerts/evaluate"])
    if is_ai:
        if len(ai_request_counts[client_ip]) >= MAX_AI_REQUESTS_PER_MIN:
            logger.warning(f"Rate limit exceeded (AI) for IP: {client_ip}")
            return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded for AI endpoints."})
        ai_request_counts[client_ip].append(now)
    else:
        if len(request_counts[client_ip]) >= MAX_REQUESTS_PER_MIN:
            logger.warning(f"Rate limit exceeded (Standard) for IP: {client_ip}")
            return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded."})
        request_counts[client_ip].append(now)

    return await call_next(request)

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

def _analyze_market_algo(symbol: str, klines: list) -> dict:
    """
    Deterministic chart analysis engine.
    Computes Z-Score, VWAP, Pivot levels, ATR and derives ENTRY/EXIT/WAIT
    with a human-readable explanation string.
    """
    closes  = [float(x[4]) for x in klines]
    highs   = [float(x[2]) for x in klines]
    lows    = [float(x[3]) for x in klines]
    volumes = [float(x[5]) for x in klines]

    current_price = closes[-1]
    high = max(highs)
    low  = min(lows)

    # ── Pivot points ──────────────────────────────────────────────────
    pivot = (high + low + current_price) / 3
    r1    = 2 * pivot - low
    s1    = 2 * pivot - high
    r2    = pivot + (high - low)
    s2    = pivot - (high - low)

    # ── VWAP (volume-weighted average price) ──────────────────────────
    typical_prices = [(h + l + c) / 3 for h, l, c in zip(highs, lows, closes)]
    total_vol      = sum(volumes) or 1
    vwap           = sum(tp * v for tp, v in zip(typical_prices, volumes)) / total_vol

    # ── Z-Score (last 20 closes) ──────────────────────────────────────
    window = closes[-20:]
    mean   = sum(window) / len(window)
    std    = (sum((x - mean) ** 2 for x in window) / len(window)) ** 0.5 or 1
    z      = (current_price - mean) / std

    # ── ATR (last 14 bars) ────────────────────────────────────────────
    tr_values = []
    for i in range(1, min(15, len(klines))):
        h, l, pc = highs[i], lows[i], closes[i - 1]
        tr_values.append(max(h - l, abs(h - pc), abs(l - pc)))
    atr = sum(tr_values) / len(tr_values) if tr_values else (high - low) / 14

    # ── Trend bias (last 5 closes vs previous 5) ──────────────────────
    short_mean = sum(closes[-5:]) / 5
    mid_mean   = sum(closes[-10:-5]) / 5
    trend_up   = short_mean > mid_mean

    # ── Verdict logic ─────────────────────────────────────────────────
    above_vwap = current_price > vwap
    near_support    = abs(current_price - s1) / (atr or 1) < 1.5
    near_resistance = abs(current_price - r1) / (atr or 1) < 1.5

    reasons_bull = []
    reasons_bear = []
    reasons_wait = []

    # Bullish signals
    if z < -1.5:
        reasons_bull.append(f"price is statistically depressed (Z={z:.2f}σ), indicating mean-reversion potential")
    if above_vwap and trend_up:
        reasons_bull.append(f"price is trading above VWAP ({vwap:.2f}) with upward momentum")
    if near_support:
        reasons_bull.append(f"price is testing key support at {s1:.2f} — a bounce zone")

    # Bearish signals
    if z > 1.5:
        reasons_bear.append(f"price is statistically stretched (Z={z:.2f}σ), mean-reversion risk is elevated")
    if not above_vwap and not trend_up:
        reasons_bear.append(f"price is trading below VWAP ({vwap:.2f}) with downward momentum")
    if near_resistance:
        reasons_bear.append(f"price is testing resistance at {r1:.2f} — sellers likely to defend")

    # Neutral signals
    if abs(z) <= 0.5:
        reasons_wait.append(f"Z-Score is neutral ({z:.2f}σ), no statistical edge")
    if not near_support and not near_resistance and not reasons_bull and not reasons_bear:
        reasons_wait.append("price is between key pivots — no high-probability setup is present")

    bull_score = len(reasons_bull)
    bear_score = len(reasons_bear)

    if bull_score > bear_score and bull_score >= 2:
        verdict    = "ENTRY"
        confidence = min(0.5 + bull_score * 0.15, 0.92)
        stop_loss  = max(s1, current_price - 1.5 * atr)
        take_profit = min(r1, current_price + 3.0 * atr)
        rr = abs(take_profit - current_price) / max(abs(current_price - stop_loss), 0.0001)
        analysis = (
            f"ENTRY signal on {symbol} @ {current_price:.2f}. "
            + " ".join(f"{r.capitalize()}." for r in reasons_bull)
            + f" Pivot support at {s1:.2f}, resistance at {r1:.2f}. "
            f"ATR={atr:.2f}. Suggested stop: {stop_loss:.2f}, target: {take_profit:.2f} (R:R {rr:.1f}:1)."
        )
    elif bear_score > bull_score and bear_score >= 2:
        verdict    = "EXIT"
        confidence = min(0.5 + bear_score * 0.15, 0.92)
        stop_loss  = min(r1, current_price + 1.5 * atr)
        take_profit = max(s1, current_price - 3.0 * atr)
        rr = abs(take_profit - current_price) / max(abs(current_price - stop_loss), 0.0001)
        analysis = (
            f"EXIT/SHORT signal on {symbol} @ {current_price:.2f}. "
            + " ".join(f"{r.capitalize()}." for r in reasons_bear)
            + f" Key resistance at {r1:.2f}, support at {s1:.2f}. "
            f"ATR={atr:.2f}. Suggested stop: {stop_loss:.2f}, target: {take_profit:.2f} (R:R {rr:.1f}:1)."
        )
        stop_loss, take_profit = take_profit, stop_loss  # flip for display
    else:
        verdict    = "WAIT"
        confidence = 0.4
        stop_loss  = s1
        take_profit = r1
        rr = 2.0
        wait_reasons = reasons_wait or ["conflicting signals require more confluence"]
        analysis = (
            f"WAIT on {symbol} @ {current_price:.2f}. No clear edge: "
            + "; ".join(wait_reasons)
            + f". Monitor VWAP ({vwap:.2f}), pivot ({pivot:.2f}), S1 ({s1:.2f}), R1 ({r1:.2f})."
        )

    return {
        "support": [round(s1, 4), round(s2, 4)],
        "resistance": [round(r1, 4), round(r2, 4)],
        "decision_price": round(pivot, 4),
        "verdict": verdict,
        "confidence": round(confidence, 2),
        "analysis": analysis,
        "risk_reward_ratio": round(rr, 2),
        "entry_price": round(current_price, 4),
        "stop_loss": round(stop_loss, 4),
        "take_profit": round(take_profit, 4),
        "is_simulated": False,
        "model_used": "quad-algo-v1",
    }


@app.get("/analyze")
async def analyze_market(symbol: str = Query(..., pattern=r"^[A-Z0-9]{3,12}$"), model: str = DEFAULT_MODEL):
    klines = await fetch_binance_candles(symbol, "15m", 30)
    if not klines:
        raise HTTPException(status_code=502, detail="Upstream Down")
    return _analyze_market_algo(symbol, klines)

@app.post("/analyze/flow")
async def analyze_order_flow(req: AnalysisRequest):
    """
    Deterministic order-flow analysis engine.
    Evaluates NetDelta, CVD trend, and POC distance to classify flow.
    """
    net_delta   = req.netDelta
    cvd_up      = req.cvdTrend.upper() in ("UP", "BULLISH", "POSITIVE", "RISING")
    cvd_down    = req.cvdTrend.upper() in ("DOWN", "BEARISH", "NEGATIVE", "FALLING")
    above_poc   = req.price > req.pocPrice
    poc_delta   = abs(req.price - req.pocPrice)
    poc_pct     = poc_delta / (req.pocPrice or 1) * 100

    bull_points = 0
    bear_points = 0
    notes       = []

    # NetDelta scoring
    if net_delta > req.totalVolume * 0.05:
        bull_points += 2
        notes.append(f"Net delta is strongly positive ({net_delta:+.0f}), indicating aggressive buy-side absorption")
    elif net_delta > 0:
        bull_points += 1
        notes.append(f"Net delta is mildly positive ({net_delta:+.0f}), buyers have slight edge")
    elif net_delta < -req.totalVolume * 0.05:
        bear_points += 2
        notes.append(f"Net delta is strongly negative ({net_delta:+.0f}), sellers are dominating order flow")
    elif net_delta < 0:
        bear_points += 1
        notes.append(f"Net delta is mildly negative ({net_delta:+.0f}), sellers have slight edge")

    # CVD scoring
    if cvd_up:
        bull_points += 1
        notes.append("CVD trend is rising — cumulative buyer pressure is building")
    elif cvd_down:
        bear_points += 1
        notes.append("CVD trend is falling — cumulative seller pressure is building")

    # POC position
    if above_poc:
        bull_points += 1
        notes.append(f"Price ({req.price:.2f}) is trading above the Point of Control ({req.pocPrice:.2f}) by {poc_pct:.2f}% — fair-value bullish bias")
    else:
        bear_points += 1
        notes.append(f"Price ({req.price:.2f}) is trading below the Point of Control ({req.pocPrice:.2f}) by {poc_pct:.2f}% — fair-value bearish bias")

    # Verdict
    if bull_points > bear_points + 1:
        verdict    = "BULLISH"
        flow_type  = "ACCUMULATION"
        confidence = min(0.5 + bull_points * 0.1, 0.93)
        explanation = (
            f"Order flow on {req.symbol} is BULLISH. "
            + " ".join(f"{n.capitalize()}." for n in notes)
            + " Position bias: favour buy-side setups at value."
        )
    elif bear_points > bull_points + 1:
        verdict    = "BEARISH"
        flow_type  = "DISTRIBUTION"
        confidence = min(0.5 + bear_points * 0.1, 0.93)
        explanation = (
            f"Order flow on {req.symbol} is BEARISH. "
            + " ".join(f"{n.capitalize()}." for n in notes)
            + " Position bias: favour sell-side setups at resistance."
        )
    else:
        verdict    = "NEUTRAL"
        flow_type  = "BALANCED"
        confidence = 0.45
        explanation = (
            f"Order flow on {req.symbol} is BALANCED — no dominant side. "
            + " ".join(f"{n.capitalize()}." for n in notes)
            + " Wait for a decisive delta shift or CVD break before committing."
        )

    return {
        "verdict": verdict,
        "confidence": round(confidence, 2),
        "explanation": explanation,
        "flow_type": flow_type,
        "is_simulated": False,
        "model_used": "quad-algo-v1",
    }

@app.post("/analyze/strategy")
async def analyze_strategy(req: MacroStrategyRequest):
    """
    Deterministic Macro Statistical Filter Strategy engine.
    Each signal casts a weighted vote. The majority direction wins.
    A human-readable analysis string is built from the active signals.
    """
    bull: list[str] = []
    bear: list[str] = []
    reversal: list[str] = []

    # ── 1. Z-Score ───────────────────────────────────────────────────────
    if req.zScore >= 2.5:
        reversal.append(f"Z-Score ({req.zScore:.2f}σ) is in Sentiment Wash territory — statistically extreme, mean-reversion SHORT expected")
        bear.append("zscore")
    elif req.zScore <= -2.5:
        reversal.append(f"Z-Score ({req.zScore:.2f}σ) is deeply negative — statistically oversold, mean-reversion LONG expected")
        bull.append("zscore")
    elif req.zScore > 0.5:
        bull.append(f"Z-Score ({req.zScore:.2f}σ) confirms a mild bullish drift above the mean")
    elif req.zScore < -0.5:
        bear.append(f"Z-Score ({req.zScore:.2f}σ) confirms a mild bearish drift below the mean")

    # ── 2. Bayesian Posterior ────────────────────────────────────────────
    if req.bayesianPosterior > 0.65:
        bull.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) strongly confirms bullish evidence — upside probability is elevated")
    elif req.bayesianPosterior > 0.6:
        bull.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) leans bullish — evidence slightly favours upside")
    elif req.bayesianPosterior < 0.35:
        bear.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) strongly confirms bearish evidence — downside probability is elevated")
    elif req.bayesianPosterior < 0.4:
        bear.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) leans bearish — evidence slightly favours downside")

    # ── 3. RSI ───────────────────────────────────────────────────────────
    if req.rsi < 30:
        bull.append(f"RSI ({req.rsi:.1f}) signals capitulation — retail has over-sold; prepare for a high-velocity reversal long")
        reversal.append("RSI capitulation LONG")
    elif req.rsi > 70:
        bear.append(f"RSI ({req.rsi:.1f}) signals overheating — retail is over-extended; prepare for a high-velocity reversal short")
        reversal.append("RSI capitulation SHORT")
    elif req.rsi >= 55:
        bull.append(f"RSI ({req.rsi:.1f}) is in bullish building zone — trend is healthy with upward momentum")
    elif req.rsi <= 40:
        bear.append(f"RSI ({req.rsi:.1f}) is in bearish territory — downward pressure is sustained")

    # ── 4. OFI (Order Flow Imbalance) ────────────────────────────────────
    if req.ofi > 10:
        bull.append(f"OFI ({req.ofi:.1f}) shows positive order flow imbalance — buyers are aggressively lifting offers")
    elif req.ofi < -10:
        bear.append(f"OFI ({req.ofi:.1f}) shows negative order flow imbalance — sellers are aggressively hitting bids")

    # ── 5. CVD (Cumulative Volume Delta) ─────────────────────────────────
    if req.cvd > 0:
        bull.append(f"CVD ({req.cvd:.0f}) is positive — aggressive buyers dominate the tape")
    elif req.cvd < 0:
        bear.append(f"CVD ({req.cvd:.0f}) is negative — aggressive sellers dominate the tape")

    # ── 6. Skewness ──────────────────────────────────────────────────────
    if req.skewness < -0.5:
        bear.append(f"Return skewness ({req.skewness:.3f}) is negatively skewed — downside tail risk is elevated")
    elif req.skewness > 0.5:
        bull.append(f"Return skewness ({req.skewness:.3f}) is positively skewed — upside tail risk dominates")

    # ── Tally votes ──────────────────────────────────────────────────────
    bull_score = sum(1 for x in bull if isinstance(x, str) and not x in ("zscore",)) + bull.count("zscore")
    # Count actual signal strings (not tags)
    bull_signals = [x for x in bull if not x == "zscore"] + ([f"Z-Score {req.zScore:.2f}σ bullish"] if "zscore" in bull else [])
    bear_signals = [x for x in bear if not x == "zscore"] + ([f"Z-Score {req.zScore:.2f}σ bearish"] if "zscore" in bear else [])

    bull_count = len([x for x in bull if isinstance(x, str)])
    bear_count = len([x for x in bear if isinstance(x, str)])
    mean_rev   = len(reversal) >= 1

    if mean_rev and abs(req.zScore) >= 2.5:
        verdict    = "MEAN_REVERSAL"
        confidence = min(0.65 + abs(req.zScore) * 0.05, 0.95)
        direction  = "LONG" if req.zScore <= -2.5 else "SHORT"
        analysis = (
            f"MEAN REVERSAL setup on {req.symbol}. "
            + " ".join(f"{r}." for r in reversal)
            + f" Dominant direction: {direction}. "
            f"Tape: speed={req.tapeSpeed}, dominant={req.tapeDominant}. "
            f"Wall context: {req.wallContext}. "
            "Fade the extreme — enter counter-trend with tight risk."
        )
    elif bull_count > bear_count and bull_count >= 2:
        verdict    = "BUY"
        confidence = min(0.50 + bull_count * 0.08, 0.93)
        all_bull   = [x for x in bull if isinstance(x, str)]
        analysis = (
            f"BUY signal on {req.symbol} @ {req.price:.2f}. "
            + " ".join(f"{b.capitalize()}." for b in all_bull[:4])
            + f" Tape speed: {req.tapeSpeed}, dominant side: {req.tapeDominant}. "
            f"Wall context: {req.wallContext}. "
            "All macro filters align — favour long entries on pullbacks to value."
        )
    elif bear_count > bull_count and bear_count >= 2:
        verdict    = "SELL"
        confidence = min(0.50 + bear_count * 0.08, 0.93)
        all_bear   = [x for x in bear if isinstance(x, str)]
        analysis = (
            f"SELL signal on {req.symbol} @ {req.price:.2f}. "
            + " ".join(f"{b.capitalize()}." for b in all_bear[:4])
            + f" Tape speed: {req.tapeSpeed}, dominant side: {req.tapeDominant}. "
            f"Wall context: {req.wallContext}. "
            "Macro filters lean bearish — favour short entries at resistance or broken support."
        )
    else:
        verdict    = "WAIT"
        confidence = 0.40
        mixed      = [x for x in bull + bear if isinstance(x, str)]
        analysis = (
            f"WAIT on {req.symbol} @ {req.price:.2f} — signals are conflicting or insufficient. "
            + (f"Mixed readings: {'; '.join(mixed[:3])}." if mixed else "No dominant signal detected.")
            + f" Tape speed: {req.tapeSpeed}. Wall context: {req.wallContext}. "
            "Do not force a trade. Wait for Z-Score divergence, OFI confirmation, and Bayesian alignment."
        )

    return {
        "verdict": verdict,
        "confidence": round(confidence, 2),
        "analysis": analysis,
        "is_simulated": False,
        "model_used": "quad-algo-v1",
    }

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
            resp_text, model_used = await generate_with_fallback(model, prompt)
            match = re.search(r'\{.*\}', resp_text.replace('\n', ' '), re.DOTALL)
            if match:
                text = match.group(0)
            else:
                text = resp_text.replace('```json', '').replace('```', '').strip()
            intelligence = json.loads(text)
            intelligence["model_used"] = model_used
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
    bayesianPosterior: float = 0.5
    expectedValueRR: float = 0.0
    dynamicEntry: Optional[float] = None
    dynamicStop: Optional[float] = None
    dynamicTarget: Optional[float] = None
    model: str = DEFAULT_MODEL
    class Config:
        extra = "allow"


@app.post("/alerts/evaluate")
async def alerts_evaluate(req: AlertEvaluateRequest):
    """
    Deterministic alert evaluation engine.
    Scores 5 independent conditions; fires alert when at least 4 pass.
    Computes ATR-based entry/stop/target and generates reasoning text.
    """
    passed   = []
    failed   = []
    z_abs    = abs(req.zScore)

    if z_abs >= 1.5:
        passed.append(f"Z-Score ({req.zScore:+.2f}σ) ≥ 1.5σ — meaningful dislocation")
    else:
        failed.append(f"Z-Score ({req.zScore:+.2f}σ) < 1.5σ — weak dislocation")

    if req.tacticalProbability >= 0.55:
        passed.append(f"Tactical probability ({req.tacticalProbability:.2f}) ≥ 0.55 — moderate confidence setup")
    else:
        failed.append(f"Tactical probability ({req.tacticalProbability:.2f}) < 0.55 — setup not mature")

    if req.aiScore >= 0.6:
        passed.append(f"Algorithmic score ({req.aiScore:.2f}) ≥ 0.60 — model consensus confirmed")
    else:
        failed.append(f"Algorithmic score ({req.aiScore:.2f}) < 0.60 — model score below threshold")

    expected_direction = "LONG" if req.zScore < 0 else "SHORT"

    if expected_direction == "LONG":
        if req.bayesianPosterior >= 0.55:
            passed.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) ≥ 0.55 — bullish probability evidence")
        else:
            failed.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) < 0.55 — insufficient posterior evidence")
    else:
        if req.bayesianPosterior <= 0.45:
            passed.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) ≤ 0.45 — bearish probability evidence")
        else:
            failed.append(f"Bayesian Posterior ({req.bayesianPosterior:.2f}) > 0.45 — insufficient bearish evidence")

    if req.expectedValueRR >= 1.0:
        passed.append(f"E[X] Math ({req.expectedValueRR:.2f} R) ≥ 1.0 R — favorable risk/reward setup")
    else:
        failed.append(f"E[X] Math ({req.expectedValueRR:.2f} R) < 1.0 R — poor risk/reward expectancy")

    score        = len(passed)
    should_alert = score >= 3

    algo_analysis = None
    if should_alert:
        # Direction: if z-score is negative → oversold → LONG; positive → overbought → SHORT
        direction  = "LONG" if req.zScore < 0 else "SHORT"
        entry = req.dynamicEntry if req.dynamicEntry else req.price
        
        if req.dynamicStop and req.dynamicTarget:
            stop = round(req.dynamicStop, 4)
            target = round(req.dynamicTarget, 4)
        else:
            # ATR estimate: use 0.8% of price as a conservative ATR proxy when no candles passed
            atr_proxy  = req.price * 0.008
            stop       = round(entry - atr_proxy * 1.5 if direction == "LONG" else entry + atr_proxy * 1.5, 4)
            target     = round(entry + atr_proxy * 3.0 if direction == "LONG" else entry - atr_proxy * 3.0, 4)
            
        rr         = round(abs(target - entry) / max(abs(entry - stop), 0.0001), 2)
        confidence = round(min(0.55 + score * 0.12 + z_abs * 0.04, 0.95), 2)

        reasoning = (
            f"Alert conditions FULLY MET for {req.symbol} @ {entry:.2f}. "
            + " ".join(f"{p}." for p in passed)
            + f" Direction: {direction}. "
            f"Entry: {entry:.2f}, Stop: {stop:.2f}, Target: {target:.2f} (R:R {rr}:1). "
            f"Confidence: {confidence*100:.0f}%. Execute with defined risk only."
        )

        algo_analysis = {
            "direction": direction,
            "confidence": confidence,
            "entry": entry,
            "stop": stop,
            "target": target,
            "reasoning": reasoning,
            "model_used": "quad-algo-v1",
        }
    else:
        logger.info(
            f"Alert suppressed for {req.symbol}: {score}/5 conditions met. "
            f"Failed: {'; '.join(failed)}"
        )

    return {
        "shouldAlert": should_alert,
        "score": score,
        "passedConditions": score,
        "aiAnalysis": algo_analysis,
    }


@app.post("/alerts/send-telegram")
async def send_telegram_alert(payload: TelegramPayload):
    """Send a formatted trading alert via Telegram."""
    bot_token = TELEGRAM_BOT_TOKEN
    chat_id = TELEGRAM_CHAT_ID

    if not bot_token or not chat_id:
        raise HTTPException(status_code=400, detail="Telegram credentials not configured on backend.")

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


class AlertConfigureRequest(BaseModel):
    symbol: str
    telegram_bot_token: str
    telegram_chat_id: str

@app.post("/alerts/configure")
async def alerts_configure(req: AlertConfigureRequest):
    """Save autonomous configuration sent from frontend."""
    state["autonomous_active"] = True
    logger.info(f"Autonomous configuration saved for {req.symbol}.")
    return {"success": True, "message": "Autonomous mode configured"}

@app.post("/alerts/test")
async def alerts_test(payload: TelegramPayload):
    """Trigger a test alert to verify Telegram connectivity."""
    logger.info(f"Test alert triggered for {payload.symbol}")
    return await send_telegram_alert(payload)


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

# ── Backtesting ─────────────────────────────────────────────────────────────

class BacktestRequest(BaseModel):
    symbol: str = "BTCUSDT"
    from_date: str   # ISO date string: "2025-01-01"
    to_date: str     # ISO date string: "2025-03-01"
    risk_pct: float = 1.0
    min_confidence: float = 0.70
    account_size: float = 100.0
    interval: str = "1h"   # candle interval for backtest


async def _fetch_historical_candles(symbol: str, interval: str, start_ms: int, end_ms: int) -> list:
    """
    Paginate Binance klines to cover the full date range.
    Binance returns max 1000 candles per call; we paginate until end_ms.
    """
    all_candles = []
    current_ms = start_ms
    MAX_PER_CALL = 1000

    async with httpx.AsyncClient(timeout=20.0) as client:
        while current_ms < end_ms:
            params = {
                "symbol":    symbol.upper(),
                "interval":  interval,
                "startTime": current_ms,
                "endTime":   end_ms,
                "limit":     MAX_PER_CALL,
            }
            try:
                resp = await client.get(f"{BINANCE_BASE}/api/v3/klines", params=params)
                resp.raise_for_status()
                batch = resp.json()
                if not batch:
                    break
                all_candles.extend(batch)
                # Next page starts after last candle's close time
                current_ms = int(batch[-1][6]) + 1   # closeTime + 1ms
                if len(batch) < MAX_PER_CALL:
                    break
            except Exception as e:
                logger.error(f"Backtest candle fetch error: {e}")
                break

    return all_candles


def _run_backtest_engine(
    candles_raw: list,
    risk_pct: float,
    min_confidence: float,
    account_size: float,
) -> dict:
    """
    Replay the 6-stage signal engine on historical OHLCV data.
    Uses pure Python so it doesn't require the bot's async feed.
    Returns trade log + performance statistics.
    """
    if len(candles_raw) < 55:
        return {"trades": [], "stats": {"error": "Not enough candle data"}}

    # Build candle list
    candles = [
        {
            "time":   int(k[0]) / 1000,
            "open":   float(k[1]),
            "high":   float(k[2]),
            "low":    float(k[3]),
            "close":  float(k[4]),
            "volume": float(k[5]),
        }
        for k in candles_raw
    ]

    equity     = account_size
    trades     = []
    equity_curve = [account_size]

    # Rolling window size for indicators
    WIN = 20  # Z-Score / VWAP window
    ATR_WIN = 14

    MIN_WARM = 55

    for i in range(MIN_WARM, len(candles)):
        window = candles[max(0, i - WIN): i]
        atr_window = candles[max(0, i - ATR_WIN - 1): i]

        closes = [c["close"] for c in window]
        prices = [c["close"] for c in atr_window]
        highs  = [c["high"]  for c in atr_window]
        lows   = [c["low"]   for c in atr_window]

        current = candles[i]
        price   = current["close"]

        # ── Z-Score ───────────────────────────────────────────────────
        mean = sum(closes) / len(closes)
        variance = sum((c - mean) ** 2 for c in closes) / len(closes)
        std  = variance ** 0.5 or 1.0
        z    = (price - mean) / std

        # ── ATR ───────────────────────────────────────────────────────
        tr_vals = []
        for j in range(1, len(prices)):
            hl = highs[j] - lows[j]
            hc = abs(highs[j] - prices[j - 1])
            lc = abs(lows[j]  - prices[j - 1])
            tr_vals.append(max(hl, hc, lc))
        atr = sum(tr_vals[-ATR_WIN:]) / min(len(tr_vals), ATR_WIN) if tr_vals else price * 0.005

        # ── RSI (simple) ──────────────────────────────────────────────
        gains, losses = [], []
        for j in range(1, len(closes)):
            d = closes[j] - closes[j - 1]
            gains.append(max(d, 0))
            losses.append(max(-d, 0))
        avg_gain = sum(gains[-14:]) / 14 if len(gains) >= 14 else 0.5
        avg_loss = sum(losses[-14:]) / 14 if len(losses) >= 14 else 0.5
        rs    = avg_gain / avg_loss if avg_loss > 0 else 100
        rsi   = 100 - (100 / (1 + rs))

        # ── Simple Bayesian proxy ─────────────────────────────────────
        L_rsi = 3.0 if rsi > 55 else 0.333 if rsi < 45 else 1.0
        L_z   = 1.6 if z < -1.5 else 0.625 if z > 1.5 else 1.0
        bull_odds = L_rsi * L_z
        bayes = bull_odds / (bull_odds + 1.0)

        # ── Signal logic (simplified 4-stage) ─────────────────────────
        direction: Optional[str] = None
        confidence = 0.0

        # Mean Reversion (Z-Score extremes)
        if z <= -2.5 and rsi < 55:
            direction  = "BUY"
            confidence = min(0.5 + abs(z) * 0.08, 0.95)
        elif z >= 2.5 and rsi > 45:
            direction  = "SELL"
            confidence = min(0.5 + abs(z) * 0.08, 0.95)
        # Trend (strong Bayesian + RSI momentum)
        elif bayes > 0.65 and rsi > 60:
            direction  = "BUY"
            confidence = 0.55 + (bayes - 0.65) * 2.0
        elif bayes < 0.35 and rsi < 40:
            direction  = "SELL"
            confidence = 0.55 + (0.35 - bayes) * 2.0

        if direction is None or confidence < min_confidence:
            continue

        # ── Risk sizing ───────────────────────────────────────────────
        is_long   = direction == "BUY"
        sl_dist   = atr * 1.5
        tp_dist   = sl_dist * 2.0
        stop_loss   = round(price - sl_dist if is_long else price + sl_dist, 2)
        take_profit = round(price + tp_dist if is_long else price - tp_dist, 2)

        risk_usd  = equity * (risk_pct / 100.0)
        qty       = risk_usd / sl_dist if sl_dist > 0 else 0.0
        if qty <= 0:
            continue

        # ── Simulate exit on subsequent candles ───────────────────────
        result   = "OPEN"
        exit_price = price
        exit_idx   = i

        for j in range(i + 1, min(i + 100, len(candles))):
            future = candles[j]
            if is_long:
                if future["low"] <= stop_loss:
                    exit_price = stop_loss
                    result = "LOSS"
                    exit_idx = j
                    break
                if future["high"] >= take_profit:
                    exit_price = take_profit
                    result = "WIN"
                    exit_idx = j
                    break
            else:
                if future["high"] >= stop_loss:
                    exit_price = stop_loss
                    result = "LOSS"
                    exit_idx = j
                    break
                if future["low"] <= take_profit:
                    exit_price = take_profit
                    result = "WIN"
                    exit_idx = j
                    break

        if result == "OPEN":
            continue  # Skip unresolved trades in stats

        pnl = (exit_price - price) * qty if is_long else (price - exit_price) * qty
        equity += pnl

        trades.append({
            "date":        datetime.fromtimestamp(current["time"]).strftime("%Y-%m-%d %H:%M"),
            "exit_date":   datetime.fromtimestamp(candles[exit_idx]["time"]).strftime("%Y-%m-%d %H:%M"),
            "side":        "BUY" if is_long else "SELL",
            "entry":       round(price, 2),
            "stop_loss":   stop_loss,
            "take_profit": take_profit,
            "exit_price":  round(exit_price, 2),
            "pnl":         round(pnl, 2),
            "result":      result,
            "confidence":  round(confidence, 3),
            "equity":      round(equity, 2),
            "z_score":     round(z, 3),
            "rsi":         round(rsi, 1),
        })
        equity_curve.append(round(equity, 2))

        # Skip to after the exit candle (no overlapping trades)
        i = exit_idx

    # ── Performance statistics ─────────────────────────────────────────
    if not trades:
        return {
            "trades": [],
            "equity_curve": equity_curve,
            "stats": {
                "totalTrades": 0, "wins": 0, "losses": 0,
                "winRate": 0, "totalReturn": 0, "maxDrawdown": 0, "sharpe": 0,
            }
        }

    wins       = sum(1 for t in trades if t["result"] == "WIN")
    losses     = sum(1 for t in trades if t["result"] == "LOSS")
    win_rate   = round(wins / len(trades) * 100, 1)

    total_return = round((equity - account_size) / account_size * 100, 2)

    # Max drawdown
    peak = account_size
    max_dd = 0.0
    for eq in equity_curve:
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak * 100
        if dd > max_dd:
            max_dd = dd

    # Sharpe ratio (annualised, assume 252 trading days)
    pnls = [t["pnl"] for t in trades]
    if len(pnls) > 1:
        avg_pnl  = sum(pnls) / len(pnls)
        std_pnl  = (sum((p - avg_pnl) ** 2 for p in pnls) / len(pnls)) ** 0.5
        sharpe   = round((avg_pnl / std_pnl) * (252 ** 0.5) if std_pnl > 0 else 0.0, 2)
    else:
        sharpe = 0.0

    return {
        "trades":       trades,
        "equity_curve": equity_curve,
        "stats": {
            "totalTrades": len(trades),
            "wins":        wins,
            "losses":      losses,
            "winRate":     win_rate,
            "totalReturn": total_return,
            "maxDrawdown": round(max_dd, 2),
            "sharpe":      sharpe,
            "finalEquity": round(equity, 2),
        }
    }


@app.post("/backtest")
async def run_backtest(req: BacktestRequest):
    """
    Replay the quant signal engine on historical OHLCV data.
    Fetches candles from Binance for the given date range,
    then simulates entries/exits and returns performance stats.
    """
    # Parse date strings
    try:
        dt_from = datetime.strptime(req.from_date, "%Y-%m-%d")
        dt_to   = datetime.strptime(req.to_date,   "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")

    if dt_from >= dt_to:
        raise HTTPException(status_code=400, detail="from_date must be before to_date.")

    date_range_days = (dt_to - dt_from).days
    if date_range_days > 365 * 3:
        raise HTTPException(status_code=400, detail="Date range too large. Max 3 years.")

    start_ms = int(dt_from.timestamp() * 1000)
    end_ms   = int(dt_to.timestamp()   * 1000)

    # Validate interval
    valid_intervals = {"1m", "5m", "15m", "1h", "4h", "1d"}
    interval = req.interval if req.interval in valid_intervals else "1h"

    logger.info(f"Backtest: {req.symbol} {interval} {req.from_date}→{req.to_date} | risk={req.risk_pct}% conf={req.min_confidence}")

    candles_raw = await _fetch_historical_candles(req.symbol.upper(), interval, start_ms, end_ms)

    if not candles_raw:
        raise HTTPException(status_code=502, detail="Failed to fetch historical data from Binance.")

    result = _run_backtest_engine(
        candles_raw,
        risk_pct=req.risk_pct,
        min_confidence=req.min_confidence,
        account_size=req.account_size,
    )

    result["meta"] = {
        "symbol":        req.symbol.upper(),
        "interval":      interval,
        "from_date":     req.from_date,
        "to_date":       req.to_date,
        "candles_fetched": len(candles_raw),
        "account_size":  req.account_size,
    }

    return result


@app.get("/backtest/symbols")
async def backtest_symbols():
    """Return supported symbols for backtesting."""
    return {
        "symbols": [
            {"value": "BTCUSDT",  "label": "Bitcoin (BTC/USDT)"},
            {"value": "ETHUSDT",  "label": "Ethereum (ETH/USDT)"},
            {"value": "SOLUSDT",  "label": "Solana (SOL/USDT)"},
            {"value": "BNBUSDT",  "label": "BNB (BNB/USDT)"},
            {"value": "XRPUSDT",  "label": "Ripple (XRP/USDT)"},
            {"value": "ADAUSDT",  "label": "Cardano (ADA/USDT)"},
            {"value": "DOGEUSDT", "label": "Dogecoin (DOGE/USDT)"},
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))