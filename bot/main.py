"""
Macro Strategy Execution Bot — Binance USDM Futures Edition (7-Stage Hybrid)
=============================================================================
Launch with:
    python -m bot.main

Architecture (7 stages):
  1. Feature Engine      — all signals from live market data (Binance Futures WS)
  2. Regime Detection    — classify: TREND | RANGE | LIQUIDITY | NEUTRAL
  3. Liquidity Sweep     — detect stop-hunts above/below walls
  4. Strategy Layer      — A: Trend, B: Mean Reversion, C: Liquidity Sweep
  5. Bayesian Fusion     — sequential probability update
  6. ULIS/ALDE Gate ★NEW — ALDE+ULIS hybrid verdict: veto or boost signal
  7. Risk Engine         — ATR-based SL/TP, daily-loss guard

Environment variables:
    BOT_EXCHANGE                — binanceusdm (Binance USDM Futures, default)
    BINANCE_API_KEY             — Binance Futures API key
    BINANCE_API_SECRET          — Binance Futures API secret
    BOT_SYMBOL                  — default: BTC/USDT
    BOT_TESTNET                 — default: false (live trading)
    BOT_LEVERAGE                — default: 3  (futures leverage, 1–20×)
    BOT_MAX_RISK_PCT            — default: 1.0  (% of equity per trade)
    BOT_MAX_DAILY_LOSS_PCT      — default: 3.0  (% of equity; pauses if hit)
    BOT_ANALYSIS_INTERVAL       — default: 10   (seconds between cycles)
    BOT_CANDLE_INTERVAL         — default: 15m  (kline interval)
    BOT_MIN_CONFIDENCE          — default: 0.65 (Bayesian fusion threshold)
    BOT_ACCOUNT_SIZE            — default: 100  (USDT equity in futures wallet)
    BOT_ULIS_GATE               — default: true (enable Stage 6 ULIS gate)
    BOT_PANIC_DROP_PCT          — default: 3.0  (% flash-crash triggers panic mode)
    BOT_PANIC_LOOKBACK          — default: 5    (candles to look back for crash)
    BOT_PANIC_LOCK_SECONDS      — default: 300  (seconds to lock after panic)

Geographic note (Railway USA ↔ Binance Europe account):
    No issue. Binance USDM Futures API (fapi.binance.com) is globally accessible.
    The adjustForTimeDifference + recvWindow=10000 options in executor.py handle
    cross-continental clock skew automatically.
"""

import asyncio
import logging
import os
import re
import signal
import threading
import time
import numpy as np
from collections import deque
from datetime import date
from typing import Dict, Any, Optional, Tuple, List

from dotenv import load_dotenv
load_dotenv()

from bot.data_feed import BinanceDataFeed
from bot.quant_engine import QuantEngine
from bot.executor import TradingExecutor
from bot.ulis_engine import compute_ulis_verdict
from bot.derivatives_context import DerivativesContext
from bot.amihud_engine import AmihudEngine
from bot.macro_shield import macro_shield
from bot import heartbeat
from bot.signal_config import (
    REGIME_PARAMS, POST_TRADE_COOLDOWN_S, COLD_START_TRADE_COUNT,
    COLD_START_CONFIDENCE_DISCOUNT,
    MAX_RISK_PCT as CFG_MAX_RISK_PCT,
    MAX_DAILY_LOSS_PCT as CFG_MAX_DAILY_LOSS_PCT,
    MAX_DRAWDOWN_PCT as CFG_MAX_DRAWDOWN_PCT,
    MIN_CONFIDENCE_GLOBAL as CFG_MIN_BAYESIAN,
    EQUITY_HARD_BLOCK, EQUITY_SMALL_ACCOUNT, EQUITY_RECOMMENDED,  # P17 FIX
    BAYES_OVERRIDE_THRESHOLD, CVD_VETO_STRENGTH, CVD_VETO_VOL_SPIKE, # P1 FIX
    FUNDING_LONG_BLOCK, FUNDING_SHORT_BLOCK, # P1 FIX
)

# ──────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
# BUG-4 FIX: Prevent httpx from logging URLs containing Telegram bot token.
# Without this the full token appears in Railway plaintext logs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("bot.main")

try:
    from bot.heartbeat import FirestoreLogHandler
    logging.getLogger().addHandler(FirestoreLogHandler())
except Exception as e:
    logger.warning(f"[Main] Could not attach FirestoreLogHandler: {e}")


# ──────────────────────────────────────────────────────────────────────
# Config from environment
# ──────────────────────────────────────────────────────────────────────
EXCHANGE            = os.environ.get("BOT_EXCHANGE",            "binanceusdm").lower()
SYMBOL              = os.environ.get("BOT_SYMBOL",              "BTC-USDC" if EXCHANGE == "coinbase" else "BTC/USDT")
TESTNET             = os.environ.get("BOT_TESTNET",             "true").lower() != "false"   # P11 FIX: safe-by-default — testnet unless explicitly set to mainnet
MAX_RISK_PCT        = float(os.environ.get("BOT_MAX_RISK_PCT",        str(CFG_MAX_RISK_PCT)))
MAX_DAILY_LOSS_PCT  = float(os.environ.get("BOT_MAX_DAILY_LOSS_PCT",  str(CFG_MAX_DAILY_LOSS_PCT)))
ANALYSIS_INTERVAL   = int(os.environ.get("BOT_ANALYSIS_INTERVAL",    "15"))
CANDLE_INTERVAL     = os.environ.get("BOT_CANDLE_INTERVAL",      "15m")
MIN_CONFIDENCE = float(os.environ.get("BOT_MIN_CONFIDENCE", str(CFG_MIN_BAYESIAN)))  # P12 FIX: wire env var, fallback to signal_config
ACCOUNT_SIZE        = float(os.environ.get("BOT_ACCOUNT_SIZE",        "100.0"))
LEVERAGE            = int(os.environ.get("BOT_LEVERAGE",              "3"))    # futures leverage (3× = efficient margin on Binance USDM)
ULIS_GATE_ENABLED   = os.environ.get("BOT_ULIS_GATE",           "true").lower() != "false"

# Fee rates: Coinbase Spot 1.2% | Binance Spot 0.1% | Binance USDM Futures 0.04%
_EXCHANGE_FEE_RATE  = 0.012 if EXCHANGE == "coinbase" else (0.0004 if EXCHANGE == "binanceusdm" else 0.001)

# Panic mode: trigger if price drops this % within PANIC_LOOKBACK candles
# e.g. 3.0 = 3% crash within 5 candles → engage panic mode
PANIC_DROP_PCT     = float(os.environ.get("BOT_PANIC_DROP_PCT",   "3.0"))
PANIC_LOOKBACK     = int(os.environ.get("BOT_PANIC_LOOKBACK",     "5"))   # candles
PANIC_LOCK_SECONDS = int(os.environ.get("BOT_PANIC_LOCK_SECONDS", "300")) # 5 min default
# Max drawdown: halt ALL trading if cumulative session PnL exceeds this % of ACCOUNT_SIZE
MAX_DRAWDOWN_PCT   = float(os.environ.get("BOT_MAX_DRAWDOWN_PCT",  str(CFG_MAX_DRAWDOWN_PCT)))


# Coinbase credentials
CB_KEY_NAME     = os.environ.get("COINBASE_API_KEY_NAME",  "")
CB_PRIVATE_KEY  = os.environ.get("COINBASE_PRIVATE_KEY",   "")

# Binance credentials
BINANCE_API_KEY        = os.environ.get("BINANCE_API_KEY",             "")
BINANCE_API_SECRET     = os.environ.get("BINANCE_API_SECRET",          "")
BINANCE_ED25519_PRIVKEY = os.environ.get("BINANCE_ED25519_PRIVATE_KEY", "")
# Normalise escaped newlines from .env (stored as literal \n)
if BINANCE_ED25519_PRIVKEY:
    BINANCE_ED25519_PRIVKEY = BINANCE_ED25519_PRIVKEY.replace("\\n", "\n").strip()

# Telegram credentials
TG_BOT_TOKEN   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID     = os.environ.get("TELEGRAM_CHAT_ID",   "")

# Derive dry-run: explicit override or no credentials at all
ENV_DRY_RUN = str(os.environ.get("BOT_DRY_RUN", "")).lower() == "true"
if EXCHANGE == "coinbase":
    DRY_RUN = ENV_DRY_RUN or not (CB_KEY_NAME and CB_PRIVATE_KEY)
else:
    # For Binance: either HMAC secret OR Ed25519 private key is sufficient
    DRY_RUN = ENV_DRY_RUN or not (BINANCE_API_KEY and (BINANCE_API_SECRET or BINANCE_ED25519_PRIVKEY))


def validate_config() -> None:
    """Fail fast on unsafe live/mainnet configuration."""
    errors = []
    if EXCHANGE not in ("binanceusdm", "binance", "coinbase"):
        errors.append(f"Unsupported BOT_EXCHANGE={EXCHANGE!r}.")
    if LEVERAGE < 1 or LEVERAGE > 20:
        errors.append("BOT_LEVERAGE must be between 1 and 20.")
    if MAX_RISK_PCT <= 0 or MAX_RISK_PCT > 5:
        errors.append("BOT_MAX_RISK_PCT must be > 0 and <= 5.")
    if MAX_DAILY_LOSS_PCT <= 0 or MAX_DAILY_LOSS_PCT > 20:
        errors.append("BOT_MAX_DAILY_LOSS_PCT must be > 0 and <= 20.")
    if not SYMBOL.strip():
        errors.append("BOT_SYMBOL cannot be empty.")
    if not DRY_RUN and not TESTNET:
        confirm_live = os.environ.get("BOT_CONFIRM_LIVE", "").strip().lower()
        if confirm_live not in ("true", "1", "yes", "i-understand"):
            errors.append("Mainnet live mode requires BOT_CONFIRM_LIVE=true.")
    if not DRY_RUN and not TG_BOT_TOKEN:
        logger.warning("[Config] TELEGRAM_BOT_TOKEN missing in live mode; critical alerts may be invisible.")
    if errors:
        for err in errors:
            logger.critical(f"[Config] {err}")
        raise RuntimeError("Unsafe bot configuration: " + " ".join(errors))

# Data feed always uses Binance public WS; normalise symbol to BTCUSDT style
if EXCHANGE == "coinbase":
    base = SYMBOL.replace("/", "-").split("-")[0]
    FEED_SYMBOL = f"{base}USDT"
else:
    # BTC/USDT  → BTCUSDT  |  BTCUSDT → BTCUSDT
    FEED_SYMBOL = SYMBOL.replace("/", "").split(":")[0]

def _normalise_symbol_id(value: str) -> str:
    return (value or "").upper().replace("/", "").replace(":USDT", "").replace("-", "")

def _position_symbol_id(position: Dict[str, Any]) -> str:
    info = position.get("info") or {}
    return _normalise_symbol_id(
        position.get("symbol")
        or info.get("symbol")
        or info.get("pair")
        or ""
    )

def _position_contracts(position: Dict[str, Any]) -> float:
    info = position.get("info") or {}
    raw = (
        position.get("contracts")
        or position.get("positionAmt")
        or info.get("positionAmt")
        or 0
    )
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0

def _position_matches_feed_symbol(position: Dict[str, Any]) -> bool:
    pos_id = _position_symbol_id(position)
    feed_id = _normalise_symbol_id(FEED_SYMBOL)
    symbol_id = _normalise_symbol_id(SYMBOL)
    return bool(pos_id and pos_id in {feed_id, symbol_id})

def _trade_matches_feed_symbol(trade: Dict[str, Any]) -> bool:
    trade_symbol = _normalise_symbol_id(trade.get("symbol") or trade.get("feed_symbol") or "")
    return trade_symbol in {_normalise_symbol_id(FEED_SYMBOL), _normalise_symbol_id(SYMBOL)}

# P10 FIX: Firestore document ID for risk ledger persistence
_RISK_LEDGER_DOC_ID = "riskLedger"

# ──────────────────────────────────────────────────────────────────────
# Shared stats (written to Firestore by heartbeat)
# ──────────────────────────────────────────────────────────────────────
BOT_STATS: Dict[str, Any] = {
    "symbol":          SYMBOL,
    "exchange":        EXCHANGE.upper(),
    "mode":            "LIVE" if not DRY_RUN else "DRY-RUN",
    "environment":     "TESTNET" if TESTNET else "MAINNET",
    "active_position": None,
    "total_trades":    0,
    "last_signal":     "WAIT",
    "last_ulis":       "—",
    "daily_pnl":       0.0,
    "session_pnl":    0.0,  # PHASE-3.1: Initialized for daily drawdown reset
    "cumulative_pnl": 0.0,  # FIX-R1: never resets — lifetime PnL since first boot
    "daily_loss_halt": False,
    "drawdown_halt": False,
    "operator_paused": False,
    "operator_last_command": None,
    "operator_last_command_status": None,
    "consecutive_losses": 0,
    "cooldown_until":     0.0,
    "gate_stats": {
        "daily_loss_halt":           0,
        "drawdown_halt":             0,
        "atr_panic_halt":            0,
        "rsi_overbought":            0,
        "rsi_oversold":              0,
        "bayes_floor_veto":          0,
        "consecutive_loss_halt":     0,
        "zscore_warmup":            0,
        "post_trade_cooldown":      0,
        "cascade_cooldown":         0,
        "regime_no_edge":           0,
        "htf_counter_trend":        0,
        "funding_blocks_long":      0,
        "funding_blocks_short":     0,
        "ulis_veto":                0,
        "ulis_alignment_fail":      0,
        "confidence_below_threshold": 0,
        "candle_gate_expired":       0,
        "micro_confirms_failed":    0,
        "sweep_confirms_failed":    0,
        "fee_geometry":             0,
        "signal_none":              0,
        "total_passed":             0,
        "cvd_divergence_veto":      0,
        "derivatives_veto":         0,
        "throughput_thin":           0,
        "rsi_extreme_suppressed":    0,  # P3 AUDIT: RSI extreme gate suppressed (TREND regime)
    },
    "equity_peak": ACCOUNT_SIZE,
    # P2-2 FIX: Confidence calibration tracker.
    # Buckets confidence into 0.1-wide intervals (0.5→0.6, 0.6→0.7, etc.).
    # Tracks (wins, total) per bucket so Kelly can be gated until calibrated.
    "confidence_calibration": {},  # { "0.6": {"wins": int, "total": int}, ... }
}

# P10 FIX: Risk ledger persistence to Firestore.
# On crash/restart, daily_loss_halt and drawdown_halt must NOT reset — they protect capital.
# Only daily_pnl and session_pnl reset at midnight (tracked by last_session_reset_date).
def _load_risk_ledger(stats: Dict[str, Any]) -> None:
    """Load persisted risk ledger from Firestore on startup.
    Applies midnight reset: if last_session_reset_date != today, reset daily_pnl and session_pnl.
    """
    import datetime as _dt
    today = _dt.date.today().isoformat()
    try:
        from bot.heartbeat import get_db
        db = get_db()
        if db is None:
            logger.warning("[RiskLedger] Firebase not available — starting with fresh ledger.")
            return
        doc = db.collection("botState").document(_RISK_LEDGER_DOC_ID).get()
        if not doc.exists:
            logger.info(f"[RiskLedger] No persisted ledger found — starting fresh.")
            return
        data = doc.to_dict()
        last_date = data.get("last_session_reset_date", "")
        # Daily reset: if date changed, reset daily and session PnL but keep cumulative
        if last_date and last_date != today:
            logger.info(f"[RiskLedger] Midnight reset detected ({last_date} → {today}). Resetting daily/session PnL.")
            stats["daily_pnl"] = 0.0
            stats["session_pnl"] = 0.0
            # halts are NOT reset — they carry across midnight
        else:
            stats["daily_pnl"] = data.get("daily_pnl", 0.0)
            stats["session_pnl"] = data.get("session_pnl", 0.0)
        stats["cumulative_pnl"] = data.get("cumulative_pnl", 0.0)
        stats["daily_loss_halt"] = data.get("daily_loss_halt", False)
        stats["consecutive_losses"] = data.get("consecutive_losses", 0)
        stats["cooldown_until"] = data.get("cooldown_until", 0.0)
        stats["loss_times"] = data.get("loss_times", [])
        stats["drawdown_halt"] = data.get("drawdown_halt", False)
        logger.info(
            f"[RiskLedger] Loaded from Firestore — "
            f"daily={stats['daily_pnl']:+.2f} session={stats['session_pnl']:+.2f} "
            f"cumulative={stats['cumulative_pnl']:+.2f} halt={stats['daily_loss_halt']}"
        )
    except Exception as e:
        logger.warning(f"[RiskLedger] Failed to load from Firestore: {e} — starting fresh.")


_risk_write_thread: threading.Thread | None = None

def _save_risk_ledger(stats: Dict[str, Any]) -> None:
    """Persist risk ledger fields to Firestore via background thread (non-blocking)."""
    global _risk_write_thread
    import datetime as _dt
    payload = {
        "daily_pnl":            stats.get("daily_pnl", 0.0),
        "session_pnl":          stats.get("session_pnl", 0.0),
        "cumulative_pnl":       stats.get("cumulative_pnl", 0.0),
        "daily_loss_halt":      stats.get("daily_loss_halt", False),
        "consecutive_losses":   stats.get("consecutive_losses", 0),
        "cooldown_until":       stats.get("cooldown_until", 0.0),
        "loss_times":           stats.get("loss_times", []),
        "drawdown_halt":        stats.get("drawdown_halt", False),
        "last_session_reset_date": _dt.date.today().isoformat(),
    }

    def _write():
        try:
            from bot.heartbeat import get_db
            db = get_db()
            if db is not None:
                db.collection("botState").document(_RISK_LEDGER_DOC_ID).set(payload)
                logger.debug("[RiskLedger] Saved to Firestore ✓")
        except Exception as e:
            logger.warning(f"[RiskLedger] Firestore save failed: {e}")

    if _risk_write_thread is not None and _risk_write_thread.is_alive():
        logger.debug("[RiskLedger] Previous write still in progress — skipping.")
        return
    _risk_write_thread = threading.Thread(target=_write, daemon=True, name="RiskLedger-FSWrite")
    _risk_write_thread.start()

GATE_STATS_LAST_LOG = 0.0  # timestamp of last 30-min gate summary
_CYCLE_ERROR_COUNT = 0  # PHASE-3.1: Consecutive cycle errors for escalation
_LAST_CYCLE_ERROR = ""  # PHASE-3.1: Last error string for escalation

LAST_CASCADE_TIME = 0.0
ATR_PANIC_CONSECUTIVE = 0
ATR_PANIC_COOLDOWN_UNTIL = 0.0
ATR_PANIC_LAST_WARN_TS = 0.0
ATR_PANIC_WARN_RANK = float(os.environ.get("BOT_ATR_PANIC_WARN_RANK", "0.90"))
ATR_PANIC_HARD_RANK = float(os.environ.get("BOT_ATR_PANIC_HARD_RANK", "0.995"))
ATR_PANIC_HARD_ATR_PCT = float(os.environ.get("BOT_ATR_PANIC_HARD_ATR_PCT", "0.02"))
ATR_PANIC_SOFT_RISK_MULT = float(os.environ.get("BOT_ATR_PANIC_SOFT_RISK_MULT", "0.50"))
BOT_START_TIME = time.time()  # used for boot-grace period on throughput gate
LAST_CVD: float   = 0.0  # Track previous CVD value so execution loop can compute delta
LAST_CANDLE_TS: float = 0.0  # Track last confirmed 15m candle open-time for candle-close gate
LAST_ANY_TRADE_CLOSE_TIME = 0.0  # Track any trade exit for post-trade cooldown
LAST_TRADE_WAS_SL: bool = False  # Track if last exit was SL for split cooldown logic
# FIX-P5: Sweep deduplication — track the candle-open-time of the last fired sweep.
# The same stale wick fires as a "new" sweep every 15s cycle without this guard.
_LAST_FIRED_SWEEP_CANDLE_TS: float = 0.0

# FIX-7.1: Derivatives context cache — updated by background task, read synchronously in signal pipeline
_CACHED_DERIV_CONTEXT: dict = {}
_DERIV_CONTEXT_LAST_UPDATE: float = 0.0
_DERIV_CONTEXT_WARMING: bool = True


def _clamp_confidence(value: float) -> float:
    """Helper to clamp confidence values between 0.0 and 1.0."""
    return max(0.0, min(1.0, value))

def _gate_stats_summary(reason: str, confidence: float = 0.0) -> None:
    """
    Increment the appropriate gate counter and log a summarised rejection
    reason every 30 minutes.  Call this at every WAIT return in _compute_signal.
    """
    import time
    global GATE_STATS_LAST_LOG

    g = BOT_STATS["gate_stats"]
    if reason in g:
        g[reason] += 1
    else:
        g[reason] = 1
        logger.warning(f"[GateStats] Unknown gate key: {reason}")

    now = time.time()
    if now - GATE_STATS_LAST_LOG >= 1800:
        total = sum(v for k, v in g.items() if k != "total_passed")
        passed = g["total_passed"]
        logger.info(
            "[GateStats] === 30-min Gate Rejection Summary ===\n"
            f"  daily_loss_halt       : {g.get('daily_loss_halt', 0)}\n"
            f"  drawdown_halt        : {g.get('drawdown_halt', 0)}\n"
            f"  atr_panic_halt        : {g.get('atr_panic_halt', 0)}\n"
            f"  rsi_overbought        : {g.get('rsi_overbought', 0)}\n"
            f"  rsi_oversold          : {g.get('rsi_oversold', 0)}\n"
            f"  rsi_extreme_supprsd   : {g.get('rsi_extreme_suppressed', 0)}\n"
            f"  bayes_floor_veto      : {g.get('bayes_floor_veto', 0)}\n"
            f"  consecutive_loss_halt : {g.get('consecutive_loss_halt', 0)}\n"
            f"  zscore_warmup         : {g.get('zscore_warmup', 0)}\n"
            f"  post_trade_cooldown   : {g.get('post_trade_cooldown', 0)}\n"
            f"  cascade_cooldown      : {g.get('cascade_cooldown', 0)}\n"
            f"  regime_no_edge        : {g.get('regime_no_edge', 0)}\n"
            f"  htf_counter_trend     : {g.get('htf_counter_trend', 0)}\n"
            f"  funding_blocks        : {g.get('funding_blocks_long', 0) + g.get('funding_blocks_short', 0)}\n"
            f"  ulis_veto             : {g.get('ulis_veto', 0)}\n"
            f"  ulis_alignment_fail   : {g.get('ulis_alignment_fail', 0)}\n"
            f"  confidence_below_thr  : {g.get('confidence_below_threshold', 0)}\n"
            f"  candle_gate_expired   : {g.get('candle_gate_expired', 0)}\n"
            f"  micro_confirms_fail   : {g.get('micro_confirms_failed', 0)}\n"
            f"  sweep_confirms_fail   : {g.get('sweep_confirms_failed', 0)}\n"
            f"  fee_geometry          : {g.get('fee_geometry', 0)}\n"
            f"  signal_none           : {g.get('signal_none', 0)}\n"
            f"  cvd_divergence_veto   : {g.get('cvd_divergence_veto', 0)}\n"
            f"  derivatives_veto      : {g.get('derivatives_veto', 0)}\n"
            f"  throughput_thin       : {g.get('throughput_thin', 0)}\n"
            f"  ───────────────────────\n"
            f"  total rejections      : {total}\n"
            f"  total passed          : {passed}\n"
            f"  pass rate             : {passed/max(1, passed+total):.1%}\n"
            f"  last_confidence       : {confidence:.2%}"
        )
        GATE_STATS_LAST_LOG = now


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 1 — FEATURE ENGINE HELPERS ─────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _parse_walls(all_walls_str: Optional[str]) -> Tuple[List[float], List[float]]:
    if not all_walls_str:
        return [], []
    buy_walls, sell_walls = [], []
    for part in all_walls_str.split(";"):
        m = re.match(r"\s*(BUY|SELL)@([\d.]+)", part.strip())
        if m:
            (buy_walls if m.group(1) == "BUY" else sell_walls).append(float(m.group(2)))
    buy_walls.sort(reverse=True)
    sell_walls.sort()
    return buy_walls, sell_walls


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 2 — MARKET REGIME DETECTION ────────────────────────────────
# ══════════════════════════════════════════════════════════════════════


