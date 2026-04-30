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
import time
import numpy as np
from datetime import date
from typing import Dict, Any, Optional, Tuple, List

from dotenv import load_dotenv
load_dotenv()

from bot.data_feed import BinanceDataFeed
from bot.quant_engine import QuantEngine
from bot.executor import TradingExecutor
from bot.ulis_engine import compute_ulis_verdict
from bot import heartbeat
from bot.signal_config import (
    REGIME_PARAMS, POST_TRADE_COOLDOWN_S, COLD_START_TRADE_COUNT, 
    COLD_START_CONFIDENCE_DISCOUNT,
    MAX_RISK_PCT as CFG_MAX_RISK_PCT,
    MAX_DAILY_LOSS_PCT as CFG_MAX_DAILY_LOSS_PCT,
    MAX_DRAWDOWN_PCT as CFG_MAX_DRAWDOWN_PCT,
    MIN_BAYESIAN as CFG_MIN_BAYESIAN
)

# ──────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
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
TESTNET             = os.environ.get("BOT_TESTNET",             "false").lower() != "false"
MAX_RISK_PCT        = float(os.environ.get("BOT_MAX_RISK_PCT",        str(CFG_MAX_RISK_PCT)))
MAX_DAILY_LOSS_PCT  = float(os.environ.get("BOT_MAX_DAILY_LOSS_PCT",  str(CFG_MAX_DAILY_LOSS_PCT)))
ANALYSIS_INTERVAL   = int(os.environ.get("BOT_ANALYSIS_INTERVAL",    "15"))
CANDLE_INTERVAL     = os.environ.get("BOT_CANDLE_INTERVAL",      "15m")
MIN_CONFIDENCE      = float(os.environ.get("BOT_MIN_CONFIDENCE",      str(CFG_MIN_BAYESIAN)))
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

# Data feed always uses Binance public WS; normalise symbol to BTCUSDT style
if EXCHANGE == "coinbase":
    base = SYMBOL.replace("/", "-").split("-")[0]
    FEED_SYMBOL = f"{base}USDT"
else:
    # BTC/USDT  → BTCUSDT  |  BTCUSDT → BTCUSDT
    FEED_SYMBOL = SYMBOL.replace("/", "").split(":")[0]

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
    "daily_loss_halt": False,
    "consecutive_losses": 0,
    "cooldown_until":     0.0,
    "gate_stats": {
        "daily_loss_halt":           0,
        "drawdown_halt":             0,
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
    },
}

GATE_STATS_LAST_LOG = 0.0  # timestamp of last 30-min gate summary
_CYCLE_ERROR_COUNT = 0  # PHASE-3.1: Consecutive cycle errors for escalation
_LAST_CYCLE_ERROR = ""  # PHASE-3.1: Last error string for escalation

LAST_CASCADE_TIME = 0.0
LAST_CVD: float   = 0.0  # Track previous CVD value so execution loop can compute delta
LAST_CANDLE_TS: float = 0.0  # Track last confirmed 15m candle open-time for candle-close gate
LAST_ANY_TRADE_CLOSE_TIME = 0.0  # Track any trade exit for post-trade cooldown
LAST_TRADE_WAS_SL: bool = False  # Track if last exit was SL for split cooldown logic


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
            f"  daily_loss_halt      : {g.get('daily_loss_halt', 0)}\n"
            f"  drawdown_halt       : {g.get('drawdown_halt', 0)}\n"
            f"  zscore_warmup       : {g.get('zscore_warmup', 0)}\n"
            f"  post_trade_cooldown : {g.get('post_trade_cooldown', 0)}\n"
            f"  cascade_cooldown    : {g.get('cascade_cooldown', 0)}\n"
            f"  regime_no_edge      : {g.get('regime_no_edge', 0)}\n"
            f"  htf_counter_trend   : {g.get('htf_counter_trend', 0)}\n"
            f"  funding_blocks      : {g.get('funding_blocks_long', 0) + g.get('funding_blocks_short', 0)}\n"
            f"  ulis_veto           : {g.get('ulis_veto', 0)}\n"
            f"  ulis_alignment_fail : {g.get('ulis_alignment_fail', 0)}\n"
            f"  low_confidence      : {g.get('confidence_below_threshold', 0)}\n"
            f"  candle_gate_expired : {g.get('candle_gate_expired', 0)}\n"
            f"  micro_confirms_fail : {g.get('micro_confirms_failed', 0)}\n"
            f"  sweep_confirms_fail : {g.get('sweep_confirms_failed', 0)}\n"
            f"  fee_geometry        : {g.get('fee_geometry', 0)}\n"
            f"  signal_none         : {g.get('signal_none', 0)}\n"
            f"  ───────────────────────\n"
            f"  total rejections    : {total}\n"
            f"  total passed       : {passed}\n"
            f"  pass rate           : {passed/(passed+total+1):.1%}\n"
            f"  last_confidence     : {confidence:.2%}"
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