def _htf_trend(candle_history: list) -> str:
    """
    Derive a higher-timeframe (4H) trend direction from the last 16 15m candles.
    16 × 15m = 4 hours.  Returns 'BULL', 'BEAR', or 'NEUTRAL'.

    Blocks counter-trend entries:
    - HTF = BULL  →  block SELL / MEAN_REVERSAL_SHORT
    - HTF = BEAR  →  block BUY  / MEAN_REVERSAL_LONG
    - HTF = NEUTRAL → allow either direction
    """
    if len(candle_history) < 16:
        return "NEUTRAL"
    # The open of the 16th candle ago represents the start of the 4H window
    window_open = float(candle_history[-16]["open"])
    htf_close = float(candle_history[-1]["close"])
    if window_open <= 0:
        return "NEUTRAL"
    change_pct = (htf_close - window_open) / window_open
    # HIGH-3 FIX: 0.2% was too tight (BTC moves that in minutes).
    # 0.5% over 4H is a meaningful, non-noise directional move.
    if change_pct >  0.005:   # +0.5% over 4H = clear uptrend
        return "BULL"
    if change_pct < -0.005:   # -0.5% over 4H = clear downtrend
        return "BEAR"
    return "NEUTRAL"


def _vpoc_confidence_boost(price: float, vpoc: Optional[float], direction: str) -> float:
    """
    Return a confidence addend (+0.0 to +0.06) based on how close the entry
    price is to the Volume Point of Control (VPOC — the session's highest-volume
    price level, acting as a mean-reversion magnet).

    Logic:
    - BUY near/below VPOC → buyer is entering at a proven value area → boost
    - SELL near/above VPOC → seller is fading from a proven resistance → boost
    - Entry far from VPOC on the wrong side → no boost (returns 0.0)
    """
    if vpoc is None or price <= 0:
        return 0.0
    dist_pct = abs(price - vpoc) / price   # distance as fraction of price
    is_long  = direction in ("BUY", "MEAN_REVERSAL_LONG")

    aligned = (is_long and price <= vpoc * 1.002) or (not is_long and price >= vpoc * 0.998)
    if not aligned:
        return 0.0

    # Graduated boost: 0.06 when at VPOC, falling to 0 at 0.3% away
    if dist_pct <= 0.003:
        return round(0.06 * (1.0 - dist_pct / 0.003), 4)
    return 0.0


async def _derivatives_gate(direction: str, deriv_context: dict) -> tuple[bool, str]:
    """
    Pre-entry veto using free institutional signals.
    Returns (should_trade: bool, reason: str).
    Called inside _compute_signal after strategy selection, before Bayesian.

    GEX (Gamma Exposure) upgrades sweep detection:
      - GEX > 0 (PIN zone): dealer hedging dampens price → fade the sweep
      - GEX < 0 (SWEEP zone): dealer hedging amplifies price → confirm the sweep
      - OI-only sweep detection misclassified ~30-40% of zones (Dr. Klint critical finding).
      - Now upgraded to use GEX classification before passing sweep alerts to ULIS.
    """
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    oi    = deriv_context.get("open_interest", {})
    tt    = deriv_context.get("top_traders", {})
    opts  = deriv_context.get("options", {})
    flow  = deriv_context.get("taker_flow", {})
    oi_v  = deriv_context.get("oi_velocity_divergence", {})

    crowd          = tt.get("crowd_signal", "NEUTRAL")
    opts_signal    = opts.get("options_signal", "NEUTRAL")
    oi_collapsing  = oi.get("oi_collapsing", False)
    taker_imbalance = flow.get("taker_imbalance", 0.0)
    gex_signal     = opts.get("gex_signal", "NEUTRAL")
    oi_div_signal  = oi_v.get("signal", "INCONCLUSIVE")
    oi_div_accel   = oi_v.get("acceleration", 0.0)

    veto_reasons = []

    # VETO 1: Top traders crowded in SAME direction as our trade = no edge
    # 70%+ of whales already positioned same as us = crowded trade, squeeze risk
    if is_long and crowd == "CROWDED_LONG":
        veto_reasons.append("Top traders 70%+ LONG — crowded, no squeeze potential")
    if not is_long and crowd == "CROWDED_SHORT":
        veto_reasons.append("Top traders 70%+ SHORT — crowded, no squeeze potential")

    # VETO 2: Options market in FEAR while we want to buy
    # Institutions paying for downside puts = they expect lower prices
    if is_long and opts_signal == "FEAR":
        veto_reasons.append("Options FEAR — institutions hedging downside aggressively")

    # VETO 3: OI collapsing = deleveraging, not new trend forming
    if oi_collapsing:
        oi_mom = oi.get("oi_momentum_1h", 0.0)
        veto_reasons.append(f"OI collapsing {oi_mom:.1f}% in 1h — deleveraging, no new trend")

    # VETO 4: GEX PIN zone — dealer hedging will dampen price movement
    # Fade the sweep in PIN zones (positive gamma = mean-reversion expected)
    # This is the GEX upgrade: OI-only sweep detection misclassified 30-40% of zones
    if gex_signal == "PIN":
        total_gex = opts.get("total_gex", 0.0)
        veto_reasons.append(
            f"GEX PIN zone (total_gex={total_gex:.1f}) — dealer hedging active, "
            "sweep likely to reverse. Do NOT enter as sweep follower."
        )

    # BOOST: GEX SWEEP zone — dealer amplification confirms sweep
    # When GEX < -5 the market is in negative gamma regime where sweeps extend
    boosts = []
    if is_long and crowd == "CROWDED_SHORT":
        boosts.append("SHORT SQUEEZE SETUP — whales crowded short")
    if not is_long and crowd == "CROWDED_LONG":
        boosts.append("LONG SQUEEZE SETUP — whales crowded long")
    if abs(taker_imbalance) > 0.3:
        direction_match = (is_long and taker_imbalance > 0) or (not is_long and taker_imbalance < 0)
        if direction_match:
            boosts.append(f"Taker flow confirms: imbalance={taker_imbalance:.2f}")

    # OI Velocity Divergence boost — highest mechanistic grounding (Dr. Klint priority 1)
    if oi_div_signal == "CONTINUATION":
        boosts.append(
            f"OI Velocity: CONTINUATION — price confirmed by new OI money "
            f"(vel={oi_v.get('oi_velocity', 0):+.2f}%, accel={oi_div_accel:+.3f}%)"
        )
    elif oi_div_signal == "EXHAUSTION_WARNING":
        boosts.append(
            f"OI Velocity: EXHAUSTION WARNING — accel={oi_div_accel:+.3f}% "
            "(1-2 candle early warning, position building reversal risk)"
        )
    elif oi_div_signal == "EXHAUSTION":
        boosts.append(
            f"OI Velocity: EXHAUSTION — price moved without OI backing, "
            "squeeze likely exhausted (d=+1)"
        )

    if veto_reasons:
        return False, " | ".join(veto_reasons)

    return True, " | ".join(boosts) if boosts else "No institutional conflict"


# ══════════════════════════════════════════════════════════════════════
# ── HMM REGIME CLASSIFIER (3-state, pure numpy) ───────────────────────
# ══════════════════════════════════════════════════════════════════════

class _HMMRegimeClassifier:
    """
    4-state Gaussian Hidden Markov Model regime detector.
    Upgraded from 3-state (Jun 2026, Dr. Klint spec):
      - State 0 = RANGE     — low ATR, low |Z|, quiet tape, low Amihud
      - State 1 = TREND     — medium ATR, high Z, SCREAMING, LOW Amihud (vol-supported)
      - State 2 = SQUEEZE   — medium-high ATR, high Z, SCREAMING, HIGH Amihud+KE (vacuum)
      - State 3 = VOLATILE  — high ATR, low Z, erratic, mixed Amihud

    Features (per observation, 5D):
        f0 = atr_pct       (0 – 0.03)
        f1 = abs(z_score)  (0 – 4)
        f2 = tape_binary   (0 = NORMAL, 1 = SCREAMING)
        f3 = amihud_rank   (0 – 1)  — log Amihud percentile rank (linear variant)
        f4 = t_kinetic     (0 – 1)  — log KE percentile rank (squared variant)

    The Amihud features (f3, f4) are what geometrically separate SQUEEZE from TREND.
    """

    # --- Emission means (μ) per state × feature -----------------------
    # Spec seeds from Dr. Klint Section 2.4
    # Dim order: [atr_pct, |z|, tape_bin, atr_rank]
    # P1 AUDIT FIX v3 (Jun 2026) — 1-year BTC 15m data, hmmlearn GaussianHMM(3, diag)
    # 4D features matching classify() obs vector: [atr_pct, |z|, tape_bin, atr_rank]
    # RANGE: low ATR% (0.21%), moderate Z; TREND: high Z + tape surge; VOLATILE: elevated ATR%
    # Clipping ranges: atr_pct∈[0,0.03], |z|∈[0,4], tape∈{0,1}, atr_rank∈[0,1]
    _MU = np.array([
        [0.002143, 1.110481, 0.00, 0.198910],   # RANGE
        [0.003256, 1.857669, 1.00, 0.553613],  # TREND — high Z + tape surge (vol spike)
        [0.003691, 1.020432, 0.00, 0.652134],  # VOLATILE — elevated ATR%, moderate Z
    ], dtype=float)
    _SIGMA = np.array([
        [0.001650, 0.758794, 0.001456, 0.119213],  # RANGE
        [0.005409, 0.922987, 0.005285, 0.269366],  # TREND
        [0.001988, 0.682877, 0.001664, 0.159848],  # VOLATILE
    ], dtype=float)

    # --- 3-state transition matrix (rows = from-state, cols = to-state) ---
    # Calibrated from hmmlearn GaussianHMM on 1 year BTC 15m data (Jun 2026, 4D features)
    # LIQUIDITY is NOT in the HMM — it is detected independently via wall-proximity
    # in _detect_regime() and takes precedence over HMM output when near a wall.
    _A = np.array([
        [0.9624, 0.0310, 0.0066],   # RANGE — high persistence
        [0.2379, 0.2821, 0.4800],   # TREND — bleeds to VOLATILE on sustained moves
        [0.0255, 0.0304, 0.9441],   # VOLATILE — strong self-loop (clustered volatility)
    ], dtype=float)

    # --- Initial state distribution ------------------------------------
    _PI = np.array([0.50, 0.30, 0.20], dtype=float)

    # State labels: 3 HMM states; LIQUIDITY is wall-detection, not HMM
    _LABELS = ["RANGE", "TREND", "VOLATILE"]

    # Confidence & hysteresis thresholds
    MIN_CONFIDENCE        = 0.60
    HYSTERESIS_CANDLES    = 2     # FIXED: 30-min lag (was 3 = 45-min lag)
    FAST_TRACK_CONFIDENCE = 0.88  # NEW: 1-candle commit at very high confidence

    def __init__(self, window: int = 60, update_every: int = 50):
        self._window    = window
        self._update_n  = update_every
        self._obs_buf   = deque(maxlen=200)  # circular feature history
        self._cycle     = 0           # count calls since last param update
        # Mutable copies so online-update can adjust them
        self._mu    = self._MU.copy()
        self._sigma = self._SIGMA.copy()
        self._A     = self._A.copy()
        self._param_source = "hardcoded defaults"
        self._load_calibrated_params()
        self._online_update_enabled = True   # Calibrated via hmm_calibrate (Fix 4)
        self._n_trades_since_update = 0      # P1-3: count live trades; delay online HMM update until enough data
        self._min_trades_before_update = 10  # require ≥10 live trades before first online update
        # Hysteresis state
        self._committed_regime = "RANGE"   # currently committed regime
        self._candidate_regime = "RANGE"   # regime the HMM is suggesting
        self._candidate_streak = 0         # consecutive candles suggesting candidate

        # Symbol-isolated persistence path so each coin's HMM state is independent
        _raw_sym = os.environ.get("BOT_SYMBOL", "BTC/USDT")
        _safe_sym = _raw_sym.replace("/", "").replace(":", "").replace("-", "").upper()
        _default_hmm_path = f"/tmp/quad_hmm_state_{_safe_sym}.json"
        self._persist_path = os.environ.get("HMM_STATE_PATH", _default_hmm_path)
        self._fs_doc_id = f"hmmEngine_{_safe_sym}"  # e.g. hmmEngine_BTCUSDT
        self._load_state()

    def _load_calibrated_params(self):
        """Load production HMM emissions/transition matrix from bot/hmm_params.json."""
        import json
        from pathlib import Path

        path = Path(os.environ.get(
            "HMM_PARAMS_PATH",
            str(Path(__file__).with_name("hmm_params.json"))
        ))
        if not path.exists():
            logger.warning(f"[HMM] Calibrated params not found at {path}; using hardcoded defaults.")
            return
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            mu = np.array(data.get("mu"), dtype=float)
            sigma = np.array(data.get("sigma"), dtype=float)
            transmat = np.array(data.get("transmat", self._A), dtype=float)
            labels = data.get("labels", self._LABELS)
            if mu.shape != self._MU.shape:
                raise ValueError(f"mu shape {mu.shape} != expected {self._MU.shape}")
            if sigma.shape != self._SIGMA.shape:
                raise ValueError(f"sigma shape {sigma.shape} != expected {self._SIGMA.shape}")
            if transmat.shape != self._A.shape:
                raise ValueError(f"transmat shape {transmat.shape} != expected {self._A.shape}")
            if list(labels) != list(self._LABELS):
                raise ValueError(f"labels {labels} != expected {self._LABELS}")
            row_sums = transmat.sum(axis=1, keepdims=True)
            if np.any(row_sums <= 0) or not np.all(np.isfinite(transmat)):
                raise ValueError("transition matrix must be finite with positive row sums")
            self._mu = mu
            self._sigma = np.maximum(sigma, 1e-6)
            transmat = transmat / row_sums
            max_persistence = float(np.clip(
                float(os.environ.get("HMM_MAX_STATE_PERSISTENCE", "0.90")),
                0.50,
                0.99,
            ))
            for i in range(transmat.shape[0]):
                if transmat[i, i] > max_persistence:
                    excess = transmat[i, i] - max_persistence
                    transmat[i, i] = max_persistence
                    off_idx = [j for j in range(transmat.shape[1]) if j != i]
                    off_sum = float(transmat[i, off_idx].sum())
                    if off_sum > 0:
                        transmat[i, off_idx] += excess * (transmat[i, off_idx] / off_sum)
                    else:
                        transmat[i, off_idx] += excess / len(off_idx)
            self._A = transmat / transmat.sum(axis=1, keepdims=True)
            meta = data.get("meta", {})
            source_bits = [str(path)]
            if meta.get("symbol"):
                source_bits.append(f"symbol={meta['symbol']}")
            if meta.get("interval"):
                source_bits.append(f"interval={meta['interval']}")
            if meta.get("observations"):
                source_bits.append(f"n={meta['observations']}")
            self._param_source = " | ".join(source_bits)
            logger.info(f"[HMM] Calibrated params loaded: {self._param_source}")
        except Exception as e:
            logger.error(f"[HMM] Failed to load calibrated params from {path}: {e}. Using hardcoded defaults.")

    def _save_state(self):
        import threading
        import json
        import time
        data = {
            "mu": self._mu.tolist(),
            "sigma": self._sigma.tolist(),
            "transmat": self._A.tolist(),
            "param_source": self._param_source,
            "saved_at": time.time(),
        }
        existing = getattr(self, "_fs_write_thread", None)
        if existing is not None and existing.is_alive():
            logger.debug("[HMM] Previous Firestore write still in progress — skipping this save.")
            return

        def _write_firestore(payload: dict) -> None:
            try:
                import json as _json
                fs_payload = payload.copy()
                fs_payload["mu"] = _json.dumps(fs_payload.get("mu", []))
                fs_payload["sigma"] = _json.dumps(fs_payload.get("sigma", []))
                fs_payload["transmat"] = _json.dumps(fs_payload.get("transmat", []))
                from bot.heartbeat import get_db
                db = get_db()
                if db is not None:
                    db.collection("botState").document(self._fs_doc_id).set(fs_payload)
                    logger.debug("[HMM] State saved to Firestore 💾")
            except Exception as e:
                logger.warning(f"[HMM] Firestore state save failed: {e}")

        self._fs_write_thread = threading.Thread(
            target=_write_firestore,
            args=(dict(data),),
            daemon=True,
            name="HMMEngine-FSWrite",
        )
        self._fs_write_thread.start()

        try:
            with open(self._persist_path, "w") as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning(f"[HMM] /tmp/ state cache write failed: {e}")

    def _load_state(self):
        import os
        import json
        import time
        load_persisted = os.environ.get("HMM_LOAD_PERSISTED_PARAMS", "false").strip().lower()
        if load_persisted not in {"1", "true", "yes", "on"}:
            logger.info(
                "[HMM] Persisted online params disabled; using calibrated params only "
                "(set HMM_LOAD_PERSISTED_PARAMS=true to restore Firestore/tmp state)."
            )
            return
        try:
            from bot.heartbeat import get_db
            db = get_db()
            if db is not None:
                doc = db.collection("botState").document(self._fs_doc_id).get()
                if doc.exists:
                    data = doc.to_dict()
                    mu_val = data.get("mu")
                    sig_val = data.get("sigma")
                    if isinstance(mu_val, str): mu_val = json.loads(mu_val)
                    if isinstance(sig_val, str): sig_val = json.loads(sig_val)
                    self._mu = np.array(mu_val if mu_val is not None else self._MU.tolist())
                    self._sigma = np.array(sig_val if sig_val is not None else self._SIGMA.tolist())
                    logger.info("[HMM] ✅ State loaded from Firestore")
                    return
        except Exception as e:
            logger.warning(f"[HMM] Firestore state load failed: {e} — falling back to /tmp/")

        try:
            if os.path.exists(self._persist_path):
                with open(self._persist_path) as f:
                    data = json.load(f)
                self._mu = np.array(data.get("mu", self._MU.tolist()))
                self._sigma = np.array(data.get("sigma", self._SIGMA.tolist()))
                logger.info("[HMM] ⚠️ State loaded from /tmp/")
                return
        except Exception as e:
            pass

    # ------------------------------------------------------------------
    def _gaussian_log_prob(self, obs: np.ndarray) -> np.ndarray:
        """Log P(obs | state) for all 3 HMM states. obs shape = (F,)."""
        log_probs = np.zeros(3)
        for s in range(3):
            diff    = obs - self._mu[s]
            log_p   = -0.5 * np.sum((diff / np.maximum(self._sigma[s], 1e-9)) ** 2)
            log_p  -= np.sum(np.log(np.maximum(self._sigma[s], 1e-9)))
            log_probs[s] = log_p
        return log_probs

    # ------------------------------------------------------------------
    @staticmethod
    def _logsumexp(a: np.ndarray) -> float:
        """Numerically stable log-sum-exp."""
        a_max = np.max(a)
        if not np.isfinite(a_max):
            return a_max
        return a_max + np.log(np.sum(np.exp(a - a_max)))

    # ------------------------------------------------------------------
    def _forward(self, obs_seq: np.ndarray) -> np.ndarray:
        """
        Scaled forward algorithm — returns posterior P(state_T | obs_1...T).

        Unlike Viterbi (which gives the single most-likely STATE SEQUENCE),
        the forward algorithm gives the marginal probability of each state
        at the final timestep, integrating over all possible state paths.
        This is mathematically correct for regime uncertainty quantification.
        """
        T    = len(obs_seq)
        n_s  = 3
        log_A  = np.log(np.maximum(self._A, 1e-300))
        log_pi = np.log(np.maximum(self._PI, 1e-300))

        # log_alpha[t, s] = log P(o_1...o_t, state_t = s)
        log_alpha = np.full((T, n_s), -np.inf)
        log_alpha[0] = log_pi + self._gaussian_log_prob(obs_seq[0])

        for t in range(1, T):
            log_emit = self._gaussian_log_prob(obs_seq[t])
            for j in range(n_s):
                # Sum over all possible previous states (marginalise)
                log_alpha[t, j] = self._logsumexp(
                    log_alpha[t - 1] + log_A[:, j]
                ) + log_emit[j]

        # Normalise to get posterior at time T
        log_evidence = self._logsumexp(log_alpha[-1])
        log_posterior = log_alpha[-1] - log_evidence
        posterior = np.exp(log_posterior)

        # Safety: ensure sums to 1.0 (numerical precision)
        posterior = np.nan_to_num(posterior, nan=0.0, posinf=0.0, neginf=0.0)
        posterior = np.maximum(posterior, 0.0)
        total = posterior.sum()
        if total > 0:
            posterior /= total
        else:
            posterior = np.array([0.50, 0.30, 0.20])  # fallback to prior

        return posterior

    # ------------------------------------------------------------------
    def _viterbi(self, obs_seq: np.ndarray) -> np.ndarray:
        """Pure-numpy Viterbi — returns most-likely state sequence."""
        T, _   = obs_seq.shape
        n_s    = 3
        log_A  = np.log(np.maximum(self._A, 1e-300))
        log_pi = np.log(np.maximum(self._PI, 1e-300))

        delta     = np.full((T, n_s), -np.inf)
        psi       = np.zeros((T, n_s), dtype=int)

        delta[0]  = log_pi + self._gaussian_log_prob(obs_seq[0])

        for t in range(1, T):
            log_emit = self._gaussian_log_prob(obs_seq[t])
            for j in range(n_s):
                trans    = delta[t - 1] + log_A[:, j]
                psi[t, j]   = int(np.argmax(trans))
                delta[t, j] = np.max(trans) + log_emit[j]

        # Back-track
        states      = np.zeros(T, dtype=int)
        states[-1]  = int(np.argmax(delta[-1]))
        for t in range(T - 2, -1, -1):
            states[t] = psi[t + 1, states[t + 1]]
        return states

    # ------------------------------------------------------------------
    def _online_update(self):
        """
        Lite Baum-Welch: re-estimate μ and σ from recent observations
        using soft-assignment (posterior from Viterbi hard assignment).
        Only runs every `update_every` cycles to avoid overhead.
        """
        if not self._online_update_enabled:
            return
        if len(self._obs_buf) < 20:
            return
        # P1-3: Don't pollute HMM parameters with online updates until we have
        # at least _min_trades_before_update live trades worth of observations.
        # This prevents a cold-start run of lucky/unlucky trades from distorting
        # the calibrated regime means/sigma that we worked hard to get right.
        if self._n_trades_since_update < self._min_trades_before_update:
            logger.debug(
                f"[HMM] Skipping online update — only {self._n_trades_since_update}/{self._min_trades_before_update} trades since last update."
            )
            return
        obs = np.array(list(self._obs_buf)[-self._window:], dtype=float)
        states = self._viterbi(obs)
        for s in range(3):
            mask = states == s
            if mask.sum() >= 3:
                self._mu[s]    = obs[mask].mean(axis=0)
                self._sigma[s] = obs[mask].std(axis=0)
                self._sigma[s] = np.maximum(self._sigma[s], 1e-4)
                self._n_trades_since_update = 0
                logger.info(f"[HMM] Online update complete — μ={self._mu[s]}, σ={self._sigma[s]}")
                
        self._save_state()

    # ------------------------------------------------------------------
    def classify(self, atr_pct: float, z_score: float, tape: str,
                 atr_pct_rank: float = 0.5,
                 amihud_rank: float = 0.5,
                 t_kinetic: float = 0.5) -> dict:
        """
        Main entry: add one observation and return regime probability vector.

        Args:
            atr_pct:      ATR as fraction of price (e.g. 0.007 = 0.7%)
            z_score:      VWAP Z-score
            tape:         'SCREAMING' | 'NORMAL'
            atr_pct_rank: ATR percentile rank in 30-day rolling window [0,1]
            amihud_rank:  Amihud illiquidity percentile rank [0,1] — 0=liquid, 1=vacuum
            t_kinetic:    Kinetic-energy variant percentile rank [0,1] — cascade amplifier

        Returns dict with:
            regime:     str   — committed regime label (with hysteresis)
            confidence: float — posterior probability of the committed regime
            p_range:    float — P(RANGE | observations)
            p_trend:    float — P(TREND | observations)
            p_volatile: float — P(VOLATILE | observations)
            raw_regime: str   — instantaneous HMM output (before hysteresis)
        """
        obs = np.array([
            float(np.clip(atr_pct,       0.0,  0.03)),   # f0: atr_pct (0-3% range, matches calibration)
            float(np.clip(abs(z_score),  0.0,  4.0)),     # f1: |z| raw scale (matches calibration)
            1.0 if tape == "SCREAMING" else 0.0,        # f2: tape binary
            float(np.clip(atr_pct_rank,  0.0,  1.0)),    # f3: atr percentile rank
        ], dtype=float)
        # NOTE: amihud_rank and t_kinetic are intentionally excluded (audit v3 P1).
        # The calibrated 4D emission matrices (_MU/_SIGMA) do not include them.
        # They are still passed as args and surfaced in metrics for future use.
        # Once `python -m bot.hmm_calibrate --years 2` is run with 5D features,
        # the obs vector can be restored to 5D by uncommenting the two lines below.

        self._obs_buf.append(obs)
        self._cycle += 1

        if self._cycle % self._update_n == 0:
            self._online_update()

        # Need at least 3 observations for a meaningful forward pass
        n_obs = min(len(self._obs_buf), self._window)
        seq   = np.array(list(self._obs_buf)[-n_obs:], dtype=float)

        if len(seq) < 3:
            # Fall back to simple thresholds while warming up
            if atr_pct > 0.01 and tape == "SCREAMING":
                raw = "TREND"
            elif abs(z_score) > 2.5:
                raw = "NEUTRAL"
            else:
                raw = "RANGE"
            return {
                "regime": raw, "confidence": 0.50,
                "p_range": 0.25, "p_trend": 0.25, "p_volatile": 0.25,
                "raw_regime": raw,
            }

        # ── Forward algorithm: posterior probability vector ────────────
        posterior = self._forward(seq)
        posterior_temp = float(os.environ.get("HMM_POSTERIOR_TEMPERATURE", "1.35"))
        if posterior_temp > 1.0:
            posterior = np.power(np.maximum(posterior, 1e-6), 1.0 / posterior_temp)
            posterior = posterior / np.maximum(posterior.sum(), 1e-12)
        best_state = int(np.argmax(posterior))
        raw_label  = self._LABELS[best_state]
        raw_conf   = float(posterior[best_state])

        # ── Hysteresis: 3-candle debounce on regime transitions ──────
        # Prevents flickering at regime boundaries (e.g. TREND→RANGE→TREND
        # on consecutive cycles when the posterior is near 50/50).
        if raw_label == self._candidate_regime:
            self._candidate_streak += 1
        else:
            self._candidate_regime = raw_label
            self._candidate_streak = 1

        # Commit the new regime only if it's been consistent for N candles
        # AND meets the confidence threshold
        _fast = (raw_conf >= self.FAST_TRACK_CONFIDENCE
                 and self._candidate_regime != self._committed_regime)
        _normal = (self._candidate_streak >= self.HYSTERESIS_CANDLES
                   and raw_conf >= self.MIN_CONFIDENCE
                   and self._candidate_regime != self._committed_regime)

        if _fast or _normal:
            old = self._committed_regime
            self._committed_regime = self._candidate_regime
            logger.info(
                f"[HMM] Regime TRANSITION ({'FAST' if _fast else 'normal'}): "
                f"{old} → {self._committed_regime} "
                f"(conf={raw_conf:.1%}, streak={self._candidate_streak})"
            )

        # The committed regime's confidence is its actual posterior probability
        committed_idx = self._LABELS.index(self._committed_regime)
        committed_conf = float(posterior[committed_idx])

        logger.debug(
            f"[HMM] raw={raw_label}({raw_conf:.0%}) committed={self._committed_regime}"
            f"({committed_conf:.0%}) streak={self._candidate_streak} | "
            f"P=[R:{posterior[0]:.0%} T:{posterior[1]:.0%} Sq:{posterior[2]:.0%}]"
        )

        return {
            "regime":      self._committed_regime,
            "confidence":  committed_conf,
            "p_range":     float(posterior[0]),
            "p_trend":     float(posterior[1]),
            "p_volatile":  float(posterior[2]),
            "raw_regime":  raw_label,
        }


# Module-level singleton — persists observations across cycles
_hmm_classifier = _HMMRegimeClassifier(window=60, update_every=500)   # FIX 4: was 200, 500 = ~12.5h at 15s cycles
_amihud_engine = AmihudEngine(window=500, min_buffer=100, hysteresis_n=3)

# Derivatives context for institutional signals
_derivatives_ctx = DerivativesContext(symbol=FEED_SYMBOL)



def _detect_regime(
    metrics: Dict[str, Any],
    buy_walls: List[float],
    sell_walls: List[float],
    quant,  # PHASE-1.3: Reference to QuantEngine for stateful tracking
    sweep: Optional[str] = None,
    feed_state=None,  # B1: raw order book for wall significance filter
) -> str:
    """
    HMM-based regime classifier with probabilistic output.

    Upgrades:
        1. Forward algorithm → P(state | all observations) instead of Viterbi hard label
        2. 70% confidence gate  → below threshold defaults to NEUTRAL
        3. 3-candle hysteresis  → regime change requires 3 consecutive agreements

    Wall proximity is checked FIRST as a hard override — being within 0.3%
    of a significant liquidity wall is always a LIQUIDITY regime regardless
    of ATR/Z/tape state (the HMM doesn't model wall proximity).

    PHASE-1.3: LIQUIDITY override now requires:
        - Nearest wall is within WALL_PROXIMITY of price
        - Wall size is ≥ 3× the median order book level (significant wall)
        - LIQUIDITY regime capped at 3 consecutive cycles without sweep confirmation

    Side-effect: injects regime_confidence, regime_probs into `metrics` dict
    so downstream consumers (Bayesian fusion, signal attribution) can use them.
    """

    price   = metrics["price"]
    z       = metrics["zScore"]
    tape    = metrics["tapeSpeed"]
    atr_pct = metrics["atr_pct"]

    # PHASE-1.3: New proximity threshold and significance filter
    atr_val = metrics.get("atr", price * 0.001)
    WALL_PROXIMITY = max(0.3 * atr_val / price, 0.003)
    near_wall = any(
        abs(price - w) / price <= WALL_PROXIMITY
        for w in (buy_walls[:1] + sell_walls[:1])
    )

    if near_wall:
        metrics["regime_confidence"] = 1.0
        metrics["regime_probs"] = {"RANGE": 0.0, "TREND": 0.0, "NEUTRAL": 0.0, "LIQUIDITY": 1.0}
        quant._liquidity_consecutive += 1
        if quant._liquidity_cap_cooldown > 0:
            quant._liquidity_cap_cooldown -= 1
            quant._liquidity_consecutive = 0
            logger.debug(f"[Regime] LIQUIDITY cooldown={quant._liquidity_cap_cooldown} — falling through to HMM")
        # P2 AUDIT FIX: Raise cap from 3 → 6 cycles.
        # At 15s analysis intervals, 3 cycles = 45s which is too aggressive —
        # the cap expires before meaningful sweep setups can form, causing
        # LIQUIDITY ↔ NEUTRAL oscillation near walls for hours.
        elif quant._liquidity_consecutive > 6 and sweep is None:
            logger.info("[Regime] LIQUIDITY cap reached — falling through to HMM")
            quant._liquidity_consecutive = 0
            quant._liquidity_cap_cooldown = 2
        else:
            return "LIQUIDITY"
    else:
        quant._liquidity_consecutive = 0
        quant._liquidity_cap_cooldown = 0

    # HMM classification → probability vector (5D obs: atr_pct, z, tape, amihud_rank, t_kinetic)
    atr_pct_rank = metrics.get("atr_pct_rank", 0.5)
    amihud_rank, t_kinetic = _amihud_engine.get_features()
    hmm_result = _hmm_classifier.classify(atr_pct, z, tape, atr_pct_rank, amihud_rank, t_kinetic)

    # HIGH-2 FIX: REGIME_REMAP removed — it was dead code (HMM state 2 is "NEUTRAL"
    # in _LABELS, never "VOLATILE"). Keeping it was a hazard: renaming the label
    # would silently reroute all high-vol periods to TREND strategy.
    regime = hmm_result["regime"]
    confidence = hmm_result["confidence"]

    # Inject probabilities into metrics for downstream observability
    metrics["regime_confidence"] = confidence
    metrics["regime_probs"] = {
        "RANGE":    hmm_result["p_range"],
        "TREND":    hmm_result["p_trend"],
        "VOLATILE": hmm_result["p_volatile"],
    }

    # ── 70% Confidence Gate ──────────────────────────────────────────
    # If the HMM isn't confident enough, fall back to NEUTRAL.
    # This prevents the bot from committing to TREND or MEAN_REVERSION
    # when the regime is genuinely ambiguous (e.g. P(TREND)=0.52).
    if confidence < _HMMRegimeClassifier.MIN_CONFIDENCE:
        logger.info(
            f"[HMM] Regime={hmm_result['raw_regime']}→NEUTRAL (conf={confidence:.0%} "
            f"< {_HMMRegimeClassifier.MIN_CONFIDENCE:.0%} gate) | "
            f"P=[R:{hmm_result['p_range']:.0%} T:{hmm_result['p_trend']:.0%} "
            f"V:{hmm_result['p_volatile']:.0%}]"
        )
        return "NEUTRAL"

    logger.info(
        f"[HMM] Regime={regime} conf={confidence:.0%} | "
        f"P=[R:{hmm_result['p_range']:.0%} T:{hmm_result['p_trend']:.0%} "
        f"V:{hmm_result['p_volatile']:.0%}] | "
        f"atr={atr_pct:.3%} z={z:.2f} tape={tape}"
    )
    return regime




# ══════════════════════════════════════════════════════════════════════
# ── STAGE 3 — LIQUIDITY SWEEP DETECTION ──────────────────────────────
# ══════════════════════════════════════════════════════════════════════

_SWEEP_BOOT_GRACE_CANDLES = 3   # ignore sweeps until this many LIVE candles arrive

def _detect_liquidity_sweep(metrics: Dict[str, Any],
                              buy_walls: List[float],
                              sell_walls: List[float],
                              candle_history: list,
                              feed_state) -> Optional[str]:
    if len(candle_history) < 2 or not sell_walls or not buy_walls:
        return None, None, None

    live_candle_count = getattr(feed_state, "_live_candle_count", 0)
    if live_candle_count < _SWEEP_BOOT_GRACE_CANDLES:
        logger.debug(
            f"[Sweep] Boot grace — {live_candle_count}/{_SWEEP_BOOT_GRACE_CANDLES} "
            "live candles received. Skipping sweep check."
        )
        return None, None, None

    price = metrics["price"]
    nearest_sell = sell_walls[0]
    nearest_buy  = buy_walls[0]

    # FIX (CandleGate root cause): Check LIVE candle (-1) FIRST, then prev (-2).
    # The original order [(-2,"prev"),(-1,"live")] always returned the prev candle's
    # stale open-time (25+ min old) even when the live candle also had the wick above
    # the wall. CandleGate then permanently blocked every entry as >945s stale.
    #
    # NEW RULE:
    #   Live candle sweep  -> sweep_ts = time.time()        (detected RIGHT NOW, age=0s)
    #   Prev candle sweep  -> sweep_ts = open_time + 900s   (approx when candle closed)
    # A live-candle sweep will ALWAYS pass the CandleGate freshness check.
    # FIX-P5: Per-candle sweep deduplication.
    # The same wick on the same candle was re-firing every 15s cycle (audit Problem 5).
    # Only allow one sweep signal per unique candle open-timestamp.
    for idx, label in [(-1, "live"), (-2, "prev")]:
        candle = candle_history[idx]
        candle_open_ts = float(candle.get("time", 0.0))

        if candle_open_ts > 0 and candle_open_ts == feed_state.last_fired_sweep_candle_ts:
            logger.debug(
                f"[Sweep] Dedup: candle ts={candle_open_ts:.0f} already fired. "
                "Suppressing repeat sweep from same candle."
            )
            continue

        if candle["high"] > nearest_sell and price < nearest_sell:
            logger.info(f"[Sweep] ABOVE_HIGHS at {nearest_sell:.2f} (wick={candle['high']:.2f})")
            sweep_ts = time.time() if label == "live" else float(candle["time"]) + 900.0
            feed_state.last_fired_sweep_candle_ts = candle_open_ts
            return "ABOVE_HIGHS", sweep_ts, float(candle["high"])

        if candle["low"] < nearest_buy and price > nearest_buy:
            logger.info(f"[Sweep] BELOW_LOWS at {nearest_buy:.2f} (wick={candle['low']:.2f})")
            sweep_ts = time.time() if label == "live" else float(candle["time"]) + 900.0
            feed_state.last_fired_sweep_candle_ts = candle_open_ts
            return "BELOW_LOWS", sweep_ts, float(candle["low"])

    return None, None, None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 4 — STRATEGY LAYER ──────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _strategy_trend(metrics: Dict[str, Any]) -> Optional[str]:
    bayes      = metrics["bayesianPosterior"]
    ofi        = metrics["ofi"]
    cvd        = metrics["cvd"]
    dominant   = metrics["tapeDominant"]
    tape_speed = metrics.get("tapeSpeed", "NORMAL")  # Added: differentiate SCREAMING vs NORMAL tape
    # Z-06 Log-Return Z (P2): velocity-based momentum confirmation
    z_ret = metrics.get("zScore_ret", 0.0)

    score = 0.0
    if bayes > 0.65:    score += 2.0
    elif bayes > 0.55:  score += 1.0
    elif bayes < 0.35:  score -= 2.0
    elif bayes < 0.45:  score -= 1.0

    # SIG-2 FIX: OFI thresholds updated from old ±100 scale to new tanh ±1 scale.
    # Old: ofi > 20 / ofi > 8 were unreachable (max OFI after pipeline = 1.0).
    if ofi > 0.3:        score += 1.5
    elif ofi > 0.15:     score += 0.75
    elif ofi < -0.3:     score -= 1.5
    elif ofi < -0.15:    score -= 0.75

    if cvd > 0:          score += 1.0
    elif cvd < 0:        score -= 1.0

    # Require SCREAMING tape for full +1.0 boost; NORMAL tape only earns +0.5
    # Prevents entering trend trades on weak marginal tape flow (Patch #8)
    if "BUY" in dominant:
        score += 1.0 if tape_speed == "SCREAMING" else 0.5
    elif "SELL" in dominant:
        score -= 1.0 if tape_speed == "SCREAMING" else 0.5

    # P2: Z-06 momentum velocity score modifier (max +/-0.75)
    if z_ret > 1.5:    score += 0.75
    elif z_ret > 0.8:  score += 0.30
    elif z_ret < -1.5: score -= 0.75
    elif z_ret < -0.8: score -= 0.30

    ofi_bull = ofi > 0.15
    cvd_bull = cvd > 0
    tape_bull = "BUY" in dominant
    micro_confirms_bull = sum([ofi_bull, cvd_bull, tape_bull])

    ofi_bear = ofi < -0.15
    cvd_bear = cvd < 0
    tape_bear = "SELL" in dominant
    micro_confirms_bear = sum([ofi_bear, cvd_bear, tape_bear])

    if score >= 1.5:
        # Intended LONG
        ofi_cvd_aligned = (ofi > 0.15 and cvd > 0)
        if micro_confirms_bull < 2 and score < 3.0 and not ofi_cvd_aligned:
            BOT_STATS["gate_stats"]["micro_confirms_failed"] = BOT_STATS["gate_stats"].get("micro_confirms_failed", 0) + 1
            logger.info(f"[TrendStrategy] score={score:+.2f} rejected LONG (micro_confirms_bull={micro_confirms_bull}/3, OFI+CVD not aligned)")
            return None
        return "BUY"
    
    if score <= -1.5:
        # Intended SHORT
        ofi_cvd_aligned = (ofi < -0.15 and cvd < 0)
        if micro_confirms_bear < 2 and score > -3.0 and not ofi_cvd_aligned:
            BOT_STATS["gate_stats"]["micro_confirms_failed"] = BOT_STATS["gate_stats"].get("micro_confirms_failed", 0) + 1
            logger.info(f"[TrendStrategy] score={score:+.2f} rejected SHORT (micro_confirms_bear={micro_confirms_bear}/3, OFI+CVD not aligned)")
            return None
        return "SELL"

    return None




def _strategy_mean_reversion(metrics: Dict[str, Any], z_threshold: float = 1.5) -> Optional[str]:
    """B4 FIX: Hard RSI floors — RSI < 45 for longs, RSI > 55 for shorts."""
    z = metrics.get("zScore", 0.0)
    rsi = metrics.get("rsi", 50.0)
    rsi_long_gate = 45.0   # B4: hard floor — only enter long when RSI < 45
    rsi_short_gate = 55.0  # B4: hard floor — only enter short when RSI > 55
    if z >= z_threshold and rsi > rsi_short_gate:
        return "MEAN_REVERSAL_SHORT"
    if z <= -z_threshold and rsi < rsi_long_gate:
        return "MEAN_REVERSAL_LONG"
    return None