# ══════════════════════════════════════════════════════════════════════
# ── HMM REGIME CLASSIFIER (3-state, pure numpy) ───────────────────────
# ══════════════════════════════════════════════════════════════════════

class _HMMRegimeClassifier:
    """
    3-state Gaussian Hidden Markov Model regime detector.

    States:
        0 = RANGE     — low ATR, low |Z|, quiet tape
        1 = TREND     — moderate/high ATR, directional bias, louder tape
        2 = VOLATILE  — high ATR, extreme |Z|, erratic — maps to NEUTRAL

    Features (per observation):
        f0 = atr_pct       (0 – 0.02)
        f1 = abs(z_score)  (0 – 4)
        f2 = tape_binary   (0 = NORMAL, 1 = SCREAMING)

    Upgrades (Apr 2026):
        1. Forward algorithm → posterior probability vector P(state | obs_1...T)
        2. 70% confidence gate — low-confidence ⇒ NEUTRAL (no action)
        3. 3-candle hysteresis — regime change requires 3 consecutive agreements
    """

    # --- Emission means (μ) per state × feature -----------------------
    # Features: [atr_pct, |z_score|, tape_binary, atr_pct_rank]
    #   f0 = atr_pct       (0 – 0.02)  raw ATR as fraction of price
    #   f1 = abs(z_score)  (0 – 4)
    #   f2 = tape_binary   (0 = NORMAL, 1 = SCREAMING)
    #   f3 = atr_pct_rank  (0 – 1)   percentile rank in 30-day window (P2)
    _MU = np.array([
        [0.003, 0.8, 0.05, 0.20],  # RANGE
        [0.007, 1.5, 0.30, 0.55],  # TREND — retained at 0.007 per CPO
        [0.014, 2.5, 0.65, 0.85],  # VOLATILE
    ], dtype=float)
    _SIGMA = np.array([
        [0.0010, 0.40, 0.10, 0.10],  # RANGE — COMPRESSED (was 0.0015,0.6,0.15,0.15)
        [0.0030, 0.80, 0.25, 0.20],  # TREND
        [0.0050, 1.00, 0.30, 0.15],  # VOLATILE
    ], dtype=float)

    # --- Transition matrix (rows = from-state, cols = to-state) -------
    # 80% persistence, 10% to each neighbour state
    _A = np.array([
        [0.82, 0.12, 0.06],
        [0.10, 0.80, 0.10],
        [0.06, 0.12, 0.82],
    ], dtype=float)

    # --- Initial state distribution ------------------------------------
    _PI = np.array([0.50, 0.35, 0.15], dtype=float)

    # State labels (index → regime string)
    _LABELS = ["RANGE", "TREND", "NEUTRAL"]  # VOLATILE maps to NEUTRAL

    # Confidence & hysteresis thresholds
    MIN_CONFIDENCE       = 0.60  # PHASE-2.2: was 0.70, lowered to 60% for faster HMM transitions
    HYSTERESIS_CANDLES   = 3     # Consecutive candles before regime change

    def __init__(self, window: int = 60, update_every: int = 50):
        self._window    = window
        self._update_n  = update_every
        self._obs_buf   = []          # circular feature history
        self._cycle     = 0           # count calls since last param update
        # Mutable copies so online-update can adjust them
        self._mu    = self._MU.copy()
        self._sigma = self._SIGMA.copy()
        # Hysteresis state
        self._committed_regime = "RANGE"   # currently committed regime
        self._candidate_regime = "RANGE"   # regime the HMM is suggesting
        self._candidate_streak = 0         # consecutive candles suggesting candidate

    # ------------------------------------------------------------------
    def _gaussian_log_prob(self, obs: np.ndarray) -> np.ndarray:
        """Log P(obs | state) for all 3 states. obs shape = (F,)."""
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
        posterior = np.maximum(posterior, 0.0)
        total = posterior.sum()
        if total > 0:
            posterior /= total
        else:
            posterior = np.array([0.50, 0.35, 0.15])  # fallback to prior

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
        if len(self._obs_buf) < 20:
            return
        obs = np.array(self._obs_buf[-self._window:], dtype=float)
        states = self._viterbi(obs)
        for s in range(3):
            mask = states == s
            if mask.sum() >= 3:
                self._mu[s]    = obs[mask].mean(axis=0)
                self._sigma[s] = np.maximum(obs[mask].std(axis=0), 1e-4)

    # ------------------------------------------------------------------
    def classify(self, atr_pct: float, z_score: float, tape: str,
                 atr_pct_rank: float = 0.5) -> dict:
        """
        Main entry: add one observation and return regime probability vector.

        Args:
            atr_pct:      ATR as fraction of price (e.g. 0.007 = 0.7%)
            z_score:      VWAP Z-score
            tape:         'SCREAMING' | 'NORMAL'
            atr_pct_rank: ATR percentile rank in 30-day rolling window [0,1] (P2)

        Returns dict with:
            regime:     str   — committed regime label (with hysteresis)
            confidence: float — posterior probability of the committed regime
            p_range:    float — P(RANGE | observations)
            p_trend:    float — P(TREND | observations)
            p_volatile: float — P(VOLATILE | observations)
            raw_regime: str   — instantaneous HMM output (before hysteresis)
        """
        obs = np.array([
            float(np.clip(atr_pct,      0.0,  0.03)),
            float(np.clip(abs(z_score), 0.0,  4.0)),
            1.0 if tape == "SCREAMING" else 0.0,
            float(np.clip(atr_pct_rank, 0.0,  1.0)),  # P2: 4th feature
        ], dtype=float)

        self._obs_buf.append(obs)
        self._cycle += 1

        if self._cycle % self._update_n == 0:
            self._online_update()

        # Need at least 3 observations for a meaningful forward pass
        n_obs = min(len(self._obs_buf), self._window)
        seq   = np.array(self._obs_buf[-n_obs:], dtype=float)

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
                "p_range": 0.33, "p_trend": 0.33, "p_volatile": 0.33,
                "raw_regime": raw,
            }

        # ── Forward algorithm: posterior probability vector ────────────
        posterior = self._forward(seq)
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
        if (self._candidate_regime != self._committed_regime
                and self._candidate_streak >= self.HYSTERESIS_CANDLES
                and raw_conf >= self.MIN_CONFIDENCE):
            old = self._committed_regime
            self._committed_regime = self._candidate_regime
            logger.info(
                f"[HMM] Regime TRANSITION: {old} → {self._committed_regime} "
                f"(conf={raw_conf:.1%}, streak={self._candidate_streak})"
            )

        # The committed regime's confidence is its actual posterior probability
        committed_idx = self._LABELS.index(self._committed_regime)
        committed_conf = float(posterior[committed_idx])

        logger.debug(
            f"[HMM] raw={raw_label}({raw_conf:.0%}) committed={self._committed_regime}"
            f"({committed_conf:.0%}) streak={self._candidate_streak} | "
            f"P=[R:{posterior[0]:.0%} T:{posterior[1]:.0%} V:{posterior[2]:.0%}]"
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
_hmm_classifier = _HMMRegimeClassifier(window=60, update_every=200)



def _detect_regime(
    metrics: Dict[str, Any],
    buy_walls: List[float],
    sell_walls: List[float],
    quant,  # PHASE-1.3: Reference to QuantEngine for stateful tracking
    sweep: Optional[str] = None,
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
        # Wall significance filter: only override if wall is ≥ 3× median level
        all_levels = list(metrics.get("bid_depths", {}).values()) + list(metrics.get("ask_depths", {}).values())
        median_level = float(np.median(all_levels)) if all_levels else 0.0

        # Check which wall is near
        nearest_buy = buy_walls[0] if buy_walls else None
        nearest_sell = sell_walls[0] if sell_walls else None
        near_wall_size = 0.0
        near_wall_is_buy = False
        if nearest_buy and abs(price - nearest_buy) / price <= WALL_PROXIMITY:
            near_wall_size = metrics.get("bid_depths", {}).get(nearest_buy, 0.0)
            near_wall_is_buy = True
        elif nearest_sell and abs(price - nearest_sell) / price <= WALL_PROXIMITY:
            near_wall_size = metrics.get("ask_depths", {}).get(nearest_sell, 0.0)

        wall_is_significant = (median_level > 0 and near_wall_size >= median_level * 3.0)

        if wall_is_significant:
            metrics["regime_confidence"] = 1.0
            metrics["regime_probs"] = {"RANGE": 0.0, "TREND": 0.0, "NEUTRAL": 0.0, "LIQUIDITY": 1.0}
            quant._liquidity_consecutive += 1
            if quant._liquidity_consecutive > 3 and sweep is None:
                logger.info("[Regime] LIQUIDITY cap reached — falling through to HMM")
                quant._liquidity_consecutive = 0
            else:
                return "LIQUIDITY"
        else:
            # Wall is near but not significant — reset counter and fall through
            quant._liquidity_consecutive = 0
    else:
        quant._liquidity_consecutive = 0

    # HMM classification → probability vector (P2: pass 4th feature)
    atr_pct_rank = metrics.get("atr_pct_rank", 0.5)
    hmm_result = _hmm_classifier.classify(atr_pct, z, tape, atr_pct_rank)

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

def _detect_liquidity_sweep(metrics: Dict[str, Any],
                             buy_walls: List[float],
                             sell_walls: List[float],
                             candle_history: list) -> Optional[str]:
    if len(candle_history) < 2 or not sell_walls or not buy_walls:
        return None

    price = metrics["price"]
    nearest_sell = sell_walls[0]
    nearest_buy  = buy_walls[0]

    # STRATEGY-C: Check BOTH previous (-2) AND current (-1) candle for sweeps.
    # Old code only checked [-2] — if the current candle sweeps a wall and reverses,
    # we wouldn't detect it until candle close, by which time CandleGate may stale it.
    for idx, label in [(-2, "prev"), (-1, "live")]:
        candle = candle_history[idx]

        if candle["high"] > nearest_sell and price < nearest_sell:
            logger.info(f"[Sweep] ABOVE_HIGHS at {nearest_sell:.2f} (src={label} candle)")
            return "ABOVE_HIGHS", float(candle["time"])

        if candle["low"] < nearest_buy and price > nearest_buy:
            logger.info(f"[Sweep] BELOW_LOWS at {nearest_buy:.2f} (src={label} candle)")
            return "BELOW_LOWS", float(candle["time"])

    return None, None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 4 — STRATEGY LAYER ──────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _strategy_trend(metrics: Dict[str, Any]) -> Optional[str]:
    bayes      = metrics["bayesianPosterior"]
    ofi        = metrics["ofi"]
    cvd        = metrics["cvd"]
    dominant   = metrics["tapeDominant"]
    tape_speed = metrics.get("tapeSpeed", "NORMAL")  # Added: differentiate SCREAMING vs NORMAL tape

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
    """FIX NEW-C3: Dynamic RSI gates — adaptive to ATR rank."""
    z = metrics.get("zScore", 0.0)
    rsi = metrics.get("rsi", 50.0)
    atr_rank = metrics.get("atr_pct_rank", 0.5)
    if atr_rank < 0.5:
        rsi_long_gate = 55.0
        rsi_short_gate = 45.0
    else:
        rsi_long_gate = 42.0
        rsi_short_gate = 58.0
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

    # [IMPROVED] SWEEP NEUTRALIZER: context-aware confidence floor.
    # STRATEGY-A: Raised floors from 0.52/0.55/0.60 → 0.55/0.58/0.65.
    # A confirmed sweep with 2/3 micro-confirms is the highest-conviction setup —
    # the old floors were too conservative and caused sweeps to fail the
    # min_confidence gate even when all evidence aligned.
    if is_sweep:
        strong_confirm = (
            (is_long  and ofi >  0.3 and cvd_delta > 0) or
            (not is_long and ofi < -0.3 and cvd_delta < 0)
        )
        mild_confirm = (
            (is_long  and (ofi > 0.15 or cvd_delta > 0)) or
            (not is_long and (ofi < -0.15 or cvd_delta < 0))
        )
        if strong_confirm:
            p_signal_prior = max(0.65, p_signal_prior)   # was 0.60
        elif mild_confirm:
            p_signal_prior = max(0.58, p_signal_prior)   # was 0.55
        else:
            p_signal_prior = max(0.55, p_signal_prior)   # was 0.52

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

    # 8. Convert back to probability — MUST happen before regime blending (Fix #1: UnboundLocalError)
    p_final = odds / (1.0 + odds)

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

    if is_long and ulis_bearish:
        logger.warning(f"[ULIS] Direction conflict — bot=LONG, ULIS={verdict_str}. Skipping.")
        return False, 0.0, verdict_str

    if not is_long and ulis_bullish:
        logger.warning(f"[ULIS] Direction conflict — bot=SHORT, ULIS={verdict_str}. Skipping.")
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
    adjusted = min(1.0, confidence + boost)
    logger.info(
        f"[ULIS] PASS — {verdict_str} | "
        f"vector={ulis['liquidity_vector']:.3f} | "
        f"cascade={ulis['cascade_risk']:.2f} | "
        f"conf: {confidence:.2%} → {adjusted:.2%}"
    )
    return True, adjusted, verdict_str


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 7 — RISK ENGINE ─────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

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
) -> Tuple[float, float]:
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
        recent_atr = _calc_atr_from_candles(recent_candles)
        baseline_atr = _calc_atr_from_candles(baseline_candles)
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

    # Phase 5: Funding Rate Risk Scalar
    # If funding strongly favors our direction, scale up risk by 1.2x
    funding_rate = metrics.get("funding_rate", 0.0) if metrics else 0.0
    funding_mult = 1.0
    if funding_rate < -0.0005 and is_long:
        funding_mult = 1.2  # shorts paying longs — bullish pressure
    elif funding_rate > 0.0005 and not is_long:
        funding_mult = 1.2  # longs paying shorts — bearish pressure

    if funding_mult > 1.0:
        SL_MULT *= funding_mult
        logger.info(f"[RiskEngine] Funding rate multiplier: {funding_mult}x (funding={funding_rate:.4f})")

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
        return sl_tp(max(sl_dist, atr * SL_MULT))
    elif strategy_type == "TREND":
        return sl_tp(atr * SL_MULT)
    elif strategy_type == "MEAN_REVERSION":
        return sl_tp(atr * SL_MULT)
    else:
        return sl_tp(price * 0.008)


# ══════════════════════════════════════════════════════════════════════
# ── FULL 7-STAGE SIGNAL ENGINE ────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _compute_signal(
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

    if daily_loss_halt:
        logger.warning("[RiskEngine] Daily loss limit hit — all trading halted today.")
        _gate_stats_summary("daily_loss_halt")
        return {**WAIT, "analysis": "Daily loss limit reached. Halted."}

    if drawdown_halt:
        logger.warning("[RiskEngine] Max drawdown breached — all trading halted. Restart bot to resume.")
        _gate_stats_summary("drawdown_halt")
        return {**WAIT, "analysis": "Max drawdown breached. Restart bot to resume."}

    # PHASE-0.4: Z-Score session guard
    # Z-score is statistically meaningless with fewer than 10 bars — it fits noise.
    if not metrics.get("z_score_valid", True):
        _gate_stats_summary("zscore_warmup")
        return {**WAIT, "analysis": "Session warmup: Z-Score not yet valid (<10 bars)."}

    global LAST_CASCADE_TIME
    import time
    # NOTE: Cascade cooldown moved AFTER regime detection (Strategy-B)
    # so it can use regime-adaptive duration from REGIME_PARAMS.

    # Universal post-trade cooldown: POST_TRADE_COOLDOWN_S after any exit (SL or TP)
    global LAST_ANY_TRADE_CLOSE_TIME
    time_since_last_trade = time.time() - LAST_ANY_TRADE_CLOSE_TIME
    # FREQ-1: wire split cooldown — 45s after TP, 90s after SL
    _last_was_sl = LAST_TRADE_WAS_SL
    _cooldown = POST_TRADE_COOLDOWN_S if _last_was_sl else 45
    if time_since_last_trade < _cooldown:
        _gate_stats_summary("post_trade_cooldown")
        return {**WAIT, "analysis": f"Post-trade cooldown ({_cooldown - int(time_since_last_trade)}s remain, {'SL' if _last_was_sl else 'TP'} exit)"}

    global LAST_CANDLE_TS
    import time as _time

    price = metrics["price"]
    atr   = metrics.get("atr", price * 0.005)
    vpoc  = metrics.get("vpoc")

    # Stage 1: Parse walls
    buy_walls  = [p for p, _ in metrics.get("top_buy_walls", [])]
    sell_walls = [p for p, _ in metrics.get("top_sell_walls", [])]

    # Stage 1b: Pre-detect sweep (needed for LIQUIDITY cap in _detect_regime)
    sweep, sweep_ts = _detect_liquidity_sweep(metrics, buy_walls, sell_walls, candle_history)

    # Stage 2: Regime
    regime = _detect_regime(metrics, buy_walls, sell_walls, quant=quant, sweep=sweep)
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
    time_since_cascade = time.time() - LAST_CASCADE_TIME
    if time_since_cascade < cascade_cd:
        remaining = cascade_cd - int(time_since_cascade)
        _gate_stats_summary("cascade_cooldown")
        return {**WAIT, "analysis": f"WAIT (Cascade Cooldown: {remaining}s remain, regime={regime})"}

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
                if is_long_dir and fr > 0.00015:
                    logger.warning(f"[Anti-Squeeze] Blocking LONG trend trade; crowded funding rate: {fr:.4%}")
                    _gate_stats_summary("funding_blocks_long")
                    return {**WAIT, "analysis": f"Funding Rate {fr:.4%} > 0.015%. Blocked long."}
                if not is_long_dir and fr < -0.00015:
                    logger.warning(f"[Anti-Squeeze] Blocking SHORT trend trade; crowded funding rate: {fr:.4%}")
                    _gate_stats_summary("funding_blocks_short")
                    return {**WAIT, "analysis": f"Funding Rate {fr:.4%} < -0.015%. Blocked short."}
            except (ValueError, TypeError):
                pass

    # Stage 5: Bayesian fusion (P1: regime_priors already injected into metrics upstream)
    confidence = _bayesian_fusion(metrics, raw_direction, regime, is_sweep=bool(sweep))

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
    regime_min_conf = max(
        regime_p["min_confidence"] - cold_start_discount,
        MIN_CONFIDENCE * 0.8
    )
    if confidence < regime_min_conf:
        _gate_stats_summary("confidence_below_threshold")
        return {**WAIT, "analysis": (
            f"Regime={regime} strategy={strategy_type} signal={raw_direction} "
            f"but P={confidence:.2%} < regime threshold={regime_min_conf:.0%}"
        )}

    # Stage 7: Risk engine — P0: adaptive ATR multipliers from regime params
    stop_loss, take_profit = _risk_engine(
        raw_direction, strategy_type, price, atr, buy_walls, sell_walls, sweep,
        sl_mult=regime_p["atr_multiplier_sl"],
        tp_mult_ratio=regime_p["rr_target"],
        candle_history=candle_history,
        metrics=metrics,  # BUG-4: pass for atr_pct_rank vol scaling
        regime_p=regime_p,  # PHASE-3.2: pass for panic_threshold
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
    tp_gain_pct = abs(take_profit - price) / price          # % gain if TP hit
    round_trip_fee = _EXCHANGE_FEE_RATE * 2                  # entry + exit fee
    min_viable_tp_pct = round_trip_fee * 2.0                 # P3 FIX: 2.0× fee buffer (raised from 1.2×). TP must be 2× round-trip fee to be viable after slippage.
    if tp_gain_pct < min_viable_tp_pct:
        logger.warning(
            f"[FeeCheck] TP gain {tp_gain_pct:.3%} < min viable {min_viable_tp_pct:.3%} "
            f"(round-trip fee={round_trip_fee:.2%}). Trade not profitable after fees. Skipping."
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

    return {
        "verdict":      verdict,
        "confidence":   round(confidence, 4),
        "stop_loss":    stop_loss,
        "take_profit":  take_profit,
        "analysis":     analysis,
        "ulis_verdict": ulis_verdict_str,
        "regime":       regime,   # P1: stored in position for per-regime Beta update on exit
        "be_lock_trigger": regime_p.get("be_lock_trigger", 1.0),
        "atr_at_entry": atr,      # stored in position for any future trailing logic
    }


# ══════════════════════════════════════════════════════════════════════
# ── CORE EXECUTION LOOP ────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def execution_loop(
    feed,
    quant: QuantEngine,
    executor: TradingExecutor,
    stats: Dict[str, Any],
):
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

    if not executor.dry_run:
        try:
            fetched_bal = await executor.get_usdt_balance(ACCOUNT_SIZE)
            if fetched_bal != ACCOUNT_SIZE and fetched_bal > 0:
                logger.info(f"[Main] Overriding BOT_ACCOUNT_SIZE with dynamically fetched live balance: ${fetched_bal:.2f}")
                ACCOUNT_SIZE = fetched_bal
        except Exception as e:
            logger.warning(f"[Main] Could not dynamically fetch account balance at startup: {e}")

    EQUITY_MIN_TRADEABLE = 200.0
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
            await asyncio.sleep(ANALYSIS_INTERVAL)

            n_candles = len(feed.state.candles)
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
                # PHASE-3.1: Drawdown halt must reset daily, not require manual restart
                if stats.get("drawdown_halt"):
                    stats["drawdown_halt"] = False
                    stats["session_pnl"] = 0.0
                    logger.warning("[RiskEngine] New day — drawdown halt LIFTED, session PnL reset.")
                # 3.6 FIX: Reset CVD anchor daily to prevent multi-day drift
                feed.state.cvd = 0.0
                LAST_CVD = 0.0
                logger.info("[RiskEngine] 🌅 Daily counters + CVD reset for new trading session.")
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

            current_price = feed.state.candles[-1]["close"]

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
            if _last_candle_age > _interval_secs * 2.5:
                logger.warning(
                    f"[Main] ⚠️ Candle feed STALE ({_last_candle_age:.0f}s old, "
                    f">{_interval_secs * 2.5:.0f}s threshold). "
                    f"Triggering REST prefetch and skipping cycle."
                )
                asyncio.create_task(feed._fetch_historical_candles_rest())
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
                _hb_exited, _hb_pnl = await executor._check_live_position_exit(current_price)
                if _hb_exited:
                    _cached_positions = None  # PHASE-3.4: Invalidate cache after exit
                    logger.info(f"[Heartbeat] Position closed detected via 30s poll. PnL=${_hb_pnl:.2f}")
                    new_daily = stats.get("daily_pnl", 0.0) + _hb_pnl
                    stats["daily_pnl"] = new_daily
                    LAST_ANY_TRADE_CLOSE_TIME = time.time()
                    LAST_TRADE_WAS_SL = (_hb_pnl < 0)
                    if _hb_pnl < 0:
                        LAST_CASCADE_TIME = time.time()
                        stats["consecutive_losses"] = stats.get("consecutive_losses", 0) + 1
                    else:
                        stats["consecutive_losses"] = 0
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

            # ── AUDIT FIX #13: Halt if emergency flatten failed ──────────
            if executor.active_position and executor.active_position.get("__failed_flatten"):
                logger.critical(
                    f"[Main] HALTED — previous emergency_flatten FAILED. "
                    f"Position {executor.active_position.get('symbol')} may still be open on exchange. "
                    f"Manual intervention required."
                )
                await asyncio.sleep(60)  # Don't spam logs, check once per minute
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
                    _cached_positions = None  # PHASE-3.4: Invalidate cache after exit
                    if pnl < 0:
                        LAST_CASCADE_TIME = time.time()
                        logger.warning("[Main] Stop Loss exited. Activating 5-minute Cascade Cooldown to prevent revenge trading.")

                        
                        # PHASE-3.3: Rolling 30-min loss window (was absolute consecutive counter)
                        # Tracks losses within a 30-minute rolling window instead of all-time.
                        # This prevents permanent bot lockout when losses are spaced hours apart.
                        loss_times = stats.get("loss_times", [])
                        now_loss = time.time()
                        loss_times = [t for t in loss_times if now_loss - t < 1800]  # Keep only last 30 min
                        if pnl < 0:
                            loss_times.append(now_loss)
                        stats["loss_times"] = loss_times

                        if len(loss_times) >= 3:
                            stats["cooldown_until"] = time.time() + 1800
                            stats["loss_times"] = []
                            halt_msg = (
                                f"🛑 Quad-Desk CONSECUTIVE LOSS HALT\n"
                                f"3 SL exits within 30 minutes. All trading paused for 30 minutes.\n"
                                f"Resumes at {time.strftime('%H:%M:%S', time.localtime(time.time() + 1800))}"
                            )
                            logger.error("[RiskManager] 3 consecutive SL exits within 30 min! Activating 30-minute cooldown.")
                            if executor.notifier:
                                await executor.notifier.send_message(halt_msg)
                    
                    # Update the Bayesian win-rate prior for self-calibration
                    # P1: pass current regime so per-regime beta prior is updated
                    quant.update_win_rate(
                        won=(pnl >= 0),
                        regime=pos_snapshot.get("regime", "NEUTRAL"),
                    )

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

                    new_daily_pnl = stats.get("daily_pnl", 0.0) + pnl
                    stats["daily_pnl"] = new_daily_pnl

                    # FREQ-1 FIX: Split TP/SL cooldown — 45s after wins, 90s after losses.
                    # A TP means the thesis was right. Re-entering faster is correct.
                    # The 90s blanket cooldown on wins was unnecessarily conservative.
                    LAST_ANY_TRADE_CLOSE_TIME = time.time()
                    LAST_TRADE_WAS_SL = (pnl < 0)

                    max_loss_usd = ACCOUNT_SIZE * MAX_DAILY_LOSS_PCT / 100.0
                    if new_daily_pnl < -max_loss_usd and not stats.get("daily_loss_halt"):
                        stats["daily_loss_halt"] = True
                        logger.warning(
                            f"[RiskEngine] ⛔ Daily loss limit breached: "
                            f"${new_daily_pnl:.2f} (limit=-${max_loss_usd:.2f}). "
                            f"All trading halted until tomorrow."
                        )

                    # 3.5 FIX: Max Drawdown check (session cumulative)
                    # Distinct from daily loss cap — this is absolute session PnL
                    session_pnl = stats.get("session_pnl", 0.0) + pnl
                    stats["session_pnl"] = session_pnl
                    max_drawdown_usd = ACCOUNT_SIZE * MAX_DRAWDOWN_PCT / 100.0
                    if session_pnl < -max_drawdown_usd and not stats.get("drawdown_halt"):
                        stats["drawdown_halt"] = True
                        logger.critical(
                            f"[RiskEngine] 🚨 MAX DRAWDOWN BREACHED: "
                            f"${session_pnl:.2f} (limit=-${max_drawdown_usd:.2f}). "
                            f"ALL TRADING HALTED. Restart bot to resume."
                        )
                        if executor.notifier:
                            await executor.notifier.send_message(
                                f"🚨 Quad-Desk MAX DRAWDOWN HIT\n"
                                f"Session PnL: ${session_pnl:.2f} / Limit: -${max_drawdown_usd:.2f}\n"
                                f"Bot has halted all trading. Restart to resume."
                            )


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
                    exchange_has_pos = any(
                        abs(float(p.get("contracts", 0) or p.get("positionAmt", 0))) > 0.0001
                        for p in positions
                    )
                    bot_has_pos = executor.active_position is not None
                    if exchange_has_pos and not bot_has_pos:
                        logger.critical(
                            "[Reconciliation] EXCHANGE has open position but BOT does not. "
                            "Manual intervention required."
                        )
                        await executor.notifier.send_error_alert(
                            "⚠️ Position mismatch: exchange open, bot closed."
                        )
                    elif not exchange_has_pos and bot_has_pos:
                        logger.warning(
                            "[Reconciliation] BOT thinks position open but EXCHANGE does not. "
                            "Clearing stale state."
                        )
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
                if LAST_CVD == 0.0:  # First cycle after bot restart — initialise without delta spike
                    LAST_CVD = _current_cvd
                    metrics["cvd_delta"] = 0.0
                else:
                    metrics["cvd_delta"] = _current_cvd - LAST_CVD
                    LAST_CVD = _current_cvd

                # P1: Inject per-regime win-rate priors so _bayesian_fusion
                # can blend them with the base posterior after regime is known.
                metrics["_regime_priors"] = quant.get_all_regime_priors()
                metrics["_regime_samples"] = quant.get_regime_trade_counts()
                # FINDING-2: Also inject alpha/beta counts so cold-start guard
                # can count total trades before enabling regime blending.
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
                continue

            if metrics is None:
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
            if not metrics.get("trade_buffer_healthy", True):
                logger.warning(
                    f"[DataFeed] aggTrade stream stale or starved — "
                    f"last trade {time.time() - feed.state._last_trade_ts:.0f}s ago, "
                    f"buffer={len(feed.state.recent_trades)} trades. Tape/CVD metrics unreliable."
                )

            # Stages 2–7: Full signal engine
            # HIGH-4 FIX: Reset consecutive_losses when a cooldown expires so the
            # bot gets a clean slate after its penalty period. Without this reset,
            # two losses immediately after the cooldown trigger another 2-hour pause.
            if time.time() >= stats.get("cooldown_until", 0.0) and stats.get("_was_in_cooldown", False):
                stats["consecutive_losses"] = 0
                stats["_was_in_cooldown"] = False
                logger.info("[RiskManager] Consecutive-loss cooldown expired. Counter reset.")

            if time.time() < stats.get("cooldown_until", 0.0):
                stats["_was_in_cooldown"] = True
                verdict_json = {
                    "verdict": "WAIT",
                    "confidence": 0.0,
                    "stop_loss": 0.0,
                    "take_profit": 0.0,
                    "analysis": f"Consecutive Loss Cooldown active. Resumes at {time.strftime('%H:%M:%S', time.localtime(stats['cooldown_until']))}",
                    "ulis_verdict": "—"
                }
            else:
                verdict_json = _compute_signal(
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
                _panic_pnl = getattr(executor, "_last_panic_pnl", 0.0)
                await executor.engage_panic_mode(panic_reason, lock_seconds=PANIC_LOCK_SECONDS)
                # BUG-3 FIX: Update daily_pnl with panic PnL so circuit breaker sees it.
                if _panic_pnl != 0.0:
                    stats["daily_pnl"] = stats.get("daily_pnl", 0.0) + _panic_pnl
                    max_loss_usd = ACCOUNT_SIZE * MAX_DAILY_LOSS_PCT / 100.0
                    if stats["daily_pnl"] < -max_loss_usd and not stats.get("daily_loss_halt"):
                        stats["daily_loss_halt"] = True
                        logger.warning(f"[RiskEngine] Daily loss limit hit via panic exit. Halted.")
                stats["active_position"] = None
                continue

            logger.info(f"[Main] {action} | conf={conf:.0%} | SL={stop_loss} TP={take_profit} | ULIS={ulis_str}")
            if analysis:
                logger.info(f"[Main] {analysis}")

            is_actionable = action in ("BUY", "SELL", "MEAN_REVERSAL_LONG", "MEAN_REVERSAL_SHORT")
            if is_actionable:
                # Startup lockout: log the signal but don't trade yet
                if _in_startup_lockout:
                    remaining_lockout = int(_STARTUP_LOCKOUT_SECS - _startup_elapsed)
                    logger.info(
                        f"[Main] \u23f3 Startup lockout — would fire {action} but waiting "
                        f"{remaining_lockout}s for live feed to settle. "
                        f"(conf={conf:.0%} SL={stop_loss} TP={take_profit})"
                    )
                else:
                    await executor.execute_signal(
                        SYMBOL, metrics["execution_price"], verdict_json, MAX_RISK_PCT,
                        account_size=ACCOUNT_SIZE, ulis_verdict=ulis_str
                    )
                # Only count the trade if execution actually opened a position
                if executor.active_position is not None:
                    stats["total_trades"] += 1
                    # P1: Tag position with the current regime so update_win_rate()
                    # can update the correct per-regime Beta prior on exit.
                    if executor.active_position:
                        executor.active_position["regime"] = verdict_json.get("regime", "NEUTRAL")
            else:
                logger.info(f"[Main] WAIT — {analysis[:120]}")

        except asyncio.CancelledError:
            break
        except Exception as e:
            global _CYCLE_ERROR_COUNT, _LAST_CYCLE_ERROR
            _CYCLE_ERROR_COUNT += 1
            _LAST_CYCLE_ERROR = str(e)
            if _CYCLE_ERROR_COUNT % 5 == 0:
                logger.critical(
                    f"[MainLoop] {5} consecutive errors! Last: {_LAST_CYCLE_ERROR}"
                )
                if executor.notifier:
                    await executor.notifier.send_message(
                        f"🚨 Bot error loop: {_CYCLE_ERROR_COUNT} errors. Last: {_LAST_CYCLE_ERROR[:200]}"
                    )
                await asyncio.sleep(30)
            else:
                logger.error(f"[Main] Execution loop error: {e}", exc_info=True)
                await asyncio.sleep(5)
        else:
            _CYCLE_ERROR_COUNT = 0


# ══════════════════════════════════════════════════════════════════════
# ── ENTRY POINT ────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def main():
    # 1. Initialise Firebase connection early so FirestoreLogHandler can sync startup logs
    heartbeat.init_firebase()

    # Preference: Use Ed25519 if it exists, otherwise fall back to HMAC secret
    effective_secret = BINANCE_ED25519_PRIVKEY.strip() or BINANCE_API_SECRET.strip()

    feed     = BinanceDataFeed(symbol=FEED_SYMBOL, interval=CANDLE_INTERVAL, testnet=TESTNET)
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

    tasks = [
        asyncio.create_task(feed.run(),                                            name="data_feed"),
        asyncio.create_task(feed.funding_rate_loop(),                              name="funding_rate"),
        asyncio.create_task(execution_loop(feed, quant, executor, BOT_STATS),     name="exec_loop"),
        asyncio.create_task(heartbeat.run_heartbeat(BOT_STATS),                   name="heartbeat"),
        # P0-2 FIX: Feed health monitor — detects frozen WebSocket and forces reconnect
        asyncio.create_task(
            feed.feed_health_monitor(notifier=executor.notifier),
            name="feed_health_monitor"
        ),
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