def _strategy_liquidity_sweep(sweep: str, metrics: Dict[str, Any]) -> Optional[str]:
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    dominant = metrics["tapeDominant"]
    z        = metrics.get("zScore", 0.0)
    rsi      = metrics.get("rsi", 50.0)

    # P1-1 FIX: Z+RSI overbought/oversold gate on sweep entries.
    # The Apr-23 audit caught Z=+2.67, RSI=70 entering a BELOW_LOWS BUY sweep —
    # price was already statistically overbought; the sweep was a continuation,
    # not a reversal. Block these momentum-chase entries at the strategy level.
    if sweep == "BELOW_LOWS" and z > 2.0 and rsi > 65:
        logger.info(
            f"[SweepGate] BUY sweep BLOCKED — Z={z:.2f} RSI={rsi:.1f} "
            f"(price already overbought, sweep likely continuation not reversal)"
        )
        return None
    if sweep == "ABOVE_HIGHS" and z < -2.0 and rsi < 35:
        logger.info(
            f"[SweepGate] SELL sweep BLOCKED — Z={z:.2f} RSI={rsi:.1f} "
            f"(price already oversold, sweep likely continuation not reversal)"
        )
        return None

    # PHASE-2.1 FIX: Lower confirms threshold 3/3 → 2/3 for sweep entries.
    # 3/3 was too restrictive — all three micro-confirmations rarely align simultaneously
    # in live markets. 2/3 requires OFI+CVD+tape to agree, still enforcing quality.
    if sweep == "ABOVE_HIGHS":
        confirms = sum([
            ofi < -0.15,
            cvd < 0,
            "SELL" in dominant,
        ])
        if confirms >= 2:
            logger.info(f"[SweepStrat] SELL after ABOVE_HIGHS (confirms={confirms}/3)")
            return "SELL"

    if sweep == "BELOW_LOWS":
        confirms = sum([
            ofi > 0.15,
            cvd > 0,
            "BUY" in dominant,
        ])
        if confirms >= 2:
            logger.info(f"[SweepStrat] BUY after BELOW_LOWS (confirms={confirms}/3)")
            return "BUY"

    BOT_STATS["gate_stats"]["sweep_confirms_failed"] = BOT_STATS["gate_stats"].get("sweep_confirms_failed", 0) + 1
    return None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 5 — BAYESIAN SIGNAL FUSION ─────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _bayesian_fusion(metrics: Dict[str, Any], direction: str, regime: str, is_sweep: bool = False) -> float:
    """
    Stage 5: Macro Bayesian Logic
    Updates the prior confidence (from QuantEngine) with current directional evidence.
    Returns: Confidence score (0-1) in the *target signal direction*.

    Improvements over original:
    - Sweep Neutralizer is context-aware: higher floor when OFI/CVD confirm direction
    - Metrics extracted before Neutralizer (needed for context)
    - Mid-range OFI tier (5-10) now gets a partial boost (was binary ≥10 only)
    - CVD delta (rate-of-change) used: recovering CVD = bullish even when absolute CVD < 0
    - Scaled skew boost: gradual 0→15% as |skew| 0.05→0.30 (was never triggered at > 0.5)
    """
    # 1. Start with the prior confidence from Quant Engine Stage 4 (which is P-Bull)
    p_bull_prior = metrics.get("bayesianPosterior", 0.5)
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    # 2. Base Signal Confidence
    p_signal_prior = p_bull_prior if is_long else (1.0 - p_bull_prior)

    # --- Extract all market metrics before Sweep Neutralizer (needed for context check) ---
    ofi       = metrics.get("ofi", 0.0)
    cvd       = metrics.get("cvd", 0.0)
    cvd_delta = metrics.get("cvd_delta", 0.0)  # positive = buy pressure returning
    skew      = metrics.get("skewness", 0.0)
    dominant  = metrics.get("tapeDominant", "BALANCED")
    tape      = metrics.get("tapeSpeed", "NORMAL")
    rsi       = metrics.get("rsi", 50.0)

    # [FIX-P2] SWEEP NEUTRALIZER: Only apply confidence floor when Bayesian SUPPORTS direction.
    # The old unconditional floor of 0.55 overrode a Bayes=35% (bearish) BUY signal,
    # making the Bayesian posterior entirely decorative. The floor now only activates
    # when p_signal_prior >= 0.45 (i.e. Bayes is at least neutral on the direction).
    # A sub-0.45 Bayesian reading means the core signal says no — let it fail the threshold.
    if is_sweep:
        bayes_supports_direction = p_signal_prior >= 0.45
        if bayes_supports_direction:
            strong_confirm = (
                (is_long  and ofi >  0.3 and cvd_delta > 0) or
                (not is_long and ofi < -0.3 and cvd_delta < 0)
            )
            mild_confirm = (
                (is_long  and (ofi > 0.15 or cvd_delta > 0)) or
                (not is_long and (ofi < -0.15 or cvd_delta < 0))
            )
            if strong_confirm:
                p_signal_prior = max(0.65, p_signal_prior)   # strong OFI+CVD: floor at 0.65
            elif mild_confirm:
                p_signal_prior = max(0.58, p_signal_prior)   # mild confirm: floor at 0.58
            else:
                p_signal_prior = max(0.55, p_signal_prior)   # no extra confirm: floor at 0.55
        # If Bayesian < 0.45 (against direction), no floor — let it die at threshold

    # 3. Transform to Odds
    # Clip to avoid division by zero/infinity during transformation
    p_signal_prior = max(0.01, min(0.99, p_signal_prior))
    odds = p_signal_prior / (1.0 - p_signal_prior)

    # 4. Flow Multipliers (OFI/CVD/CVD-delta) — direction-support check
    # FIX: OFI is now in (-1, +1) range from tanh pipeline
    # Tiered OFI: >0.3 = strong, >0.15 = moderate. CVD delta captures recovering buy pressure
    flow_factor = 1.0
    if is_long:
        if ofi > 0.3:           flow_factor *= 1.25
        elif ofi > 0.15:         flow_factor *= 1.10   # Mid-range OFI: partial boost
        if cvd > 0:              flow_factor *= 1.15
        elif cvd_delta > 100:    flow_factor *= 1.08   # CVD recovering → mild bullish tailwind
        elif cvd_delta < -100:   flow_factor *= 0.90   # CVD accelerating down → headwind
    else:  # SHORT signal
        if ofi < -0.3:           flow_factor *= 1.25
        elif ofi < -0.15:         flow_factor *= 1.10   # Mid-range OFI: partial boost
        if cvd < 0:               flow_factor *= 1.15
        elif cvd_delta < -100:   flow_factor *= 1.08   # CVD dropping → mild bearish tailwind
        elif cvd_delta > 100:    flow_factor *= 0.90   # CVD recovering → headwind for shorts

    odds *= flow_factor

    # 5. Contextual Oscillator check — Regime-aware
    osc_factor = 1.0
    if regime == "TREND":
        # Trend continuation: RSI in signal direction confirms momentum
        if is_long and rsi > 65:       osc_factor *= 1.15
        elif not is_long and rsi < 35: osc_factor *= 1.15
    elif regime == "LIQUIDITY":
        # Sweep reversal: Overextended RSI supports a bounce/rejection
        if not is_long and rsi > 60:   osc_factor *= 1.60  # Overbought strongly helps SELL
        elif is_long and rsi < 40:     osc_factor *= 1.60  # Oversold strongly helps BUY

        # Momentum Chase Penalty: avoid entry if RSI already buried too deep.
        # SWEEP EXCEPTION: a BELOW_LOWS BUY sweep on overbought RSI is a REVERSAL,
        # not a momentum chase. The RSI overextension actually CONFIRMS the sweeping
        # condition. Skip this penalty entirely for sweep strategies.
        if not is_long and rsi < 32 and not is_sweep:   osc_factor *= 0.75
        if is_long and rsi > 68 and not is_sweep:       osc_factor *= 0.75

    odds *= osc_factor

    # 6. Tape Check
    if tape == "SCREAMING":
        if is_long and "BUY" in dominant:        odds *= 1.20
        elif not is_long and "SELL" in dominant: odds *= 1.20

    # 7. [IMPROVED] Scaled Skew boost — proportional to skew magnitude.
    # Old: binary cutoff at ±0.5 (never reached; max observed was 0.142).
    # New: scales from 1.0→1.15 as |skew| goes from 0.05→0.30.
    if abs(skew) >= 0.05:
        skew_magnitude = min(abs(skew), 0.30) / 0.30   # normalise 0→1, cap at |0.30|
        skew_boost     = 1.0 + skew_magnitude * 0.15   # 1.00 → 1.15
        if is_long and skew > 0:
            odds *= skew_boost
        elif not is_long and skew < 0:
            odds *= skew_boost

    # 7.5 MacroShield DXY Momentum Scalar
    dxy_mod = macro_shield.get_dxy_scalar(direction)
    odds *= dxy_mod

    # 8. Convert back to probability — MUST happen before regime blending (Fix #1: UnboundLocalError)
    p_final = odds / (1.0 + odds)

    # 8.5 A-2/A-3/A-4: HY Covariance + Lead-Lag adjustment, gated by Transfer Entropy
    macro_adj = macro_shield.get_macro_confidence_adj(direction)
    p_final = float(np.clip(p_final + macro_adj, 0.0, 1.0))

    # 9. [P1] Regime-Weighted Posterior Blending (HMM Spec Apr 2026)
    # P_adjusted = hmm_conf * regime_prior + (1 - hmm_conf) * base_posterior
    # High HMM confidence → trust per-regime historical win rate more.
    # Low HMM confidence  → trust raw Bayesian signal posterior more.
    regime_priors = metrics.get("_regime_priors", {})
    regime_samples = metrics.get("_regime_samples", {})
    if regime_priors and regime in regime_priors:
        n_regime_trades = int(regime_samples.get(regime, 0))
        MIN_REGIME_HISTORY = 10
        if n_regime_trades >= MIN_REGIME_HISTORY:
            hmm_conf = metrics.get("regime_confidence", 0.5)
            regime_prior = regime_priors[regime]
            p_final = float(np.clip(
                hmm_conf * regime_prior + (1.0 - hmm_conf) * p_final,
                0.0, 1.0
            ))

    return float(p_final)


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 6 ★ NEW — ULIS/ALDE CONFIRMATION GATE ──────────────────────
# ══════════════════════════════════════════════════════════════════════

def _apply_ulis_gate(
    metrics: Dict[str, Any],
    candle_history: list,
    feed_state,
    raw_direction: str,
    confidence: float,
) -> Tuple[bool, float, str]:
    """
    Run the ALDE+ULIS hybrid verdict engine as Stage 6.

    Returns:
        (should_trade, adjusted_confidence, ulis_verdict_str)
    """
    if not ULIS_GATE_ENABLED:
        return True, confidence, "GATE_DISABLED"

    ulis = compute_ulis_verdict(
        metrics=metrics,
        candles=candle_history,
        bids_dict=feed_state.bids,
        asks_dict=feed_state.asks,
    )

    verdict_str = ulis["verdict"]
    BOT_STATS["last_ulis"] = verdict_str

    # Veto conditions
    if not ulis["should_trade"]:
        logger.warning(f"[ULIS] VETO — {verdict_str} | {ulis['regime_label']}")
        return False, 0.0, verdict_str

    # Direction alignment check
    is_long = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    ulis_bullish = verdict_str in ("STRONG_LONG", "LONG")
    ulis_bearish = verdict_str in ("STRONG_SHORT", "SHORT")

    # Compare raw Bayesian posterior, not pipeline-accumulated confidence
    _raw_bayes = metrics.get("bayesianPosterior", 0.5)
    _bayes_long = _raw_bayes if is_long else (1.0 - _raw_bayes)
    if is_long and ulis_bearish:
        if _bayes_long >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(
                f"[ULIS] Bayesian override: raw_bayes_long={_bayes_long:.2%} "
                f">= {BAYES_OVERRIDE_THRESHOLD:.0%}. Proceeding with 8% confidence penalty."
            )
            confidence *= 0.92
        else:
            logger.warning(f"[ULIS] Direction conflict — bot=LONG, ULIS={verdict_str}. "
                           f"raw_bayes_long={_bayes_long:.2%} < threshold. Skipping.")
            return False, 0.0, verdict_str

    if not is_long and ulis_bullish:
        if (1.0 - _raw_bayes) >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(
                f"[ULIS] Bayesian override: raw_bayes_short={1.0-_raw_bayes:.2%} "
                f">= {BAYES_OVERRIDE_THRESHOLD:.0%}. Proceeding with 8% confidence penalty."
            )
            confidence *= 0.92
        else:
            logger.warning(f"[ULIS] Direction conflict — bot=SHORT, ULIS={verdict_str}. "
                           f"raw_bayes_short={1.0-_raw_bayes:.2%} < threshold. Skipping.")
            return False, 0.0, verdict_str


    # --- PROPER ALIGNMENT FRAMEWORK: Triple Alignment Gate ---
    rsi = metrics.get("rsi", 50.0)
    ofi = metrics.get("ofi", 0.0)
    atr_pct = metrics.get("atr_pct", 0.005)

    is_atr_extended = atr_pct > 0.0035  # Typically >0.35% in 15m is massively extended

    # ULIS Triple Alignment Gate — directionally aware RSI check.
    #
    # FIX: Red light fires only when RSI contradicts the signal direction:
    #   BUY  → red light if RSI > 75  (overbought — don't chase)
    #   SELL → red light if RSI < 25  (oversold  — don't chase)
    # RSI in the middle zone or confirming direction = no red light.
    # FIX: OFI is now in (-1, +1) range from tanh pipeline
    if is_long:
        rsi_valid = rsi <= 75      # Block overbought BUY-chasing only
        ofi_valid = ofi > -0.15   # Block only if OFI strongly bearish
    else:
        rsi_valid = rsi >= 25     # Block oversold SELL-chasing only
        ofi_valid = ofi < 0.15     # Block only if OFI strongly bullish

    red_lights = 0
    if not rsi_valid: red_lights += 1
    if not ofi_valid: red_lights += 1
    if is_atr_extended: red_lights += 1

    if red_lights >= 2:
        BOT_STATS["gate_stats"]["ulis_alignment_fail"] = BOT_STATS["gate_stats"].get("ulis_alignment_fail", 0) + 1
        logger.warning(f"[Alignment] GATE FAILED: {red_lights} Red Lights (RSI={rsi:.1f}, OFI={ofi:.1f}, ATR Extended={is_atr_extended})")
        return False, 0.0, f"{verdict_str} + Weak Alignment (R={red_lights})"
    elif red_lights == 1:
        confidence *= 0.90  # Reduced penalty from 20% to 10% (Patch #3)
        logger.info(f"[Alignment] 1 Red Light. Penalising confidence to {confidence:.2%}.")
        
    # Confidence adjustment
    # BREAKOUT_WATCH FIX: This verdict means momentum is building. If the
    # liquidity_vector aligns with the trade direction, it is corroborating
    # evidence → apply a small boost. Only penalise when it conflicts.
    boost = ulis["confidence_boost"]
    if verdict_str == "BREAKOUT_WATCH":
        vector_bullish = ulis["liquidity_vector"] > 0
        if (is_long and vector_bullish) or (not is_long and not vector_bullish):
            boost = +0.01   # Aligned: momentum building in our direction
        else:
            boost = -0.02   # Conflicting: momentum building against us
    adjusted = float(np.clip(confidence + boost, 0.0, 1.0))
    logger.info(
        f"[ULIS] PASS — {verdict_str} | "
        f"vector={ulis['liquidity_vector']:.3f} | "
        f"cascade={ulis['cascade_risk']:.2f} | "
        f"conf: {confidence:.2%} → {adjusted:.2%}"
    )
    return True, adjusted, verdict_str


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 4.5 — CVD DIVERGENCE GATE ──────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _apply_cvd_divergence_gate(
    raw_direction: str,
    metrics: Dict[str, Any],
    current_confidence: float,
) -> Tuple[float, Optional[str]]:
    """
    Stage 4.5: CVD Divergence Gate — Institutional Alpha v2.0
    Sits between Strategy (Stage 4) and Bayesian Fusion (Stage 5).

    ── ROLE ────────────────────────────────────────────────────────────
    The ONLY gate in the pipeline that reads ACROSS candle boundaries.
    All other layers (OFI, tape, RSI) are single-snapshot.  This gate
    reads institutional footprint across 1–8 candles of history.

    ── OUTCOMES ────────────────────────────────────────────────────────

    1. CONFIRMING DIVERGENCE  — divergence direction agrees with trade
       → Confidence BOOST scaled by strength + volume confirmation
       → swing_extrema method receives additional +0.01 structural bonus

    2. OPPOSING DIVERGENCE    — divergence opposes trade direction
       → Confidence PENALTY scaled by strength
       → STRONG opposing + volume spike → HARD VETO (blocks trade)
         Veto threshold: strength ≥ 0.62 AND confirms ≥ 1 AND vol ≥ 1.4×

    3. NO DIVERGENCE / INSUFFICIENT DATA
       → Uncertainty-scaled penalty instead of flat -0.03
         penalty = 0.10 × (1 - n_snaps / MIN_VALID_SNAPS)
         MIN_VALID_SNAPS = 4  (1 hour of 15m candles)

         At n_snaps=0: penalty = -0.10  (completely blind)
         At n_snaps=2: penalty = -0.05  (partial data)
         At n_snaps=4: penalty =  0.00  (sufficient data, no penalty)
         At n_snaps>4: penalty = +0.00  (no reward for more data alone)

    ── VETO THRESHOLD JUSTIFICATION ───────────────────────────────────
    Veto fires when ALL THREE conditions hold:
        (a) strength ≥ 0.62  — EMA-Z normalised, age-weighted, vol-confirmed
        (b) confirms ≥ 1     — at least one confirming candle pair
        (c) vol_spike ≥ 1.4  — elevated volume at the divergence extreme

    Returns:
        (adjusted_confidence: float,  veto_reason: Optional[str])
        veto_reason is None when no veto is issued.
    """
    MIN_VALID_SNAPS = 2
    VETO_MIN_SNAPS  = 3   # Veto only fires when we have 3+ snapshots (1 prior pair + current)

    div = metrics.get("cvd_divergence", {})
    div_type    = div.get("type",              "NONE")
    div_str     = div.get("strength",           0.0)
    confirms    = div.get("candles_confirmed",   0)
    vol_spike   = div.get("vol_spike",           1.0)
    method      = div.get("detection_method",   "none")
    n_snaps     = div.get("n_snaps",             0)

    is_long  = raw_direction in ("BUY",  "MEAN_REVERSAL_LONG")
    is_short = raw_direction in ("SELL", "MEAN_REVERSAL_SHORT")

    if div_type == "NONE" or div_str < 0.28:
        if n_snaps >= MIN_VALID_SNAPS:
            penalty = 0.0
            reason  = f"No divergence (n={n_snaps} snaps, sufficient)"
        elif n_snaps == 1:
            penalty = 0.02
            reason  = f"CVD history thin (n=1) — minor uncertainty penalty"
        else:
            penalty = 0.04
            reason  = f"CVD history empty (n={n_snaps}) — uncertainty penalty"
        adjusted = max(0.0, current_confidence - penalty)
        logger.debug(f"[CVDGate] {reason} | conf {current_confidence:.2%} → {adjusted:.2%}")
        return adjusted, None

    confirming = (
        (is_long  and div_type == "BULLISH") or
        (is_short and div_type == "BEARISH")
    )
    opposing = (
        (is_long  and div_type == "BEARISH") or
        (is_short and div_type == "BULLISH")
    )

    if confirming:
        if div_str >= 0.65:
            boost = 0.07
        elif div_str >= 0.45:
            boost = 0.05
        else:
            boost = 0.03

        vol_bonus = 0.01 if vol_spike >= 1.40 else 0.0
        method_bonus = 0.01 if method == "swing_extrema" else 0.0

        total_boost = boost + vol_bonus + method_bonus
        _cvd_is_long = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
        if _cvd_is_long:
            adjusted = min(1.0, current_confidence + total_boost)
        else:
            adjusted = max(0.0, current_confidence - total_boost)

        logger.info(
            f"[CVDGate] ✅ CONFIRMING {div_type} | "
            f"strength={div_str:.3f} method={method} "
            f"confirms={confirms} vol={vol_spike:.2f}× | "
            f"boost={total_boost:.2%} → conf {current_confidence:.2%} → {adjusted:.2%}"
        )
        return adjusted, None

    if opposing:
        if (div_str    >= CVD_VETO_STRENGTH and
                confirms   >= 1            and
                vol_spike  >= CVD_VETO_VOL_SPIKE and
                n_snaps    >= VETO_MIN_SNAPS):

            veto_msg = (
                f"CVD DIVERGENCE VETO: {div_type} divergence opposes "
                f"{raw_direction} | "
                f"strength={div_str:.3f} method={method} "
                f"confirms={confirms} vol={vol_spike:.2f}× | "
                f"Institutional footprint contradicts entry direction."
            )
            logger.warning(f"[CVDGate] 🚫 {veto_msg}")
            return 0.0, veto_msg

        if div_str >= 0.50:
            penalty = 0.09
        elif div_str >= 0.40:
            penalty = 0.06
        else:
            penalty = 0.03

        if vol_spike >= 1.40:
            penalty = min(penalty + 0.02, 0.12)

        # FIX-CVD: In TREND regime (raw BUY/SELL signals) an opposing CVD
        # divergence is more likely a consolidation within the trend than a
        # genuine institutional reversal. The log showed the bot correctly
        # identified a SELL in a sustained BEAR TREND but a 9% CVD penalty
        # knocked confidence below the Bayes floor, blocking a valid trade
        # while price continued crashing. Halve soft penalty in TREND regime.
        # Hard VETO thresholds above are intentionally unchanged.
        if raw_direction in ("BUY", "SELL"):
            penalty = penalty * 0.5
            logger.debug(
                f"[CVDGate] TREND direction: opposing CVD penalty halved → {penalty:.2%}"
            )

        adjusted = max(0.0, current_confidence - penalty)
        logger.info(
            f"[CVDGate] ⚠️  OPPOSING {div_type} | "
            f"strength={div_str:.3f} method={method} "
            f"confirms={confirms} vol={vol_spike:.2f}× | "
            f"penalty={penalty:.2%} → conf {current_confidence:.2%} → {adjusted:.2%}"
        )
        return adjusted, None

    return current_confidence, None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 7 — RISK ENGINE ─────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _drawdown_adjusted_risk(equity: float, peak_equity: float, base_risk_pct: float) -> float:
    """
    Reduces risk percentage during drawdown. f_adj = base × (1 - DD)^1.5
    Floor: 0.4% (prevents sizing below exchange notional minimum).
    No adjustment when DD < 5% (below noise threshold).
    """
    if peak_equity <= 0:
        return base_risk_pct
    dd = max(0.0, (peak_equity - equity) / peak_equity)
    if dd < 0.05:
        return base_risk_pct
    f_adj = max(base_risk_pct * ((1.0 - dd) ** 1.5), 0.4)
    logger.info(
        f"[RiskEngine] DD={dd:.1%} → risk {base_risk_pct:.1%}→{f_adj:.1%} "
        f"(equity=${equity:.0f} peak=${peak_equity:.0f})"
    )
    return f_adj


def _risk_engine(
    direction: str,
    strategy_type: str,
    price: float,
    atr: float,
    buy_walls: List[float],
    sell_walls: List[float],
    sweep: Optional[str],
    sl_mult: float = 1.5,        # P0: regime-adaptive (default = NEUTRAL)
    tp_mult_ratio: float = 2.0,  # P0: regime-adaptive RR target
    candle_history: Optional[List[Dict[str, Any]]] = None,
    metrics: Optional[Dict[str, Any]] = None,  # BUG-4: needed for atr_pct_rank
    regime_p: Optional[Dict[str, Any]] = None,  # PHASE-3.2: needed for panic_threshold
    signal: Optional[Dict[str, Any]] = None,   # NEW: for sweep_wick access
) -> Tuple[float, float, float]:
    """
    ATR-based SL/TP calculator with regime-adaptive multipliers (P0).

    sl_mult and tp_mult_ratio are supplied from REGIME_PARAMS[regime]:
        RANGE:     SL=1.2×ATR, RR=1.8:1  → tight stops in quiet markets
        NEUTRAL:   SL=1.5×ATR, RR=2.0:1  → balanced default
        TREND:     SL=2.2×ATR, RR=2.5:1  → wide stops for trend volatility
        LIQUIDITY: SL=1.5×ATR, RR=2.0:1  → same as NEUTRAL
    """
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    tp_from_wall = (sell_walls[0] * 0.9995 if sell_walls else None) if is_long \
               else (buy_walls[0] * 1.0005 if buy_walls else None)

    def _calc_atr_from_candles(candles: list, period: int = 14) -> float:
        if len(candles) < period + 1:
            return 0.0
        trs = []
        for i in range(1, len(candles)):
            h = candles[i].get("high", 0)
            l = candles[i].get("low", 0)
            pc = candles[i - 1].get("close", 0)
            tr = max(h - l, abs(h - pc), abs(l - pc))
            trs.append(tr)
        if len(trs) < period:
            return float(np.mean(trs)) if trs else 0.0
        atr = float(np.mean(trs[:period]))
        for j in range(period, len(trs)):
            atr = (atr * (period - 1) + trs[j]) / period
        return atr

    # PHASE-3.1: Dual vol scaling — candle-based vol_ratio AND atr_pct_rank
    # atr_pct_rank is the 30-day rolling rank (0.0=quietest, 1.0=loudest).
    # High rank (panic) = tighten stops; Low rank (quiet) = relax stops slightly.
    atr_pct_rank = metrics.get("atr_pct_rank", 0.5) if metrics else 0.5
    if candle_history and len(candle_history) >= 20:
        recent_candles = list(candle_history)[-5:]
        baseline_candles = list(candle_history)[-20:]
        # FIX-P8: recent_atr always returned 0.0 because length 5 is < period+1 (15).
        # We must explicitly set period=4 for the 5-candle recent slice.
        recent_atr = _calc_atr_from_candles(recent_candles, period=4)
        baseline_atr = _calc_atr_from_candles(baseline_candles, period=14)
        vol_ratio = recent_atr / max(baseline_atr, 1e-8)
    else:
        vol_ratio = 1.0

    vol_scale = float(np.clip(vol_ratio, 0.85, 1.50))
    rank_scale = 1.0 + (atr_pct_rank - 0.5) * 0.4
    rank_scale = float(np.clip(rank_scale, 0.75, 1.25))
    adaptive_mult = sl_mult * vol_scale * rank_scale

    if strategy_type == "TREND":
        adaptive_mult = min(adaptive_mult, 2.50)

    # PHASE-3.2: Panic threshold — emergency SL when ATR is in top 5% of 30-day range
    panic_threshold = regime_p.get("panic_threshold", 5.0) if regime_p else 5.0
    if atr_pct_rank >= (1.0 - panic_threshold / 100.0):
        emergency_mult = 1.0
        logger.warning(
            f"[RiskEngine] PANIC — ATR rank={atr_pct_rank:.0%} in top {panic_threshold:.0f}% of range. "
            f"Emergency SL: {emergency_mult:.2f}× ATR (normal adaptive={adaptive_mult:.2f})"
        )
        adaptive_mult = emergency_mult

    SL_MULT = adaptive_mult

    logger.info(
        f"[RiskEngine] sl_mult={sl_mult:.2f} vol_ratio={vol_ratio:.3f} "
        f"atr_rank={atr_pct_rank:.0%} rank_scale={rank_scale:.3f} "
        f"adaptive_mult={SL_MULT:.3f} strategy={strategy_type}"
    )

    TP_MULT = tp_mult_ratio  # P0: regime-adaptive (RR target from REGIME_PARAMS)


    def sl_tp(sl_dist: float) -> Tuple[float, float]:
        if is_long:
            sl = price - sl_dist
            tp_target = price + (sl_dist * TP_MULT)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall > tp_target) else tp_target
        else:
            sl = price + sl_dist
            tp_target = price - (sl_dist * TP_MULT)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall < tp_target) else tp_target
        return round(sl, 2), round(tp, 2)

    if strategy_type == "LIQUIDITY_SWEEP" and sweep:
        if sweep == "ABOVE_HIGHS" and sell_walls:
            sl_dist = abs(price - sell_walls[0]) + (atr * 0.5)
        elif sweep == "BELOW_LOWS" and buy_walls:
            sl_dist = abs(price - buy_walls[0]) + (atr * 0.5)
        else:
            sl_dist = atr * SL_MULT
        _sl_wick_override = None
        if signal is not None:
            _wick = signal.get("sweep_wick", 0.0)
            if signal.get("strategy_type") == "LIQUIDITY_SWEEP" and _wick > 0:
                _buf = 0.20 * atr
                if is_long:
                    _sl_wick_candidate = _wick - _buf
                    if _sl_wick_candidate < price - sl_dist:
                        _sl_wick_override = _sl_wick_candidate
                else:
                    _sl_wick_candidate = _wick + _buf
                    if _sl_wick_candidate > price + sl_dist:
                        _sl_wick_override = _sl_wick_candidate
                if _sl_wick_override is not None:
                    logger.info(f"[RiskEngine] Wick SL: {price - sl_dist:.2f}→{_sl_wick_override:.2f}")
                    sl_dist = abs(price - _sl_wick_override)
        _sl, _tp = sl_tp(max(sl_dist, atr * SL_MULT))
        return _sl, _tp, SL_MULT
    elif strategy_type == "TREND":
        _sl, _tp = sl_tp(atr * SL_MULT)
        return _sl, _tp, SL_MULT
    elif strategy_type == "MEAN_REVERSION":
        _sl, _tp = sl_tp(atr * SL_MULT)
        return _sl, _tp, SL_MULT
    else:
        _sl, _tp = sl_tp(price * 0.008)
        return _sl, _tp, 1.0


# ══════════════════════════════════════════════════════════════════════
# ── FULL 7-STAGE SIGNAL ENGINE ────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def _derivatives_refresh_loop():
    """
    Background task: refreshes institutional context every 5 minutes.
    Stores result in _CACHED_DERIV_CONTEXT so _compute_signal() can read
    it synchronously without blocking the signal hot path.
    """
    global _CACHED_DERIV_CONTEXT, _DERIV_CONTEXT_LAST_UPDATE, _DERIV_CONTEXT_WARMING
    await asyncio.sleep(2)  # Initial delay: let feed warm up first, quicker than 10s
    while True:
        try:
            ctx = await _derivatives_ctx.get_full_context()
            if ctx:
                _CACHED_DERIV_CONTEXT = ctx
                _DERIV_CONTEXT_LAST_UPDATE = time.time()
                _DERIV_CONTEXT_WARMING = False
                logger.debug(
                    f"[DerivRefresh] Context updated: crowd={ctx.get('top_traders',{}).get('crowd_signal','?')} "
                    f"oi_collapsing={ctx.get('open_interest',{}).get('oi_collapsing','?')}"
                )
        except Exception as e:
            logger.warning(f"[DerivRefresh] Background fetch failed: {e}")
        try:
            await asyncio.sleep(300)  # 5 minute refresh cycle
        except asyncio.CancelledError:
            break


async def _compute_signal(
    metrics: Dict[str, Any],
    candle_history: list,
    feed_state,
    daily_loss_halt: bool,
    drawdown_halt: bool = False,
    quant=None,  # PHASE-5.1: QuantEngine ref for cold-start trade count
) -> Dict[str, Any]:
    WAIT = {
        "verdict": "WAIT", "confidence": 0.0,
        "stop_loss": 0.0, "take_profit": 0.0,
        "analysis": "", "ulis_verdict": "—"
    }

    if not macro_shield.is_calendar_safe():
        logger.warning(f"[MacroShield] Calendar Blackout Active: {macro_shield.next_event_name} — blocking entries.")
        # We don't want to increment daily loss halt, let's just log and return wait.
        return {**WAIT, "analysis": f"MacroShield Blackout: {macro_shield.next_event_name}"}

    if daily_loss_halt:
        logger.warning("[RiskEngine] Daily loss limit hit — all trading halted today.")
        _gate_stats_summary("daily_loss_halt")
        return {**WAIT, "analysis": "Daily loss limit reached. Halted."}

    if drawdown_halt:
        logger.warning("[RiskEngine] Max drawdown breached — all trading halted. Restart bot to resume.")
        _gate_stats_summary("drawdown_halt")
        return {**WAIT, "analysis": "Max drawdown breached. Restart bot to resume."}

    # ── Capital Hard Stop ─────────────────────────────────────────────────────
    # P17 FIX: Thresholds centralized in signal_config as EQUITY_HARD_BLOCK
    if ACCOUNT_SIZE < EQUITY_HARD_BLOCK:
        logger.warning(
            f"[RiskEngine] 🛑 Account ${ACCOUNT_SIZE:.2f} below absolute minimum "
            f"${EQUITY_HARD_BLOCK:.0f}. All entries blocked. Deposit to resume."
        )
        _gate_stats_summary("signal_none")
        return {**WAIT, "analysis": f"Account ${ACCOUNT_SIZE:.2f} < ${EQUITY_HARD_BLOCK:.0f} minimum. Deposit to resume."}

    # ── Small-Account Risk Cap ────────────────────────────────────────────────
    # When equity is below EQUITY_SMALL_ACCOUNT ($150), cap risk per trade at 0.75%
    # to prevent fee erosion from consecutive losses destroying the account.
    # Win rate is the priority — protecting capital between signals is essential.
    _RECOMMENDED_EQUITY = EQUITY_SMALL_ACCOUNT  # P17 FIX: was 150.0, now centralized
    _SMALL_ACCOUNT_RISK_CAP = 0.75   # % of equity — max loss ~$0.58 at $77
    _small_account_mode = ACCOUNT_SIZE < _RECOMMENDED_EQUITY
    if _small_account_mode:
        logger.info(
            f"[RiskEngine] Small-account mode active — risk capped at "
            f"{_SMALL_ACCOUNT_RISK_CAP}% (equity=${ACCOUNT_SIZE:.2f} < "
            f"${_RECOMMENDED_EQUITY:.0f} recommended). Win-rate focus."
        )

    # PHASE-0.4: Z-Score session guard
    # Z-score is statistically meaningless with fewer than 10 bars — it fits noise.
    if not metrics.get("z_score_valid", True):
        _gate_stats_summary("zscore_warmup")
        return {**WAIT, "analysis": "Session warmup: Z-Score not yet valid (<10 bars)."}

    # --- AUDIT FIX 1: ATR PANIC GATE ---
    global ATR_PANIC_CONSECUTIVE, ATR_PANIC_COOLDOWN_UNTIL, ATR_PANIC_LAST_WARN_TS
    import time
    now_ts = time.time()
    
    atr_pct_rank = metrics.get("atr_pct_rank", 0.5)
    atr_pct      = metrics.get("atr_pct", 0.0)

    metrics["volatility_risk_multiplier"] = 1.0
    soft_atr = atr_pct_rank >= ATR_PANIC_WARN_RANK and atr_pct > 0.0015
    hard_atr = atr_pct_rank >= ATR_PANIC_HARD_RANK and atr_pct >= ATR_PANIC_HARD_ATR_PCT

    # High percentile ATR is normal in crypto clusters. Treat it as a sizing
    # problem unless the absolute ATR is also extreme enough to make SL geometry
    # unreliable. This prevents the 90th-percentile deadlock seen in the log.
    if hard_atr:
        if now_ts < ATR_PANIC_COOLDOWN_UNTIL:
            logger.debug(f"[RiskEngine] ATR panic ignored (grace period: {int(ATR_PANIC_COOLDOWN_UNTIL - now_ts)}s remain)")
            ATR_PANIC_CONSECUTIVE = 0
        else:
            ATR_PANIC_CONSECUTIVE += 1
            if ATR_PANIC_CONSECUTIVE >= 3:
                logger.warning("[RiskEngine] Persistent hard ATR panic detected. Activating 15m observation cooldown.")
                ATR_PANIC_COOLDOWN_UNTIL = now_ts + 900
                ATR_PANIC_CONSECUTIVE = 0
            else:
                logger.warning(
                    f"[RiskEngine] ATR PANIC HALT - ATR rank={atr_pct_rank:.1%}, "
                    f"ATR%={atr_pct:.3%}. Blocking entry."
                )
                _gate_stats_summary("atr_panic_halt")
                return {**WAIT, "analysis": f"ATR PANIC HALT (rank={atr_pct_rank:.1%}, ATR={atr_pct:.3%})."}
    elif soft_atr:
        ATR_PANIC_CONSECUTIVE = 0
        risk_mult = float(np.clip(ATR_PANIC_SOFT_RISK_MULT, 0.10, 1.0))
        metrics["volatility_risk_multiplier"] = risk_mult
        if now_ts - ATR_PANIC_LAST_WARN_TS >= 300:
            logger.info(
                f"[RiskEngine] ATR soft throttle - rank={atr_pct_rank:.1%}, "
                f"ATR%={atr_pct:.3%}; risk multiplier={risk_mult:.2f}."
            )
            ATR_PANIC_LAST_WARN_TS = now_ts
    else:
        ATR_PANIC_CONSECUTIVE = 0

    global LAST_CASCADE_TIME
    import time
    # NOTE: Cascade cooldown moved AFTER regime detection (Strategy-B)
    # so it can use regime-adaptive duration from REGIME_PARAMS.

    # Universal post-trade cooldown: POST_TRADE_COOLDOWN_S after any exit (SL or TP)
    global LAST_ANY_TRADE_CLOSE_TIME
    time_since_last_trade = time.time() - LAST_ANY_TRADE_CLOSE_TIME
    # FREQ-1: wire split cooldown — 45s after TP, 90s after SL
    _last_was_sl = LAST_TRADE_WAS_SL
    _cooldown = POST_TRADE_COOLDOWN_S if _last_was_sl else 120
    if time_since_last_trade < _cooldown:
        _gate_stats_summary("post_trade_cooldown")
        return {**WAIT, "analysis": f"Post-trade cooldown ({_cooldown - int(time_since_last_trade)}s remain, {'SL' if _last_was_sl else 'TP'} exit)"}

    global LAST_CANDLE_TS
    import time as _time

    price = metrics["price"]
    atr   = metrics.get("atr", price * 0.005)
    atr_pct = metrics.get("atr_pct", 0.005)
    vpoc  = metrics.get("vpoc")

    # Stage 1: Parse walls
    buy_walls  = [p for p, _ in metrics.get("top_buy_walls", [])]
    sell_walls = [p for p, _ in metrics.get("top_sell_walls", [])]

    # Stage 1b: Pre-detect sweep (needed for LIQUIDITY cap in _detect_regime)
    sweep, sweep_ts, sweep_wick = _detect_liquidity_sweep(metrics, buy_walls, sell_walls, candle_history, feed_state)

    # Stage 2: Regime
    regime = _detect_regime(metrics, buy_walls, sell_walls, quant=quant, sweep=sweep, feed_state=feed_state)
    logger.info(f"[Regime] {regime} | Z={metrics['zScore']:.2f} | "
                f"ATR%={metrics.get('atr_pct', 0):.3%} | Tape={metrics['tapeSpeed']}")

    # Stage 2b: HTF (4H) Trend Filter — block counter-trend entries
    htf = _htf_trend(candle_history)
    if htf != "NEUTRAL":
        logger.info(f"[HTF] 4H trend = {htf}")

    # ── P0: Load regime-conditional parameter matrix ────────────────────────
    # All downstream stages read thresholds from regime_p instead of hard-coded constants.
    regime_p = REGIME_PARAMS.get(regime, REGIME_PARAMS["NEUTRAL"])

    # STRATEGY-B: Regime-adaptive cascade cooldown.
    # RANGE/LIQUIDITY = 180s (quiet markets recover fast, sweeps repeat).
    # TREND = 240s (trend may still be valid). NEUTRAL = 300s (default).
    cascade_cd = regime_p.get("cascade_cooldown_s", 300)

    # --- AUDIT FIX 4: ESCALATING COOLDOWNS & CONSECUTIVE LOSS HALT ---
    if quant:
        consecutive_losses = getattr(quant, "_consecutive_losses", 0)
        if consecutive_losses >= 3:
            logger.warning(f"[RiskEngine] 🛑 3 CONSECUTIVE LOSSES — Session Halted. Taking a break to prevent further drawdowns.")
            _gate_stats_summary("consecutive_loss_halt")
            return {**WAIT, "analysis": "3 consecutive losses halt. Session paused."}
        
        if consecutive_losses > 0:
            cascade_cd *= (1 + consecutive_losses)
            logger.info(f"[RiskEngine] Escalating cooldown active. {consecutive_losses} losses -> cascade_cd extended to {cascade_cd}s")

    time_since_cascade = time.time() - LAST_CASCADE_TIME
    if time_since_cascade < cascade_cd:
        remaining = cascade_cd - int(time_since_cascade)
        _gate_stats_summary("cascade_cooldown")
        return {**WAIT, "analysis": f"WAIT (Cascade Cooldown: {remaining}s remain, regime={regime})"}

    # FIX-AUDIT: Dead-market Z guard for RANGE regime.
    # When abs(zScore) < 0.30 for multiple consecutive cycles the market is
    # statically flat — no edge exists regardless of other indicators.
    # Skip signal evaluation to avoid burning cascade cooldown on a flat market.
    if regime == "RANGE":
        _z = abs(metrics.get("zScore", 0.0))
        if _z < 0.30:
            _flat_cycles = getattr(quant, "_dead_market_cycles", 0) + 1
            quant._dead_market_cycles = _flat_cycles
            if _flat_cycles >= 5:
                logger.info(f"[DeadMarket] RANGE+flat Z={_z:.2f} for {_flat_cycles} cycles — no edge, skipping.")
                _gate_stats_summary("regime_no_edge")
                return {**WAIT, "analysis": f"Dead market: Z={_z:.2f} < 0.30 for {_flat_cycles} cycles."}
        else:
            quant._dead_market_cycles = 0

    logger.info(
        f"[RegimeParams] z_thr={regime_p['z_threshold']} "
        f"sl_mult={regime_p['atr_multiplier_sl']} "
        f"min_conf={regime_p['min_confidence']:.0%} "
        f"rr={regime_p['rr_target']} "
        f"gate={regime_p['candle_gate_sec']}s "
        f"htf_block={regime_p['htf_block']}"
    )

    # Stage 3: Sweep detection (already computed in Stage 1b — reuse)
    # Stage 3b: Candle-Close Freshness Gate (LIQUIDITY_SWEEP only)
    # New logic: we use the actual timestamp of the candle that triggered the sweep
    # to measure its age. This correctly handles sweeps detected from the live candle.
    if sweep:
        sweep_candle_age_s = _time.time() - sweep_ts
        # A 15m candle = 900s. We allow entry at ANY POINT within the CURRENT candle
        # after the previous candle produced the sweep — i.e. up to 2 full candle lengths.
        # Old value (900+gate_sec=945s) gave only a 45s reaction window which was far
        # too tight: mid-session starts and any latency caused instant staleness.
        gate_sec = regime_p["candle_gate_sec"]
        max_sweep_age = 900 + gate_sec  # PHASE-5.3: was 1800+gate_sec (~30min), now 900+gate_sec (~15min)
        if sweep_candle_age_s > max_sweep_age:
            logger.info(
                f"[CandleGate] Sweep signal stale — sweep candle closed "
                f"{sweep_candle_age_s:.0f}s ago (>{max_sweep_age}s). Blocking."
            )
            BOT_STATS["gate_stats"]["candle_gate_expired"] = BOT_STATS["gate_stats"].get("candle_gate_expired", 0) + 1
            sweep = None

    # Stage 4: Strategy
    raw_direction: Optional[str] = None
    strategy_type: str

    if sweep:
        strategy_type = "LIQUIDITY_SWEEP"
        raw_direction = _strategy_liquidity_sweep(sweep, metrics)
        logger.info(f"[MetaModel] → LIQUIDITY_SWEEP (sweep={sweep})")
    elif regime == "TREND":
        strategy_type = "TREND"
        raw_direction = _strategy_trend(metrics)
        logger.info("[MetaModel] → TREND strategy")
    elif regime == "VOLATILE":
        strategy_type = "TREND"
        raw_direction = _strategy_trend(metrics)
        if raw_direction is None:
            z_current = metrics.get("zScore", 0.0)
            rsi = metrics.get("rsi", 50.0)
            vol_z_thr = regime_p.get("z_threshold", 1.75)
            if abs(z_current) >= vol_z_thr and metrics.get("tapeSpeed") != "SCREAMING":
                raw_direction = _strategy_mean_reversion(metrics, z_threshold=vol_z_thr)
                strategy_type = "MEAN_REVERSION"
            if raw_direction:
                logger.info(
                    f"[MetaModel] VOLATILE -> {strategy_type} ({raw_direction}) "
                    f"z={z_current:.2f} rsi={rsi:.1f}"
                )
            else:
                logger.debug(
                    f"[MetaModel] VOLATILE: no setup "
                    f"(z={z_current:.2f}, rsi={rsi:.1f}, tape={metrics.get('tapeSpeed')})"
                )
        else:
            logger.info("[MetaModel] VOLATILE -> TREND strategy")
    elif regime == "RANGE":
        strategy_type = "MEAN_REVERSION"
        raw_direction = _strategy_mean_reversion(
            metrics,
            z_threshold=regime_p["z_threshold"],
        )
        logger.info(f"[MetaModel] → MEAN_REVERSION strategy (z_thr={regime_p['z_threshold']})")
    elif regime == "NEUTRAL":
        strategy_type = "MEAN_REVERSION"
        z_current = metrics.get("zScore", 0.0)
        z_prev = metrics.get("zScore_prev", z_current)
        z_slope = z_current - z_prev
        rsi = metrics.get("rsi", 50.0)
        rsi_prev = metrics.get("rsi_prev", rsi)
        rsi_prev2 = metrics.get("rsi_prev2", rsi_prev)
        rsi_trough = (rsi > rsi_prev) and (rsi_prev < rsi_prev2)
        rsi_peak = (rsi < rsi_prev) and (rsi_prev > rsi_prev2)
        z_thr = regime_p["z_threshold"]
        candidate = _strategy_mean_reversion(metrics, z_threshold=z_thr)
        if candidate == "MEAN_REVERSAL_LONG" and (z_slope <= 0 or not rsi_trough):
            candidate = None
        if candidate == "MEAN_REVERSAL_SHORT" and (z_slope >= 0 or not rsi_peak):
            candidate = None
        raw_direction = candidate
        if raw_direction:
            logger.info(f"[MetaModel] NEUTRAL -> {strategy_type} ({raw_direction}) "
                         f"z={z_current:.2f} slope={z_slope:+.3f}")
        else:
            logger.debug(f"[MetaModel] NEUTRAL: no setup (z={z_current:.2f}, "
                          f"slope={z_slope:+.3f}")
    else:
        strategy_type = "NEUTRAL"
        raw_direction = None
        logger.info(f"[MetaModel] → WAIT (regime={regime}, no sweep)")

    if raw_direction is None:
        _gate_stats_summary("signal_none")
        return {**WAIT, "analysis": f"Regime={regime} strategy={strategy_type} — no edge."}

    # --- AUDIT FIX 3: RSI EXTREMES GATE (regime-conditional) ---
    # In TREND regime: suppress RSI block for direction-with-momentum.
    # RSI extended oversold in a bear trend routinely persists for hours;
    # blocking SELL entries there defeats the trend strategy entirely.
    # In RANGE/NEUTRAL/LIQUIDITY: keep the gate as-is (mean-reversion context).
    rsi = metrics.get("rsi", 50.0)
    is_long_dir = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    is_trend_strat = strategy_type == "TREND"
    rsi_gate_suppressed = is_trend_strat  # in TREND, let RSI extremes pass

    if is_long_dir and rsi > 70.0 and not rsi_gate_suppressed:
        logger.warning(f"[RiskEngine] 🛑 RSI OVERBOUGHT HALT — Blocking {raw_direction} at RSI={rsi:.1f} > 70.0")
        _gate_stats_summary("rsi_overbought")
        return {**WAIT, "analysis": f"RSI={rsi:.1f} > 70.0 blocks {raw_direction} entry."}
    if not is_long_dir and rsi < 30.0 and not rsi_gate_suppressed:
        logger.warning(f"[RiskEngine] 🛑 RSI OVERSOLD HALT — Blocking {raw_direction} at RSI={rsi:.1f} < 30.0")
        _gate_stats_summary("rsi_oversold")
        return {**WAIT, "analysis": f"RSI={rsi:.1f} < 30.0 blocks {raw_direction} entry."}

    # Stage 4b: HTF Counter-Trend Block
    # P0: htf_block is regime-conditional. In RANGE, mean-reversion against HTF is the strategy.
    is_long_dir = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    is_trend_strat = strategy_type == "TREND"

    if regime_p["htf_block"]:   # P0: Only apply HTF block when regime says to
        if htf == "BEAR" and is_long_dir and is_trend_strat:
            logger.warning(f"[HTF] Blocking LONG trend trade — 4H trend is BEAR.")
            _gate_stats_summary("htf_counter_trend")
            return {**WAIT, "analysis": f"HTF=BEAR blocks {raw_direction} trend entry."}
        if htf == "BULL" and not is_long_dir and is_trend_strat:
            logger.warning(f"[HTF] Blocking SHORT trend trade — 4H trend is BULL.")
            _gate_stats_summary("htf_counter_trend")
            return {**WAIT, "analysis": f"HTF=BULL blocks {raw_direction} trend entry."}

        # Funding Rate Anti-Squeeze Protection (TREND only, since htf_block is now regime-gated)
        if is_trend_strat:
            try:
                fr = float(metrics.get("funding_rate", 0.0))
                # P1-6 FIX: Old threshold (0.015%) was 5-10x below normal BTC contango
                # (typically 0.03-0.10% per 8h). It silently blocked ~70% of long entries
                # in any bullish session. New thresholds reflect genuinely crowded positions.
                if is_long_dir and fr > FUNDING_LONG_BLOCK:
                    logger.warning(f"[Anti-Squeeze] Blocking LONG: extreme funding rate {fr:.4%} > {FUNDING_LONG_BLOCK:.4%}")
                    _gate_stats_summary("funding_blocks_long")
                    return {**WAIT, "analysis": f"Funding Rate {fr:.4%} > {FUNDING_LONG_BLOCK:.4%}. Blocked long."}
                if not is_long_dir and fr < FUNDING_SHORT_BLOCK:
                    logger.warning(f"[Anti-Squeeze] Blocking SHORT: extreme funding rate {fr:.4%} < {FUNDING_SHORT_BLOCK:.4%}")
                    _gate_stats_summary("funding_blocks_short")
                    return {**WAIT, "analysis": f"Funding Rate {fr:.4%} < {FUNDING_SHORT_BLOCK:.4%}. Blocked short."}
            except (ValueError, TypeError):
                pass

    # FIX-P4: HTF Directional Filter for LIQUIDITY Sweep entries.
    # htf_block=False in LIQUIDITY correctly allows the regime — sweeps ARE reversal setups.
    # BUT: a BELOW_LOWS BUY sweep into a 4H BEAR trend is a continuation, not a reversal.
    # The audit found 13 trades, many of which were BUY sweeps into a sustained BEAR 4H.
    # Fix: sweep entries must align with the reversal implied by the sweep direction vs HTF.
    # HTF=NEUTRAL → no bias, allow both directions.
    is_sweep_strat = strategy_type == "LIQUIDITY_SWEEP" and sweep is not None
    if is_sweep_strat and htf != "NEUTRAL":
        if htf == "BEAR" and is_long_dir:
            logger.warning(
                "[HTF-Sweep] BUY sweep BLOCKED — 4H BEAR trend. "
                "BELOW_LOWS into a bear trend is a continuation, not a reversal."
            )
            _gate_stats_summary("htf_counter_trend")
            return {**WAIT, "analysis": "HTF=BEAR blocks BUY sweep (not a genuine reversal setup)."}
        if htf == "BULL" and not is_long_dir:
            logger.warning(
                "[HTF-Sweep] SELL sweep BLOCKED — 4H BULL trend. "
                "ABOVE_HIGHS into a bull trend is a continuation, not a reversal."
            )
            _gate_stats_summary("htf_counter_trend")
            return {**WAIT, "analysis": "HTF=BULL blocks SELL sweep (not a genuine reversal setup)."}

    # === DERIVATIVES GATE: Institutional signal check ===
    # Read from pre-fetched cache — zero latency in signal hot path
    _deriv_ctx = _CACHED_DERIV_CONTEXT
    _age_s = time.time() - _DERIV_CONTEXT_LAST_UPDATE
    if _DERIV_CONTEXT_WARMING:
        logger.info(f"[DerivGate] Cache warming — skipping derivatives gate without warnings")
        _deriv_ok, _deriv_reason = True, "WARMING_BYPASSED"
    elif _age_s > 900:  # 15 minutes: cache is too stale to trust
        logger.warning(f"[DerivGate] Cache stale ({_age_s:.0f}s) — skipping derivatives gate")
        _deriv_ok, _deriv_reason = True, "STALE_CACHE_BYPASSED"
    else:
        _deriv_ok, _deriv_reason = await _derivatives_gate(raw_direction, _deriv_ctx)
    if not _deriv_ok:
        logger.warning(f"[DerivGate] VETO: {_deriv_reason}")
        _gate_stats_summary("derivatives_veto")
        return {**WAIT, "analysis": f"Derivatives gate veto: {_deriv_reason}"}
    if _deriv_reason:
        logger.info(f"[DerivGate] PASS ({_deriv_reason})")

    # FIXED: CVD gate BEFORE Bayes fusion (was after)
    _pre_div_conf = metrics.get("bayesianPosterior", 0.5)
    _div_conf, _div_veto = _apply_cvd_divergence_gate(raw_direction, metrics, _pre_div_conf)
    if _div_veto:
        _gate_stats_summary("cvd_divergence_veto")
        return {**WAIT, "analysis": f"CVD divergence veto: {_div_veto}"}
    if abs(_div_conf - _pre_div_conf) > 0.001:
        metrics = {**metrics, "bayesianPosterior": _div_conf}

    # FIX: Throughput gate — was 300/min (too high for BTC, blocked normal 200-250 tape).
    # Lowered to 150/min to catch truly dead markets while letting normal BTC through.
    # CVD exception (>0.40) and boot grace (120s) both bypass this gate.
    _msgs_per_min = getattr(feed_state, "msgs_per_min", 999)
    _cvd_div = metrics.get("cvd_divergence", {})
    _cvd_strength = _cvd_div.get("strength", 0.0) if _cvd_div else 0.0
    _boot_grace = (time.time() - BOT_START_TIME) < 120
    if not _boot_grace and _msgs_per_min < 150 and _cvd_strength < 0.40:
        logger.warning(
            f"[ThroughputGate] Blocked: msgs/min={_msgs_per_min} < 150, CVD strength={_cvd_strength:.2f}"
        )
        _gate_stats_summary("throughput_thin")
        return {**WAIT, "analysis": f"Throughput={_msgs_per_min}/min < 150. CVD strength {_cvd_strength:.2f} < 0.40. Skipped."}

    # Stage 5: Bayesian fusion (P1: regime_priors already injected into metrics upstream)
    confidence = _bayesian_fusion(metrics, raw_direction, regime, is_sweep=bool(sweep))

    # _bayesian_fusion returns probability in the target signal direction.
    # Do not invert shorts here; doing so lets weak short signals pass.
    if confidence < 0.50:
        logger.warning(
            f"[RiskEngine] 🛑 BAYES FLOOR HALT — P(direction)={confidence:.2%} < 50%. "
            f"Edge is worse than a coin flip."
        )
        _gate_stats_summary("bayes_floor_veto")
        return {**WAIT, "analysis": f"Bayesian directional {confidence:.2%} < 50% blocks entry."}

    # Stage 5b: VPOC Proximity Confidence Boost
    vpoc_boost = _vpoc_confidence_boost(price, vpoc, raw_direction)
    if vpoc_boost > 0.0:
        confidence = min(1.0, confidence + vpoc_boost)
        logger.info(f"[VPOC] Near VPOC ({vpoc:.0f}). Confidence boosted by +{vpoc_boost:.2%} → {confidence:.2%}")

    logger.info(f"[BayesFusion] direction={raw_direction} | P={confidence:.2%}")

    # Stage 6 ★ ULIS/ALDE gate FIRST (applies confidence boost)
    should_trade, confidence, ulis_verdict_str = _apply_ulis_gate(
        metrics, candle_history, feed_state, raw_direction, confidence
    )

    if not should_trade:
        _gate_stats_summary("ulis_veto")
        return {**WAIT, "analysis": f"ULIS veto: {ulis_verdict_str}", "ulis_verdict": ulis_verdict_str}

    # FIX: Check threshold AFTER ULIS gate using boosted confidence
    # P0: Use regime-adaptive min_confidence instead of global MIN_CONFIDENCE
    # PHASE-5.1: Apply cold-start discount (few trades = slightly lower bar)
    # PHASE-5.2: Wire MIN_CONFIDENCE as a floor under regime threshold
    total_trades = sum(quant.get_regime_trade_counts().values()) if quant else 0
    cold_start_discount = COLD_START_CONFIDENCE_DISCOUNT if total_trades < COLD_START_TRADE_COUNT else 0.0
    # P12 FIX: Ensure global environment MIN_CONFIDENCE is used as the absolute safety floor
    # under the regime-adaptive threshold, preventing negative-expectation entries.
    regime_min_conf = max(
        regime_p["min_confidence"] - cold_start_discount,
        MIN_CONFIDENCE   # P12 FIX: was hardcoded 0.50, now uses the env-bridged floor
    )
    probation_trades = int(getattr(quant, "_risk_probation_trades_remaining", 0) or 0) if quant else 0
    if probation_trades > 0:
        regime_min_conf = min(0.85, regime_min_conf + 0.05)
        metrics["volatility_risk_multiplier"] = min(
            float(metrics.get("volatility_risk_multiplier", 1.0)),
            0.50,
        )
        logger.info(
            f"[RiskEngine] Probation mode active ({probation_trades} trades remaining): "
            f"min_conf={regime_min_conf:.0%}, risk multiplier=0.50"
        )
    if confidence < regime_min_conf:
        _gate_stats_summary("confidence_below_threshold")
        return {**WAIT, "analysis": (
            f"Regime={regime} strategy={strategy_type} signal={raw_direction} "
            f"but directional_P={confidence:.2%} < regime threshold={regime_min_conf:.0%}"
        )}

    # Stage 7: Risk engine — P0: adaptive ATR multipliers from regime params
    stop_loss, take_profit, adaptive_mult = _risk_engine(
        raw_direction, strategy_type,
        price,
        atr, buy_walls, sell_walls, sweep,
        sl_mult=regime_p["atr_multiplier_sl"],
        tp_mult_ratio=regime_p["rr_target"],
        candle_history=candle_history,
        metrics=metrics,  # BUG-4: pass for atr_pct_rank vol scaling
        regime_p=regime_p,  # PHASE-3.2: pass for panic_threshold
        signal={"sweep_wick": sweep_wick if sweep else 0.0, "strategy_type": strategy_type},  # NEW: pass for sweep_wick
    )

    # Sanity check — geometry must be valid
    is_long = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    if is_long and (stop_loss >= price or take_profit <= price):
        logger.warning("[RiskEngine] Invalid geometry for LONG — skipped.")
        _gate_stats_summary("fee_geometry")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}
    if not is_long and (stop_loss <= price or take_profit >= price):
        logger.warning("[RiskEngine] Invalid geometry for SHORT — skipped.")
        _gate_stats_summary("fee_geometry")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}

    # ── Pre-trade fee profitability check ──────────────────────────────
    # Reject any trade where the expected TP gain (as % of entry) is less
    # than the round-trip exchange fee cost. Without this check the bot will
    # consistently lose money even on winning trades.
    # LEVERAGE FIX: Binance charges fee on NOTIONAL (position × price).
    # Since tp_gain_pct is measured as a raw asset price movement (not ROI on margin),
    # the required break-even price movement is simply the round-trip fee rate on the notional.
    # We do NOT multiply by LEVERAGE here, because leverage magnifies both profit and fees equally.
    tp_gain_pct = abs(take_profit - price) / price          # % gain if TP hit
    round_trip_fee_rate = _EXCHANGE_FEE_RATE * 2            # entry + exit on notional
    min_viable_tp_pct = round_trip_fee_rate * 3.0           # TP must comfortably cover fees/slippage
    if tp_gain_pct < min_viable_tp_pct:
        logger.warning(
            f"[FeeCheck] TP gain {tp_gain_pct:.3%} < min viable {min_viable_tp_pct:.3%} "
            f"(round-trip fee rate={round_trip_fee_rate:.2%}). "
            f"Trade not profitable after fees. Skipping."
        )
        _gate_stats_summary("fee_geometry")
        return {**WAIT, "analysis": (
            f"TP gain {tp_gain_pct:.3%} below fee break-even {min_viable_tp_pct:.3%}. Skipped."
        ), "ulis_verdict": ulis_verdict_str}

    verdict_map = {
        "BUY":               "BUY",
        "SELL":              "SELL",
        "MEAN_REVERSAL_LONG":  "MEAN_REVERSAL_LONG",
        "MEAN_REVERSAL_SHORT": "MEAN_REVERSAL_SHORT",
    }
    verdict = verdict_map.get(raw_direction, raw_direction)

    analysis = (
        f"Regime={regime} Strategy={strategy_type} | {verdict} @ {price:.2f} "
        f"| P={confidence:.2%} | SL={stop_loss} TP={take_profit} "
        f"| Z={metrics['zScore']:.2f} RSI={metrics['rsi']:.1f} "
        f"OFI={metrics['ofi']:.1f} CVD={metrics['cvd']:.0f} "
        f"ATR={atr:.2f} Tape={metrics['tapeSpeed']}/{metrics['tapeDominant']} "
        f"ULIS={ulis_verdict_str}"
    )
    logger.info(f"[Signal] >> {verdict} | conf={confidence:.0%} | SL={stop_loss} TP={take_profit} | ULIS={ulis_verdict_str}")

    BOT_STATS["gate_stats"]["total_passed"] += 1
    confidence = _clamp_confidence(confidence)

    return {
        "verdict":        verdict,
        "confidence":     round(confidence, 4),
        "stop_loss":      stop_loss,
        "take_profit":    take_profit,
        "analysis":       analysis,
        "ulis_verdict":   ulis_verdict_str,
        "regime":         regime,
        "be_lock_trigger": regime_p.get("be_lock_trigger", 1.0),
        "partial_take_r": regime_p.get("partial_take_r", 0.75),
        "partial_take_pct": regime_p.get("partial_take_pct", 0.50),
        "time_exit_sec":  regime_p.get("time_exit_sec", 600),
        "atr_at_entry":   atr,
        "atr_pct":        atr_pct,
        "atr_pct_rank":   atr_pct_rank,
        "adaptive_mult":  adaptive_mult,
        "risk_multiplier": round(float(metrics.get("volatility_risk_multiplier", 1.0)), 4),
        "sweep_wick":     sweep_wick if sweep else 0.0,
        "strategy_type":  strategy_type,
    }


# ══════════════════════════════════════════════════════════════════════
# ── CORE EXECUTION LOOP ────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def _process_exit(
    pnl: float,
    regime: str,
    stats: dict,
    quant,
    executor,
):
    """Single source of truth for all post-trade state updates.
    Called from both the main exit path and the 30s heartbeat poll path."""
    global LAST_CASCADE_TIME, LAST_ANY_TRADE_CLOSE_TIME, LAST_TRADE_WAS_SL

    # P0-5 FIX: Idempotency guard
    if "closed_trade_ids" not in stats:
        stats["closed_trade_ids"] = set()
        
    pos = executor.active_position or {}
    doc_id = pos.get("trade_doc_id", "")
    if doc_id:
        if doc_id in stats["closed_trade_ids"]:
            logger.info(f"[_process_exit] Duplicate exit call for trade {doc_id} ignored.")
            return
        stats["closed_trade_ids"].add(doc_id)
        # Bounded set to prevent memory leak
        if len(stats["closed_trade_ids"]) > 1000:
            stats["closed_trade_ids"] = set(list(stats["closed_trade_ids"])[-500:])

    LAST_ANY_TRADE_CLOSE_TIME = time.time()
    LAST_TRADE_WAS_SL = (pnl < 0)

    stats["daily_pnl"]   = stats.get("daily_pnl",   0.0) + pnl
    stats["session_pnl"] = stats.get("session_pnl", 0.0) + pnl
    stats["cumulative_pnl"] = stats.get("cumulative_pnl", 0.0) + pnl

    quant.update_win_rate(won=(pnl >= 0), regime=regime)
    stats["consecutive_losses"] = getattr(quant, "_consecutive_losses", 0)

    # P1-3: increment HMM trade counter so online updates are gated until
    # we have enough live observations to trust the regime statistics.
    if hasattr(_hmm_classifier, "_n_trades_since_update"):
        _hmm_classifier._n_trades_since_update += 1

    # P2-2 FIX: Confidence calibration logging.
    # Track realized win rate per confidence bucket so we can validate
    # that our confidence score actually approximates P(win).
    _entry_conf = float(pos.get("entry_confidence", 0.0))
    if _entry_conf > 0:
        _bucket = str(round(int(_entry_conf * 10) / 10, 1))  # e.g. 0.67 -> "0.7"
        _cal = stats.setdefault("confidence_calibration", {})
        _b = _cal.setdefault(_bucket, {"wins": 0, "total": 0})
        _b["total"] += 1
        if pnl >= 0:
            _b["wins"] += 1
        _wr = _b["wins"] / max(_b["total"], 1)
        logger.info(
            f"[Calibration] conf_bucket={_bucket} "
            f"realized_wr={_wr:.0%} ({_b['wins']}/{_b['total']}) | "
            f"entry_conf={_entry_conf:.2%} pnl=${pnl:.2f}"
        )

    if pnl < 0:
        LAST_CASCADE_TIME = time.time()
        now_t = time.time()
        loss_times = [t for t in stats.get("loss_times", []) if now_t - t < 1800]
        loss_times.append(now_t)
        stats["loss_times"] = loss_times
        if len(loss_times) >= 3:
            stats["cooldown_until"] = now_t + 1800
            stats["loss_times"] = []
            if hasattr(quant, "_risk_probation_trades_remaining"):
                quant._risk_probation_trades_remaining = max(quant._risk_probation_trades_remaining, 2)
            else:
                quant._risk_probation_trades_remaining = 2
            logger.error("[RiskManager] 3 SL exits within 30 min — 30-min cooldown active.")
            if executor.notifier:
                await executor.notifier.send_message(
                    f"🛑 Quad-Desk CONSECUTIVE LOSS HALT\n"
                    f"3 SL exits within 30 minutes. Paused 30 min."
                , critical=True)

    # P0-2 FIX: Use live equity (not static boot ACCOUNT_SIZE) for risk calcs.
    # After gains/losses, the absolute dollar limits must scale with real equity.
    current_equity = ACCOUNT_SIZE + stats.get("session_pnl", 0.0)

    max_loss_usd = current_equity * MAX_DAILY_LOSS_PCT / 100.0
    if stats["daily_pnl"] < -max_loss_usd and not stats.get("daily_loss_halt"):
        stats["daily_loss_halt"] = True
        logger.warning(
            f"[RiskEngine] ⛔ Daily loss limit: ${stats['daily_pnl']:.2f} "
            f"(limit=-${max_loss_usd:.2f} on equity=${current_equity:.2f}). Halted until tomorrow."
        )

    max_drawdown_usd = ACCOUNT_SIZE * MAX_DRAWDOWN_PCT / 100.0
    if stats["cumulative_pnl"] < -max_drawdown_usd and not stats.get("drawdown_halt"):
        stats["drawdown_halt"] = True
        logger.critical(
            f"[RiskEngine] 🚨 MAX DRAWDOWN BREACHED: "
            f"${stats['cumulative_pnl']:.2f} (limit=-${max_drawdown_usd:.2f}). HALTED."
        )
        if executor.notifier:
            await executor.notifier.send_message(
                f"🚨 Quad-Desk MAX DRAWDOWN HIT\n"
                f"Cumulative PnL: ${stats['cumulative_pnl']:.2f} / Limit: -${max_drawdown_usd:.2f}\n"
                f"Bot halted. Restart to resume."
            , critical=True)

    # P10 FIX: Persist risk ledger to Firestore after every exit.
    # This ensures crash/restart does NOT bypass daily_loss_halt or drawdown_halt.
    _save_risk_ledger(stats)


def _operator_command_doc_id(symbol: str) -> str:
    return f"live_{heartbeat._symbol_doc_id(symbol)}"


async def _operator_command_loop(executor: TradingExecutor, stats: Dict[str, Any]) -> None:
    """
    Poll Firestore for admin-issued bot commands.

    Supported command values in botCommands/live_SYMBOL:
      pause_entries, resume_entries, panic_lock, flatten_now, cancel_orders
    """
    from firebase_admin import firestore as fs

    poll_seconds = float(os.environ.get("BOT_OPERATOR_COMMAND_POLL_SECONDS", "15"))
    doc_id = _operator_command_doc_id(stats.get("symbol", SYMBOL))
    last_seen_id = None

    while True:
        try:
            db = heartbeat.get_db()
            if db is None:
                await asyncio.sleep(poll_seconds)
                continue

            doc_ref = db.collection("botCommands").document(doc_id)
            snap = doc_ref.get()
            if not snap.exists:
                await asyncio.sleep(poll_seconds)
                continue

            data = snap.to_dict() or {}
            command = str(data.get("command") or "").strip().lower()
            command_id = str(data.get("command_id") or data.get("id") or "")
            processed = str(data.get("status") or "").lower() in ("processed", "failed", "ignored")
            fingerprint = command_id or f"{command}:{data.get('created_ts_ms') or data.get('created_at') or ''}"

            if not command or processed or fingerprint == last_seen_id:
                await asyncio.sleep(poll_seconds)
                continue

            last_seen_id = fingerprint
            status = "processed"
            note = ""
            logger.warning(f"[Operator] Processing command {command!r} for {doc_id}")

            try:
                if command == "pause_entries":
                    stats["operator_paused"] = True
                    note = "New entries paused. Existing positions remain managed."
                elif command == "resume_entries":
                    stats["operator_paused"] = False
                    note = "New entries resumed."
                elif command == "panic_lock":
                    stats["operator_paused"] = True
                    await executor.engage_panic_mode("Operator command: panic_lock", lock_seconds=PANIC_LOCK_SECONDS)
                    stats["active_position"] = executor.active_position
                    note = f"Panic lock engaged for {PANIC_LOCK_SECONDS}s."
                elif command == "flatten_now":
                    stats["operator_paused"] = True
                    await executor.emergency_flatten("Operator command: flatten_now")
                    stats["active_position"] = executor.active_position
                    note = "Emergency flatten attempted and entries paused."
                elif command == "cancel_orders":
                    stats["operator_paused"] = True
                    if executor.dry_run:
                        note = "Dry-run mode: no live exchange orders to cancel."
                    else:
                        ccxt_symbol = executor._get_ccxt_symbol(FEED_SYMBOL)
                        await executor.exchange.cancel_all_orders(ccxt_symbol)
                        note = f"Cancelled all open orders for {ccxt_symbol}; entries paused."
                else:
                    status = "ignored"
                    note = f"Unknown command: {command}"
            except Exception as cmd_err:
                status = "failed"
                note = str(cmd_err)
                logger.error(f"[Operator] Command {command!r} failed: {cmd_err}", exc_info=True)

            stats["operator_last_command"] = command
            stats["operator_last_command_status"] = status

            doc_ref.set(
                {
                    "status": status,
                    "result": note,
                    "processed_at": fs.SERVER_TIMESTAMP,
                    "processed_ts_ms": int(time.time() * 1000),
                    "operator_paused": bool(stats.get("operator_paused")),
                },
                merge=True,
            )

            if executor.notifier:
                try:
                    await executor.notifier.send_message(f"Operator command {command}: {status}. {note}")
                except Exception:
                    pass
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"[Operator] Command poll failed: {e}")

        await asyncio.sleep(poll_seconds)


async def execution_loop(
    feed,
    quant: QuantEngine,
    executor: TradingExecutor,
    stats: Dict[str, Any],
):
    # P10 FIX: Load persisted risk ledger from Firestore before ANY trading logic runs.
    # This restores daily_loss_halt, drawdown_halt, cumulative_pnl, etc. after a restart.
    _load_risk_ledger(stats)
    await executor.initialize()

    # CRIT-2 FIX: Set leverage AFTER markets are loaded (initialize() calls load_markets).
    # Pre-initialize leverage set could hit Binance with an unvalidated symbol and
    # silently fail, leaving the account at whatever leverage was last manually set.
    if executor.is_futures and not executor.dry_run:
        try:
            ccxt_symbol = executor._get_ccxt_symbol(FEED_SYMBOL)
            await executor.exchange.set_leverage(LEVERAGE, ccxt_symbol)
            logger.info(f"[Main] Futures leverage confirmed: {LEVERAGE}× on {ccxt_symbol} ✓")
        except Exception as e:
            logger.warning(f"[Main] Could not set leverage (will continue with account default): {e}")

    global ACCOUNT_SIZE, LAST_CVD, LAST_CASCADE_TIME, LAST_ANY_TRADE_CLOSE_TIME, LAST_CANDLE_TS, LAST_TRADE_WAS_SL
    global _CYCLE_ERROR_COUNT, _LAST_CYCLE_ERROR

    if not executor.dry_run:
        try:
            fetched_bal = await executor.get_usdt_balance(ACCOUNT_SIZE)
            if fetched_bal != ACCOUNT_SIZE and fetched_bal > 0:
                logger.info(f"[Main] Overriding BOT_ACCOUNT_SIZE with dynamically fetched live balance: ${fetched_bal:.2f}")
                ACCOUNT_SIZE = fetched_bal
        except Exception as e:
            logger.warning(f"[Main] Could not dynamically fetch account balance at startup: {e}")

    stats["account_equity"] = ACCOUNT_SIZE + stats.get("session_pnl", 0.0)

    EQUITY_MIN_TRADEABLE = EQUITY_RECOMMENDED  # P17 FIX: was 200.0, now centralized
    if ACCOUNT_SIZE < EQUITY_MIN_TRADEABLE:
        logger.warning(
            f"[RiskEngine] ⚠️ Account ${ACCOUNT_SIZE:.2f} below recommended minimum "
            f"(${EQUITY_MIN_TRADEABLE:.0f}). Trade sizing may fail or be suboptimal."
        )
        if executor.notifier:
            await executor.notifier.send_message(
                f"⚠️ Low Equity: ${ACCOUNT_SIZE:.2f} (min recommended: ${EQUITY_MIN_TRADEABLE:.0f})"
            )

    mode = "DRY-RUN" if executor.dry_run else "LIVE"
    logger.info(
        f"╔══ Quad-Desk Bot ═════════════════════╗\n"
        f"║  Exchange     : {EXCHANGE.upper()}\n"
        f"║  Symbol       : {SYMBOL}\n"
        f"║  Feed Symbol  : {FEED_SYMBOL} (Binance WS)\n"
        f"║  Mode         : {mode}\n"
        f"║  Risk/trade   : {MAX_RISK_PCT}%  (${ACCOUNT_SIZE * MAX_RISK_PCT / 100:.2f} max loss)\n"
        f"║  Max daily ↓  : {MAX_DAILY_LOSS_PCT}%\n"
        f"║  Min P(edge)  : {MIN_CONFIDENCE:.0%}\n"
        f"║  ULIS Gate    : {'ON ✓' if ULIS_GATE_ENABLED else 'OFF'}\n"
        f"║  Interval     : every {ANALYSIS_INTERVAL}s\n"
        f"╚══════════════════════════════════════╝"
    )

    _last_recon_ts = 0.0
    _orphan_flatten_attempts: int = 0          # how many times we've tried to flatten an orphan
    _last_orphan_flatten_ts: float = 0.0       # timestamp of last flatten attempt
    _queued_signal: dict = None                 # FIX-M5: best signal during lockout, queued for post-lockout execution
    _queued_signal_price: float = 0.0           # price at which the queued signal fired

    # Startup lockout: prevent any entry for the first 90s after boot.
    # The REST prefetch loads 100 historical candles, but live CVD, OFI and
    # order-book readings need a few cycles to stabilise before we act on them.
    _STARTUP_LOCKOUT_SECS = 90
    _boot_time = time.time()
    logger.info(
        f"[Main] ⏳ Startup lockout active — no new entries for {_STARTUP_LOCKOUT_SECS}s "
        f"while live feed settles."
    )

    while True:
        try:
            # ── Event-driven execution (Phase 6) ───────────────────────────
            try:
                # Wait for candle close OR timeout (whichever comes first)
                await asyncio.wait_for(
                    asyncio.shield(feed.state.candle_close_event.wait()),
                    timeout=float(ANALYSIS_INTERVAL)
                )
                feed.state.candle_close_event.clear()
            except (asyncio.TimeoutError, TimeoutError):
                pass  # Fallback to polling if websocket hasn't fired yet

            # ── DIAGNOSTIC: confirm loop is alive every cycle ──────────────
            n_candles = len(feed.state.candles)
            logger.debug(f"[Main] Cycle tick | candles={n_candles} | "
                         f"trades={len(feed.state.recent_trades)} | cvd={feed.state.cvd:.0f}")

            if n_candles < QuantEngine.MIN_CANDLES:
                logger.info(f"[Main] Warming up… {n_candles}/{QuantEngine.MIN_CANDLES} candles")
                continue

            # ── Startup lockout guard ──────────────────────────────────────
            # Allow exit monitoring immediately, but block new entries until
            # the live feed has had time to build real CVD/OFI/order-book data.
            _startup_elapsed = time.time() - _boot_time
            _in_startup_lockout = _startup_elapsed < _STARTUP_LOCKOUT_SECS

            # ── Daily loss reset at midnight ─────────────────────────────────
            today = date.today()
            if stats.get("_last_trade_day") != today:
                stats["_last_trade_day"] = today
                stats["daily_pnl"]       = 0.0
                stats["daily_loss_halt"] = False
                # FIX-R1: drawdown_halt and cumulative_pnl are NOT reset at midnight.
                # cumulative_pnl is lifetime and drawdown_halt can only be cleared by manual restart.
                # 3.6 FIX: Reset CVD anchor daily to prevent multi-day drift
                feed.state.cvd = 0.0
                LAST_CVD = 0.0
                logger.info("[RiskEngine] 🌅 Daily counters + CVD reset for new trading session.")
                # ── FIX #6: CVD Divergence Snapshot Reset (Addition B) ──────────
                # CRITICAL: Without clearing snapshots, first divergence comparison
                # of the new day measures ΔCVD = 0 - prior_session_CVD(e.g. -8000)
                # → spurious BULLISH divergence of strength ~1.0 on first signal.
                # Also reset EMA-variance state to prevent prior-session CVD
                # magnitude contamination of Welford's online estimator.
                quant.reset_cvd_divergence_state()
                logger.info("[DailyReset] CVD divergence state reset via quant.reset_cvd_divergence_state().")
                # HIGH-5 FIX: Refresh ACCOUNT_SIZE daily so daily loss cap stays accurate.
                # A stale startup balance misprices the loss limit after gains/losses.
                if not executor.dry_run:
                    try:
                        fresh_bal = await executor.get_usdt_balance(ACCOUNT_SIZE)
                        if fresh_bal > 0 and fresh_bal != ACCOUNT_SIZE:
                            logger.info(f"[RiskEngine] ACCOUNT_SIZE refreshed: ${ACCOUNT_SIZE:.2f} → ${fresh_bal:.2f}")
                            ACCOUNT_SIZE = fresh_bal
                    except Exception as _bal_err:
                        logger.warning(f"[RiskEngine] Could not refresh ACCOUNT_SIZE: {_bal_err}")

                    stats["account_equity"] = ACCOUNT_SIZE + stats.get("session_pnl", 0.0)

                # PHASE-6.3: Daily performance telemetry
                logger.info(
                    f"[DailyReport] Trades={stats.get('total_trades',0)} | "
                    f"Daily PnL=${stats.get('daily_pnl',0):.2f} | "
                    f"Session PnL=${stats.get('session_pnl',0):.2f} | "
                    f"Drawdown=${ACCOUNT_SIZE*MAX_DRAWDOWN_PCT/100:.2f} | "
                    f"Gate rejects={stats.get('gate_stats',{})}"
                )
                if executor.notifier:
                    await executor.notifier.send_message(
                        f"📊 Daily Report: {stats.get('total_trades',0)} trades | "
                        f"PnL: ${stats.get('daily_pnl',0):.2f} | Session: ${stats.get('session_pnl',0):.2f}"
                    )

            _raw_candle_close = feed.state.candles[-1]["close"]
            _mark_px = getattr(feed.state, "mark_price", 0.0)
            _basis_px = getattr(feed.state, "basis", 0.0)
            current_price = _mark_px if (_mark_px > 0 and abs(_basis_px) < 500) else _raw_candle_close
            effective_price = current_price

            macro_shield.on_btc_update(current_price, time.time())

            # PHASE-3.4: Cache positions per cycle to avoid duplicate fetch_positions API calls
            _cached_positions = None

            # ── P0-2 FIX: Candle staleness guard ────────────────────────────
            # If the most recent candle is older than 2.5× the kline interval,
            # the WebSocket feed is frozen. Skip this cycle and trigger a REST
            # prefetch to re-anchor the candle buffer from Binance directly.
            _interval_secs = {
                "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600
            }.get(CANDLE_INTERVAL, 900)
            _last_candle_age = time.time() - float(feed.state.candles[-1]["time"])
            if _last_candle_age > _interval_secs * 1.1:
                logger.warning(
                    f"[Main] ⚠️ Candle feed STALE ({_last_candle_age:.0f}s old, "
                    f">{_interval_secs * 1.1:.0f}s threshold). "
                    f"Triggering REST prefetch and skipping cycle."
                )
                # FIX-STALE: Force WS reconnect so dead socket is replaced.
                # Previously only REST was fetched, leaving the dead socket open.
                feed.state._reconnect_event.set()
                # P16 FIX: Supervise re-seed task — guard against overlapping re-seeds
                # and alert if it dies unexpectedly.
                if getattr(feed, '_reseed_task', None) is None or feed._reseed_task.done():
                    feed._reseed_task = asyncio.create_task(
                        feed._fetch_historical_candles_rest(), name="rest_reseed"
                    )
                    def _reseed_done_callback(task: asyncio.Task):
                        try:
                            exc = task.exception()
                        except asyncio.CancelledError:
                            exc = None
                        except Exception:
                            exc = None
                        if exc is not None:
                            logger.critical(
                                f"[Main] CRITICAL - task '{task.get_name()}' died with "
                                f"{type(exc).__name__}: {exc}",
                                exc_info=exc
                            )
                            if getattr(executor, "notifier", None):
                                asyncio.create_task(
                                    executor.notifier.send_error_alert(
                                        f"Task '{task.get_name()}' crashed: {type(exc).__name__}: {str(exc)[:200]}"
                                    )
                                )

                    feed._reseed_task.add_done_callback(_reseed_done_callback)
                continue  # skip — data is stale

            # ── Live-position heartbeat poll (every 30s, independent of main loop) ──
            # Detects positions that were closed by exchange SL/TP orders even if
            # the main loop is running slowly or a candle cycle is long.
            _now = time.time()
            if (
                not executor.dry_run
                and executor.active_position
                and _now - getattr(executor, "_last_pos_poll", 0) > 30
            ):
                executor._last_pos_poll = _now
                # P7 FIX: Use check_position_exit which holds _position_lock internally,
                # instead of calling _check_live_position_exit directly (which bypasses the lock).
                # P8 FIX: Snapshot regime BEFORE the exit check clears active_position.
                _hb_pos_snapshot = dict(executor.active_position) if executor.active_position else {}  # P8 FIX: dict copy
                _hb_exited, _hb_pnl = await executor.check_position_exit(current_price)
                if _hb_exited:
                    _cached_positions = None
                    pos_regime = (_hb_pos_snapshot or {}).get("regime", "NEUTRAL")
                    logger.info(f"[Heartbeat] Position closed via 30s poll. PnL=${_hb_pnl:.2f}")
                    await _process_exit(_hb_pnl, pos_regime, stats, quant, executor)
                    stats["active_position"] = None

            # ── System lock check (Panic Mode cooldown) ─────────────────────
            if executor.is_system_locked():
                remaining = max(0, executor.lock_expiry - time.time())
                logger.warning(
                    f"[PanicMode] System locked — {remaining:.0f}s remaining. "
                    f"Reason: {executor.last_panic_reason}"
                )
                continue

            # ── Panic trigger: Flash-crash detection ────────────────────────
            # AUDIT FIX #2: Only trigger on DROPS, not pumps.
            # Old code used abs() — a 3% BTC pump triggered panic and
            # force-exited profitable longs. That's normal price action.
            n_hist = len(feed.state.candles)
            if n_hist >= PANIC_LOOKBACK:
                lookback_price = feed.state.candles[-PANIC_LOOKBACK]["close"]
                if lookback_price > 0:
                    price_change_pct = (current_price - lookback_price) / lookback_price * 100
                    if price_change_pct <= -PANIC_DROP_PCT:
                        panic_reason = (
                            f"Flash crash detected: "
                            f"{price_change_pct:.2f}% in {PANIC_LOOKBACK} candles "
                            f"(from ${lookback_price:.2f} → ${current_price:.2f})"
                        )
                        await executor.engage_panic_mode(panic_reason, lock_seconds=PANIC_LOCK_SECONDS)
                        # BUG-3 FIX: Update daily_pnl from panic exit PnL
                        _panic_pnl = getattr(executor, "_last_panic_pnl", 0.0)
                        if _panic_pnl != 0.0:
                            stats["daily_pnl"] = stats.get("daily_pnl", 0.0) + _panic_pnl
                            max_loss_usd = ACCOUNT_SIZE * MAX_DAILY_LOSS_PCT / 100.0
                            if stats["daily_pnl"] < -max_loss_usd and not stats.get("daily_loss_halt"):
                                stats["daily_loss_halt"] = True
                                logger.warning("[RiskEngine] Daily loss limit hit via flash-crash panic exit. Halted.")
                        stats["active_position"] = None
                        continue

            # ── P0-3 FIX: Halt if emergency flatten failed ──────────────
            # Use a dedicated boolean flag instead of a sentinel dict so the
            # 30s heartbeat poll can't silently wipe it by setting active_position=None.
            if getattr(executor, "_flatten_failed", False):
                logger.critical(
                    f"[Main] HALTED — previous emergency_flatten FAILED. "
                    f"Manual intervention required. Restart bot after closing position."
                )
                await asyncio.sleep(60)  # Check once per minute, don't spam logs
                continue

            # ── Position exit check — track PnL for daily halt ─────
            # MED-5 FIX: Cache position state BEFORE exit check.
            # AVOID/UNWIND check runs after this block — if SL fires AND
            # ULIS returns AVOID in the same cycle, active_position is already
            # None here, so the panic trigger was silently skipped.
            had_position_before_exit = executor.active_position is not None
            if executor.active_position:
                pos_snapshot = dict(executor.active_position)
                # 3.1 FIX: Pass candle high/low so SL/TP sim triggers at correct price
                candle = feed.state.candles[-1]
                exited, pnl = await executor.check_position_exit(
                    current_price,
                    candle_high=candle.get("high"),
                    candle_low=candle.get("low")
                )
                if exited:
                    _cached_positions = None
                    await _process_exit(pnl, pos_snapshot.get("regime", "NEUTRAL"), stats, quant, executor)

                    if pnl < 0:
                        logger.warning("[Main] Stop Loss exited. Activating 5-minute Cascade Cooldown to prevent revenge trading.")

                    # H4 FIX: Retry TP placement on every cycle for positions missing TP
                    if executor.active_position is not None and not executor.dry_run:
                        await executor.attempt_tp_requeue()

                    # In live mode, simulate the exchange fill through crossover and clean up
                    if not executor.dry_run:
                        # Cancel orphaned opposing order (SL or TP)
                        filled_side = "sl" if pnl < 0 else "tp"
                        cancel_id = pos_snapshot.get("tp_order_id") if filled_side == "sl" else pos_snapshot.get("sl_order_id")
                        if cancel_id:
                            try:
                                await executor.exchange.cancel_order(cancel_id, pos_snapshot.get("symbol", ""))
                                label = "TP" if filled_side == "sl" else "SL"
                                logger.info(f"[Executor] Cancelled opposing {label} order {cancel_id} ✓")
                            except Exception as e:
                                _e = str(e).lower()
                                if "-2011" in _e or "unknown order" in _e or "not found" in _e:
                                    label = "TP" if filled_side == "sl" else "SL"
                                    logger.info(f"[Executor] Opposing {label} order {cancel_id} already gone (Binance cleaned it) ✓")
                                else:
                                    logger.warning(f"[Executor] Failed to cancel opposing order {cancel_id}: {e}")


            stats["active_position"] = executor.active_position

            # Stage 1: Compute metrics (Needed for ATR trailing stop in V3 monitor)
            metrics = quant.compute_metrics()

            # PHASE-7.1: Periodic exchange position reconciliation (every 300s)
            current_time = time.time()
            if not executor.dry_run and (current_time - _last_recon_ts) >= 300:
                _last_recon_ts = current_time
                try:
                    if _cached_positions is None:
                        _cached_positions = await executor.exchange.fetch_positions()
                    positions = _cached_positions
                    relevant_positions = [
                        p for p in positions
                        if _position_matches_feed_symbol(p) and abs(_position_contracts(p)) > 0.0001
                    ]
                    exchange_has_pos = bool(relevant_positions)
                    bot_has_pos = executor.active_position is not None
                    if exchange_has_pos and not bot_has_pos:
                        _now_ts = time.time()
                        _time_since_last_orphan = _now_ts - _last_orphan_flatten_ts
                        if _orphan_flatten_attempts == 0 or _time_since_last_orphan >= 1800:
                            _orphan_flatten_attempts += 1
                            _last_orphan_flatten_ts = _now_ts
                            _rehydrated = False
                            try:
                                db = heartbeat.get_db()
                                if db is not None:
                                    trades_ref = db.collection("botTrades") \
                                        .where("mode", "==", "LIVE") \
                                        .where("exit_price", "==", None) \
                                        .limit(50)
                                    open_trades = [
                                        doc for doc in trades_ref.stream()
                                        if _trade_matches_feed_symbol(doc.to_dict())
                                    ]
                                    open_trades.sort(
                                        key=lambda doc: int((doc.to_dict() or {}).get("ts_ms") or 0),
                                        reverse=True,
                                    )
                                    if open_trades:
                                        t = open_trades[0].to_dict()
                                        _entry = float(t.get("entry_price", 0.0))
                                        _stop = float(t.get("stop_loss", 0.0))
                                        executor.active_position = {
                                            "symbol":      t.get("symbol", FEED_SYMBOL),
                                            "side":        t.get("side", "buy"),
                                            "size":        float(t.get("size", 0.0)),
                                            "entry_price": _entry,
                                            "stop_loss":   _stop,
                                            "initial_stop_loss": _stop,
                                            "initial_risk_dist": abs(_entry - _stop),
                                            "take_profit": float(t.get("take_profit", 0.0)),
                                            "dry_run":     False,
                                            "trade_doc_id": open_trades[0].id,
                                            "partial_take_r": float(t.get("partial_take_r", 0.75) or 0.75),
                                            "partial_take_pct": float(t.get("partial_take_pct", 0.50) or 0.50),
                                            "_partial_taken": bool(t.get("_partial_taken", False)),
                                            "realized_partial_pnl": float(t.get("realized_partial_pnl", 0.0) or 0.0),
                                            "entry_ts":     float(t.get("ts_ms", 0) or 0) / 1000.0 or time.time(),
                                        }
                                        logger.warning(
                                            f"[Reconciliation] Re-hydrated position from Firestore: "
                                            f"{executor.active_position}"
                                        )
                                        _rehydrated = True
                            except Exception as rehydrate_err:
                                logger.warning(f"[Reconciliation] Re-hydration failed: {rehydrate_err}")

                            if not _rehydrated:
                                raw_position = relevant_positions[0]
                                raw_contracts = _position_contracts(raw_position)
                                raw_info = raw_position.get("info") or {}
                                raw_side = str(raw_position.get("side") or raw_info.get("positionSide") or "").lower()
                                synthetic_side = "sell" if raw_side in ("short", "sell") or raw_contracts < 0 else "buy"
                                try:
                                    synthetic_symbol = executor._get_ccxt_symbol(FEED_SYMBOL)
                                except Exception:
                                    synthetic_symbol = raw_position.get("symbol") or SYMBOL
                                try:
                                    synthetic_entry = float(
                                        raw_position.get("entryPrice")
                                        or raw_position.get("entry_price")
                                        or raw_info.get("entryPrice")
                                        or metrics.get("price")
                                        or 0.0
                                    )
                                except (TypeError, ValueError):
                                    synthetic_entry = float(metrics.get("price") or 0.0)
                                executor.active_position = {
                                    "symbol": synthetic_symbol,
                                    "side": synthetic_side,
                                    "size": abs(raw_contracts),
                                    "entry_price": synthetic_entry,
                                    "stop_loss": 0.0,
                                    "initial_stop_loss": 0.0,
                                    "initial_risk_dist": 0.0,
                                    "take_profit": 0.0,
                                    "dry_run": False,
                                    "trade_doc_id": None,
                                    "partial_take_r": 0.0,
                                    "partial_take_pct": 0.0,
                                    "_partial_taken": False,
                                    "realized_partial_pnl": 0.0,
                                    "source": "exchange_reconciliation",
                                    "entry_ts": time.time(),
                                }
                                logger.critical(
                                    f"[Reconciliation] Orphan position detected (attempt #{_orphan_flatten_attempts}) — "
                                    f"exchange has open {FEED_SYMBOL} position but bot has no tracking. "
                                    "Emergency flatten initiated."
                                )
                                try:
                                    await executor.notifier.send_error_alert(
                                        f"⚠️ Orphan position detected (attempt #{_orphan_flatten_attempts}).\n"
                                        "Bot has no SL/TP for this position.\n"
                                        "Auto-flatten initiated. If this repeats, close manually on Binance."
                                    )
                                    await executor.emergency_flatten("Orphan position detected on reconciliation")
                                    logger.info("[Reconciliation] Emergency flatten call completed.")
                                except Exception as flatten_err:
                                    logger.error(
                                        f"[Reconciliation] Emergency flatten FAILED: {flatten_err}. "
                                        "Position may still be open on exchange — MANUAL ACTION REQUIRED."
                                    )
                                    await executor.notifier.send_error_alert(
                                        f"🚨 AUTO-FLATTEN FAILED: {flatten_err}\n"
                                        "⛔ Manual intervention required on Binance."
                                    )
                            else:
                                logger.info("[Reconciliation] Position re-hydrated from Firestore — monitoring SL/TP.")
                        else:
                            remaining = int(1800 - _time_since_last_orphan)
                            logger.warning(
                                f"[Reconciliation] Orphan still detected — standing down for {remaining}s "
                                f"(attempted {_orphan_flatten_attempts}× already). Manual action may be needed."
                            )
                    elif not exchange_has_pos and bot_has_pos:
                        logger.warning(
                            "[Reconciliation] BOT thinks position open but EXCHANGE does not. "
                            "Clearing stale state."
                        )
                        try:
                            ccxt_sym = executor.active_position.get("symbol", "")
                            await executor.exchange.cancel_all_orders(ccxt_sym)
                            logger.info(f"[Reconciliation] Cancelled orphaned orders for {ccxt_sym}")
                        except Exception as cancel_err:
                            logger.warning(f"[Reconciliation] Could not cancel orphaned orders: {cancel_err}")
                        executor.active_position = None
                        executor.pending_order = None
                except Exception as e:
                    logger.warning(f"[Reconciliation] Check failed: {e}")

            # Inject CVD delta (rate-of-change) for Bayesian fusion.
            # A recovering CVD (e.g. -1450 → -950) is a bullish signal even when absolute CVD < 0.
            # LAST_CVD is 0.0 on first boot — naively computing delta would create a false spike
            # (e.g. CVD=-1500 → delta=-1500, triggering a spurious bearish signal). (Patch #5)
            if metrics is not None:
                _current_cvd = metrics.get("cvd", 0.0)
                _cvd_reset = getattr(feed.state, "_cvd_was_reset", False)
                _cvd_suppress = getattr(executor, "_cvd_reset_suppress", 0)
                if LAST_CVD == 0.0 or _cvd_reset or _cvd_suppress > 0:
                    if _cvd_reset:
                        feed.state._cvd_was_reset = False
                        executor._cvd_reset_suppress = 2
                        logger.info("[DataFeed] CVD reset detected — suppressing delta spike for 2 cycles.")
                    elif _cvd_suppress > 0:
                        executor._cvd_reset_suppress = _cvd_suppress - 1
                    LAST_CVD = _current_cvd
                    metrics["cvd_delta"] = 0.0
                else:
                    metrics["cvd_delta"] = _current_cvd - LAST_CVD
                    LAST_CVD = _current_cvd

                # Inject per-regime win-rate priors for Bayesian fusion blending
                metrics["_regime_priors"] = quant.get_all_regime_priors()
                metrics["_regime_samples"] = quant.get_regime_trade_counts()
                metrics["_regime_alpha"] = dict(quant._regime_alpha)
                metrics["_regime_beta"]  = dict(quant._regime_beta)

                # Update candle-close tracker so the candle-close gate in _compute_signal
                # knows how old the current candle is.
                if feed.state.candles:
                    LAST_CANDLE_TS = float(feed.state.candles[-1]["time"])

            if executor.active_position:

                pos = executor.active_position
                if pos:  # Might have been exited by the monitor
                    pnl_pct = (
                        (current_price - pos["entry_price"]) / pos["entry_price"] * 100
                        if pos["side"] == "buy" else
                        (pos["entry_price"] - current_price) / pos["entry_price"] * 100
                    )
                    logger.info(
                        f"[Main] HOLDING {pos['side'].upper()} @ {pos['entry_price']:.2f}"
                        f" | now={current_price:.2f} | PnL={pnl_pct:+.2f}%"
                        f" | SL={pos['stop_loss']} TP={pos['take_profit']}"
                    )
                    _time_exited, _time_pnl = await executor.check_time_exit(current_price)
                    if _time_exited:
                        await _process_exit(_time_pnl, pos.get("regime", "NEUTRAL"), stats, quant, executor)
                        continue
                    await executor.check_breakeven_and_partials(
                        current_price, metrics.get("atr", 0.0), metrics
                    )

                continue

            if metrics is None:
                logger.warning(
                    f"[Main] compute_metrics() returned None "
                    f"(candles={len(feed.state.candles)}, trades={len(feed.state.recent_trades)}). "
                    "Skipping signal evaluation this cycle."
                )
                continue

            logger.info(
                f"[Metrics] P={metrics['price']:.2f} | "
                f"RSI={metrics['rsi']:.1f} | Z={metrics['zScore']:.2f} | "
                f"Bayes={metrics['bayesianPosterior']:.2%} | Skew={metrics['skewness']:.3f} | "
                f"OFI={metrics['ofi']:.1f} | CVD={metrics['cvd']:.0f} | "
                f"ATR={metrics.get('atr', 0):.2f}({metrics.get('atr_pct', 0):.2%}) | "
                f"Tape={metrics['tapeSpeed']}/{metrics['tapeDominant']}"
            )

            # PHASE-0.2: Warn if aggTrade stream may be stale — tape metrics unreliable
            # FIX-WARN: Suppress warning during boot grace period (first 60s) where an
            # empty or incomplete trade buffer is completely normal and expected.
            _booting = getattr(feed, "_aggtrade_watchdog_first_cycle", False)
            if not metrics.get("trade_buffer_healthy", True) and not _booting:
                logger.warning(
                    f"[DataFeed] aggTrade stream stale or starved — "
                    f"last trade {time.time() - feed.state._last_trade_ts:.0f}s ago, "
                    f"buffer={len(feed.state.recent_trades)} trades. Tape/CVD metrics unreliable."
                )

            # Stages 2–7: Full signal engine
            if stats.get("operator_paused"):
                stats["last_signal"] = "WAIT"
                _queued_signal = None
                _queued_signal_price = 0.0
                logger.warning("[Operator] Entries paused by operator command. Existing exits remain managed.")
                continue

            # HIGH-4 FIX: Reset consecutive_losses when a cooldown expires so the
            # bot gets a clean slate after its penalty period. Without this reset,
            # two losses immediately after the cooldown trigger another 2-hour pause.
            if time.time() >= stats.get("cooldown_until", 0.0) and stats.get("_was_in_cooldown", False):
                stats["consecutive_losses"] = 0
                if hasattr(quant, "_consecutive_losses"):
                    quant._consecutive_losses = 0
                stats["_was_in_cooldown"] = False
                logger.info("[RiskManager] Consecutive-loss cooldown expired. Counter reset.")

            if time.time() < stats.get("cooldown_until", 0.0):
                stats["_was_in_cooldown"] = True
                # NOTE: _compute_signal is async. This branch constructs an equivalent dict
                # directly to avoid an unnecessary coroutine call during cooldown. Do not
                # replace this with a non-awaited call to _compute_signal.
                verdict_json = {
                    "verdict": "WAIT",
                    "confidence": 0.0,
                    "stop_loss": 0.0,
                    "take_profit": 0.0,
"analysis": f"Consecutive Loss Cooldown active. Resumes at {time.strftime('%H:%M:%S', time.localtime(stats['cooldown_until']))}",
                    "ulis_verdict": "—"
                }
            else:
                verdict_json = await _compute_signal(
                    metrics,
                    candle_history=feed.state.candles,
                    feed_state=feed.state,
                    daily_loss_halt=stats.get("daily_loss_halt", False),
                    drawdown_halt=stats.get("drawdown_halt", False),
                    quant=quant,
                )


            action      = verdict_json.get("verdict", "WAIT")
            conf        = float(verdict_json.get("confidence", 0))
            stop_loss   = verdict_json.get("stop_loss", 0)
            take_profit = verdict_json.get("take_profit", 0)
            analysis    = verdict_json.get("analysis", "")
            ulis_str    = verdict_json.get("ulis_verdict", "—")

            stats["last_signal"] = action
            stats["last_ulis"]   = ulis_str

            # ── Panic trigger: ULIS AVOID/UNWIND while holding a position ──
            # MED-5 FIX: Use `had_position_before_exit` (cached before exit check),
            # not executor.active_position (may be None if SL fired this same cycle).
            # Without this, a simultaneous SL+ULIS-AVOID silently skips the panic lock.
            if had_position_before_exit and ulis_str in ("AVOID", "UNWIND"):
                panic_reason = f"ULIS verdict={ulis_str} while holding position — pre-cascade danger"
                await executor.engage_panic_mode(panic_reason, lock_seconds=PANIC_LOCK_SECONDS)
                stats["active_position"] = None
                continue

            # Show real Bayes score even when blocked — conf=0% was misleading
            _bayes_display = metrics.get('bayesianPosterior', conf) if metrics else conf
            _block_tag = " [EQUITY_BLOCKED]" if action == "WAIT" and ACCOUNT_SIZE < 150.0 else ""
            logger.info(
                f"[Main] {action} | conf={conf:.0%} | bayes={_bayes_display:.0%}{_block_tag} "
                f"| SL={stop_loss} TP={take_profit} | ULIS={ulis_str}"
            )
            if analysis:
                logger.info(f"[Main] {analysis}")

            is_actionable = action in ("BUY", "SELL", "MEAN_REVERSAL_LONG", "MEAN_REVERSAL_SHORT")
            if is_actionable:
                if _in_startup_lockout:
                    remaining_lockout = int(_STARTUP_LOCKOUT_SECS - _startup_elapsed)
                    if _queued_signal is None or conf > _queued_signal.get("confidence", 0):
                        _queued_signal = verdict_json
                        _queued_signal_price = metrics["execution_price"]
                        logger.info(
                            f"[Main] ⏳ Queueing {action} (conf={conf:.0%}) during lockout "
                            f"— {remaining_lockout}s remaining. "
                            f"(SL={stop_loss} TP={take_profit})"
                        )
                    else:
                        logger.info(
                            f"[Main] ⏳ Lockout {action} (conf={conf:.0%}) — "
                            f"queued signal better ({_queued_signal.get('confidence', 0):.0%}), skipping."
                        )
                else:
                    _exec_signal = verdict_json
                    _exec_price = metrics["execution_price"]
                    _exec_ulis = ulis_str
                    if _queued_signal is not None:
                        _q_price = _queued_signal_price
                        _q_conf = _queued_signal.get("confidence", 0)
                        _q_atr = _queued_signal.get("atr_at_entry", 0)
                        _price_ok = abs(metrics["execution_price"] - _q_price) <= (_q_atr * 0.5)
                        if _price_ok and _q_conf >= conf:
                            _exec_signal = _queued_signal
                            _exec_price = metrics["execution_price"]
                            _exec_ulis = _queued_signal.get("ulis_verdict", "—")
                            _q_sl = _queued_signal.get("stop_loss", 0)
                            _q_tp = _queued_signal.get("take_profit", 0)
                            if _q_sl > 0 and _q_tp > 0 and _q_atr > 0:
                                _price_delta = _exec_price - _q_price
                                _q_dir = _queued_signal.get("verdict", "")
                                if "BUY" in _q_dir or "LONG" in _q_dir:
                                    _exec_signal = {**_queued_signal, "stop_loss": _q_sl + _price_delta, "take_profit": _q_tp + _price_delta}
                                else:
                                    _exec_signal = {**_queued_signal, "stop_loss": _q_sl - _price_delta, "take_profit": _q_tp - _price_delta}
                                logger.info(
                                    f"[Main] ▶ Executing QUEUED signal (conf={_q_conf:.0%}) "
                                    f"post-lockout — price Δ={abs(_price_delta):.2f}, "
                                    f"SL {_q_sl:.2f}→{_exec_signal['stop_loss']:.2f}, "
                                    f"TP {_q_tp:.2f}→{_exec_signal['take_profit']:.2f}"
                                )
                            else:
                                logger.info(
                                    f"[Main] ▶ Executing QUEUED signal (conf={_q_conf:.0%}) "
                                    f"post-lockout at current price."
                                )
                        else:
                            _skip_reason = "price stale" if not _price_ok else "current better"
                            logger.info(
                                f"[Main] Discarding queued signal ({_skip_reason}): "
                                f"queued={_q_conf:.0%} cur={conf:.0%} "
                                f"price_Δ={abs(metrics['execution_price']-_q_price):.2f} "
                                f"ATR×0.5={_q_atr*0.5:.2f}"
                            )
                        _queued_signal = None
                        _queued_signal_price = 0.0
                    _exec_signal["effective_price"] = _exec_price
                    _cur_equity  = ACCOUNT_SIZE + stats.get("session_pnl", 0.0)
                    _peak_equity = stats.get("equity_peak", ACCOUNT_SIZE)
                    if _cur_equity > _peak_equity:
                        stats["equity_peak"] = _cur_equity
                        _peak_equity = _cur_equity
                    _risk_base = min(MAX_RISK_PCT, 0.75) if _cur_equity < 150.0 else MAX_RISK_PCT
                    _effective_risk = _drawdown_adjusted_risk(_cur_equity, _peak_equity, _risk_base)
                    _signal_risk_mult = float(np.clip(float(_exec_signal.get("risk_multiplier", 1.0)), 0.10, 1.0))
                    if _signal_risk_mult < 1.0:
                        _effective_risk *= _signal_risk_mult
                        logger.info(
                            f"[RiskEngine] Signal risk multiplier applied: "
                            f"{_signal_risk_mult:.2f} -> risk={_effective_risk:.3f}%"
                        )
                    _fr = float(metrics.get("funding_rate", 0.0))
                    await executor.execute_signal(
                        SYMBOL, _exec_price, _exec_signal, _effective_risk,
                        account_size=ACCOUNT_SIZE, ulis_verdict=_exec_ulis,
                        funding_rate=_fr
                    )
                if executor.active_position is not None:
                    stats["total_trades"] += 1
                    if executor.active_position:
                        executor.active_position["regime"] = verdict_json.get("regime", "NEUTRAL")
                    if int(getattr(quant, "_risk_probation_trades_remaining", 0) or 0) > 0:
                        quant._risk_probation_trades_remaining -= 1
                        logger.info(
                            f"[RiskEngine] Probation trade consumed; "
                            f"{quant._risk_probation_trades_remaining} remaining."
                        )
            else:
                logger.info(f"[Main] WAIT — {analysis[:120]}")

        except asyncio.CancelledError:
            break
        except Exception as e:
            _CYCLE_ERROR_COUNT += 1
            _LAST_CYCLE_ERROR = str(e)
            if _CYCLE_ERROR_COUNT % 5 == 0:
                logger.critical(
                    f"[MainLoop] {_CYCLE_ERROR_COUNT} consecutive errors! Last: {_LAST_CYCLE_ERROR}"
                )
                if executor.notifier:
                    try:
                        await executor.notifier.send_message(
                            f"🚨 Bot error loop: {_CYCLE_ERROR_COUNT} errors. Last: {_LAST_CYCLE_ERROR[:200]}"
                        )
                    except Exception:
                        pass
                await asyncio.sleep(30)
            else:
                logger.error(f"[Main] Execution loop error: {e}", exc_info=True)
                await asyncio.sleep(5)
        except BaseException as e:
            # Catches SystemExit, KeyboardInterrupt, etc. — log before re-raising
            logger.critical(
                f"[MainLoop] FATAL unhandled BaseException — loop will die: {type(e).__name__}: {e}"
            )
            raise  # Re-raise to allow proper task/process cleanup
        else:
            _CYCLE_ERROR_COUNT = 0


# ══════════════════════════════════════════════════════════════════════
# ── ENTRY POINT ────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def main():
    validate_config()
    # 1. Initialise Firebase connection early so FirestoreLogHandler can sync startup logs
    heartbeat.init_firebase()

    # Preference: Use Ed25519 if it exists, otherwise fall back to HMAC secret
    effective_secret = BINANCE_ED25519_PRIVKEY.strip() or BINANCE_API_SECRET.strip()

    feed     = BinanceDataFeed(symbol=FEED_SYMBOL, interval=CANDLE_INTERVAL, testnet=TESTNET)
    feed.state._trade_callback = _amihud_engine.on_trade  # Wire AmihudEngine into aggTrade stream
    quant    = QuantEngine(feed.state)
    executor = TradingExecutor(
        api_key=BINANCE_API_KEY,
        api_secret=effective_secret,
        testnet=TESTNET,
        dry_run=DRY_RUN,
        exchange_id=EXCHANGE,
        tg_token=TG_BOT_TOKEN,
        tg_chat_id=TG_CHAT_ID
    )

    # NEW: Real-time fill detection via user data stream
    async def _on_ws_fill(pnl: float, fill_id: str):
        """Called immediately when exchange confirms position close."""
        if "processed_ws_fills" not in BOT_STATS:
            BOT_STATS["processed_ws_fills"] = set()
            
        if fill_id in BOT_STATS["processed_ws_fills"]:
            logger.info(f"[WsFill] Duplicate WS fill ignored: {fill_id}")
            return
            
        BOT_STATS["processed_ws_fills"].add(fill_id)
        if len(BOT_STATS["processed_ws_fills"]) > 1000:
            BOT_STATS["processed_ws_fills"] = set(list(BOT_STATS["processed_ws_fills"])[-500:])

        async with executor._position_lock:
            if executor.active_position:
                pos_regime = executor.active_position.get("regime", "NEUTRAL")
                logger.info(f"[WsFill] Position closed via ORDER_TRADE_UPDATE PnL=${pnl:.2f}")
                await _process_exit(pnl, pos_regime, BOT_STATS, quant, executor)
                executor.active_position = None  # P2 FIX: clear so REST/poll path doesn't double-count
                executor.pending_order = None
                BOT_STATS["active_position"] = None

    def _task_death_callback(task: asyncio.Task):
        """Log and alert if any critical task dies unexpectedly."""
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            exc = None  # Normal shutdown
        except Exception:
            exc = None
        if exc is not None:
            logger.critical(
                f"[Main] CRITICAL — task '{task.get_name()}' died with "
                f"{type(exc).__name__}: {exc}",
                exc_info=exc
            )
            if getattr(executor, 'notifier', None):
                asyncio.create_task(
                    executor.notifier.send_error_alert(
                        f"💀 Task '{task.get_name()}' crashed: {type(exc).__name__}: {str(exc)[:200]}\n"
                        "Bot may need restart."
                    )
                )

    if not DRY_RUN and BINANCE_API_KEY:
        feed._uds_task = asyncio.create_task(
            feed.run_user_data_stream(BINANCE_API_KEY, _on_ws_fill),
            name="user_data_stream"
        )
        feed._uds_task.add_done_callback(_task_death_callback)  # P3 FIX: supervised — alerts on unexpected death

    # PHASE-4.2: Seed HMM observations from REST historical candles on startup
    # This gives the HMM meaningful priors from the first cycle instead of
    # requiring ~7 minutes of uniform posterior before it produces useful regimes.
    _seeded = False
    try:
        import numpy as np
        rest_candles = await feed._fetch_historical_candles_rest()
        if rest_candles and len(rest_candles) >= 20:
            closes = np.array([c["close"] for c in rest_candles], dtype=float)
            highs  = np.array([c["high"]  for c in rest_candles], dtype=float)
            lows   = np.array([c["low"]   for c in rest_candles], dtype=float)
            vols   = np.array([c["volume"]for c in rest_candles], dtype=float)
            for i in range(20, len(rest_candles)):
                window = closes[max(0, i-50):i+1]
                atr_pct = (highs[i] - lows[i]) / closes[i] if closes[i] > 0 else 0.005
                z_approx = abs((closes[i] - window.mean()) / (window.std() + 1e-9))
                tape_proxy = "NORMAL"
                _hmm_classifier.classify(atr_pct, z_approx, tape_proxy, atr_pct_rank=0.5)
            logger.info(f"[HMM] Seeded with {len(rest_candles)-20} historical observations from REST candles.")
            _seeded = True

            # FIX-BUG1: Reset HMM hysteresis state AFTER seeding completes.
            # During seeding, _hmm_classifier.classify() is called on every historical
            # candle, flipping _candidate_regime and _candidate_streak randomly.
            # Without this reset, the bot enters live trading with a random committed
            # regime from the middle of the seed sequence. Force a clean slate.

            # FIX WARN-1: Run a focused 5-candle pass on the most recent candles to
            # set the correct live-market regime BEFORE committing. Then clear the
            # obs buffer so live forward passes start from scratch, not 480 seed candles
            # that may represent different market conditions.
            if len(rest_candles) >= 5:
                _raw_regimes = []
                for _rc in rest_candles[-5:]:
                    _live_atr = (_rc["high"] - _rc["low"]) / max(_rc["close"], 1.0)
                    _hmm_classifier.classify(_live_atr, 0.0, "NORMAL", atr_pct_rank=0.5)
                    _raw_regimes.append(_hmm_classifier._candidate_regime)
                from collections import Counter
                _modal_regime = Counter(_raw_regimes).most_common(1)[0][0] if _raw_regimes else _hmm_classifier._candidate_regime
                _hmm_classifier._committed_regime = _modal_regime
                _hmm_classifier._candidate_regime = _modal_regime
            else:
                _hmm_classifier._committed_regime = _hmm_classifier._candidate_regime

            _hmm_classifier._candidate_streak = _hmm_classifier.HYSTERESIS_CANDLES
            _hmm_classifier._obs_buf.clear()
            logger.info(
                f"[HMM] Post-seed hysteresis reset: committed={_hmm_classifier._committed_regime}, "
                f"streak={_hmm_classifier._candidate_streak} (obs buffer cleared)"
            )

            # FIX-P1: Pre-seed quant._atr_history from REST candles (audit Problem 1).
            # Without this, _atr_history starts EMPTY. The first live ATR appended is
            # simultaneously min AND max → np.mean(arr <= atr) = 1.0 = 100% rank always.
            # This triggers PANIC SL (1.0×ATR not 1.43×ATR) on EVERY single entry.
            # Fix: compute rolling Wilder ATR at each historical step and seed the deque.
            _atr_seeded = 0
            for i in range(15, len(rest_candles)):
                _h = highs[max(0, i-43):i+1]
                _l = lows[max(0, i-43):i+1]
                _c = closes[max(0, i-43):i+1]
                if len(_c) >= 15:
                    _pc = _c[:-1]
                    _tr = np.maximum(_h[1:]-_l[1:], np.maximum(np.abs(_h[1:]-_pc), np.abs(_l[1:]-_pc)))
                    if len(_tr) >= 14:
                        _av = float(np.mean(_tr[:14]))
                        for _j in range(14, len(_tr)):
                            _av = (_av * 13 + float(_tr[_j])) / 14
                        quant._atr_history.append(_av)
                        _atr_seeded += 1
            logger.info(
                f"[ATR] Pre-seeded _atr_history: {_atr_seeded} values "
                f"(deque={len(quant._atr_history)}). "
                "atr_pct_rank now meaningful from first live cycle."
            )

            # BUG-2 FIX: Seed VWAP with correct historical timestamps.
            # Using wall-clock time for all REST candles makes the 24h expiry treat
            # all 480 candles as "just arrived", inflating std dev and zeroing the Z-score.
            quant.seed_vwap_from_history(
                candles=rest_candles,
                highs=[c["high"]  for c in rest_candles],
                lows= [c["low"]   for c in rest_candles],
                closes=[c["close"] for c in rest_candles],
                vols=  [c["volume"] for c in rest_candles],
            )
    except Exception as e:
        logger.warning(f"[HMM] HMM seeding from history failed (will use cold-start): {e}")

    # NOTE (CRIT-2 FIX): set_leverage was moved to execution_loop() so it runs
    # AFTER executor.initialize() has loaded markets. Setting leverage before
    # load_markets() means CCXT has no symbol info and Binance may silently reject it.

    loop           = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()

    def _handle_signal():
        logger.info("[Main] Shutdown signal received.")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass

    _exec_task = asyncio.create_task(
        execution_loop(feed, quant, executor, BOT_STATS), name="exec_loop"
    )
    _exec_task.add_done_callback(_task_death_callback)

    tasks = [
        asyncio.create_task(feed.run(),                    name="data_feed"),
        asyncio.create_task(feed.run_aggtrade(),           name="aggtrade_spot"),   # FIX-A: separate aggTrade on Spot WS
        asyncio.create_task(feed.funding_rate_loop(),      name="funding_rate"),
        asyncio.create_task(_derivatives_refresh_loop(),  name="deriv_refresh"),  # FIX-7.1: background derivatives
        asyncio.create_task(macro_shield.run_calendar_loop(), name="macro_calendar"),
        asyncio.create_task(macro_shield.run_dxy_loop(),      name="macro_dxy"),
        asyncio.create_task(_operator_command_loop(executor, BOT_STATS), name="operator_commands"),
        _exec_task,
        asyncio.create_task(heartbeat.run_heartbeat(BOT_STATS), name="heartbeat"),
        # P0-2 FIX: Feed health monitor — detects frozen WebSocket and forces reconnect
        asyncio.create_task(
            feed.feed_health_monitor(notifier=executor.notifier),
            name="feed_health_monitor"
        ),
        # P4 FIX: User-data stream task added to shutdown list so it is cancelled on exit
        *([feed._uds_task] if getattr(feed, '_uds_task', None) is not None else []),
    ]

    # ── Startup notification ──────────────────────────────────────────
    await executor.notifier.send_startup_alert(
        symbol=SYMBOL,
        exchange=EXCHANGE,
        mode="DRY-RUN" if DRY_RUN else "LIVE",
        leverage=LEVERAGE,
        interval=CANDLE_INTERVAL,
    )

    try:
        await shutdown_event.wait()
    except asyncio.CancelledError:
        pass
    finally:
        logger.info("[Main] Stopping…")
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        feed.stop()
        
        # MISS-5: Graceful shutdown order cancellation
        try:
            if not executor.dry_run and getattr(executor, 'exchange', None):
                ccxt_symbol = executor._get_ccxt_symbol(FEED_SYMBOL)
                await executor.exchange.cancel_all_orders(ccxt_symbol)
                logger.info("[Main] Cancelled all pending orders on shutdown.")
        except Exception as e:
            logger.warning(f"[Main] Failed to cancel orders on shutdown: {e}")

        await executor.close()
        await heartbeat.write_offline(BOT_STATS)
        logger.info("[Main] Bot stopped cleanly.")


if __name__ == "__main__":
    print("🤖 [Quad-Desk] Python process started — launching bot...", flush=True)
    asyncio.run(main())

