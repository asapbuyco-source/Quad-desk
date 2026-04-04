"""
Macro Strategy Execution Bot — Coinbase Edition (7-Stage Hybrid)
=================================================================
Launch with:
    python -m bot.main

Architecture (7 stages):
  1. Feature Engine      — all signals from live market data (Binance WS)
  2. Regime Detection    — classify: TREND | RANGE | LIQUIDITY | NEUTRAL
  3. Liquidity Sweep     — detect stop-hunts above/below walls
  4. Strategy Layer      — A: Trend, B: Mean Reversion, C: Liquidity Sweep
  5. Bayesian Fusion     — sequential probability update
  6. ULIS/ALDE Gate ★NEW — ALDE+ULIS hybrid verdict: veto or boost signal
  7. Risk Engine         — ATR-based SL/TP, daily-loss guard

Environment variables:
    BOT_EXCHANGE                — default: coinbase (or binance)
    COINBASE_API_KEY_NAME       — Coinbase RSA key name
    COINBASE_PRIVATE_KEY        — Coinbase EC private key (PEM)
    BINANCE_API_KEY             — legacy Binance key (if exchange=binance)
    BINANCE_API_SECRET          — legacy Binance secret
    BOT_SYMBOL                  — default: BTC-USD (Coinbase) / BTCUSDT (Binance)
    BOT_TESTNET                 — default: true (Binance only)
    BOT_MAX_RISK_PCT            — default: 1.0  (% of equity per trade)
    BOT_MAX_DAILY_LOSS_PCT      — default: 3.0  (% of equity; pauses if hit)
    BOT_ANALYSIS_INTERVAL       — default: 15   (seconds between cycles)
    BOT_MIN_CONFIDENCE          — default: 0.70 (Bayesian fusion threshold)
    BOT_ACCOUNT_SIZE            — default: 100  (simulated equity for dry-run)
    BOT_ULIS_GATE               — default: true (enable Stage 7 ULIS gate)
"""

import asyncio
import logging
import os
import re
import signal
from datetime import date
from typing import Dict, Any, Optional, Tuple, List

from dotenv import load_dotenv
load_dotenv()

from bot.data_feed import BinanceDataFeed
from bot.quant_engine import QuantEngine
from bot.executor import TradingExecutor
from bot.ulis_engine import compute_ulis_verdict
from bot import heartbeat

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
EXCHANGE            = os.environ.get("BOT_EXCHANGE",            "coinbase").lower()
SYMBOL              = os.environ.get("BOT_SYMBOL",              "BTC-USDC" if EXCHANGE == "coinbase" else "BTCUSDT")
TESTNET             = os.environ.get("BOT_TESTNET",             "true").lower() != "false"
MAX_RISK_PCT        = float(os.environ.get("BOT_MAX_RISK_PCT",        "1.0"))
MAX_DAILY_LOSS_PCT  = float(os.environ.get("BOT_MAX_DAILY_LOSS_PCT",  "3.0"))
ANALYSIS_INTERVAL   = int(os.environ.get("BOT_ANALYSIS_INTERVAL",    "15"))
CANDLE_INTERVAL     = os.environ.get("BOT_CANDLE_INTERVAL",      "15m")
MIN_CONFIDENCE      = float(os.environ.get("BOT_MIN_CONFIDENCE",      "0.60"))
ACCOUNT_SIZE        = float(os.environ.get("BOT_ACCOUNT_SIZE",        "100.0"))
ULIS_GATE_ENABLED   = os.environ.get("BOT_ULIS_GATE",           "true").lower() != "false"

# Coinbase credentials
CB_KEY_NAME     = os.environ.get("COINBASE_API_KEY_NAME",  "")
CB_PRIVATE_KEY  = os.environ.get("COINBASE_PRIVATE_KEY",   "")

# Legacy Binance credentials
BINANCE_API_KEY    = os.environ.get("BINANCE_API_KEY",    "")
BINANCE_API_SECRET = os.environ.get("BINANCE_API_SECRET", "")

# Telegram credentials
TG_BOT_TOKEN   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID     = os.environ.get("TELEGRAM_CHAT_ID",   "")

# Derive dry-run: no credentials at all
if EXCHANGE == "coinbase":
    DRY_RUN = not (CB_KEY_NAME and CB_PRIVATE_KEY)
else:
    DRY_RUN = not (BINANCE_API_KEY and BINANCE_API_SECRET)

# The data feed always uses Binance public WS (deepest data, free)
# but we translate the symbol to a Binance-compatible format
FEED_SYMBOL = SYMBOL.replace("-", "").replace("/", "")  # BTC-USD → BTCUSD --- fix below
if EXCHANGE == "coinbase":
    # BTC-USD → BTCUSDT for the Binance public data feed
    base = SYMBOL.split("-")[0] if "-" in SYMBOL else SYMBOL[:3]
    FEED_SYMBOL = f"{base}USDT"
else:
    FEED_SYMBOL = SYMBOL

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
    "daily_loss_halt": False,
}


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

def _detect_regime(metrics: Dict[str, Any],
                   buy_walls: List[float],
                   sell_walls: List[float]) -> str:
    price   = metrics["price"]
    z       = abs(metrics["zScore"])
    tape    = metrics["tapeSpeed"]
    atr_pct = metrics["atr_pct"]

    WALL_PROXIMITY = 0.001
    near_wall = any(abs(price - w) / price <= WALL_PROXIMITY for w in (buy_walls[:1] + sell_walls[:1]))
    if near_wall:
        return "LIQUIDITY"

    TREND_ATR_THRESHOLD = 0.004
    if atr_pct > TREND_ATR_THRESHOLD and tape == "SCREAMING":
        return "TREND"

    if z < 2.0:
        return "RANGE"

    return "NEUTRAL"


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 3 — LIQUIDITY SWEEP DETECTION ──────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _detect_liquidity_sweep(metrics: Dict[str, Any],
                             buy_walls: List[float],
                             sell_walls: List[float],
                             candle_history: list) -> Optional[str]:
    if len(candle_history) < 2 or not sell_walls or not buy_walls:
        return None

    prev  = candle_history[-2]
    price = metrics["price"]

    nearest_sell = sell_walls[0]
    nearest_buy  = buy_walls[0]

    if prev["high"] > nearest_sell and price < nearest_sell:
        logger.info(f"[Sweep] ABOVE_HIGHS at {nearest_sell:.2f}")
        return "ABOVE_HIGHS"

    if prev["low"] < nearest_buy and price > nearest_buy:
        logger.info(f"[Sweep] BELOW_LOWS at {nearest_buy:.2f}")
        return "BELOW_LOWS"

    return None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 4 — STRATEGY LAYER ──────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _strategy_trend(metrics: Dict[str, Any]) -> Optional[str]:
    bayes    = metrics["bayesianPosterior"]
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    dominant = metrics["tapeDominant"]

    score = 0.0
    if bayes > 0.65:    score += 2.0
    elif bayes > 0.55:  score += 1.0
    elif bayes < 0.35:  score -= 2.0
    elif bayes < 0.45:  score -= 1.0

    if ofi > 20:         score += 1.5
    elif ofi > 8:        score += 0.75
    elif ofi < -20:      score -= 1.5
    elif ofi < -8:       score -= 0.75

    if cvd > 0:          score += 1.0
    elif cvd < 0:        score -= 1.0

    if "BUY" in dominant:    score += 1.0
    elif "SELL" in dominant: score -= 1.0

    logger.info(f"[TrendStrategy] score={score:+.2f}")
    if score >= 1.5:  return "BUY"
    if score <= -1.5: return "SELL"
    return None


def _strategy_mean_reversion(metrics: Dict[str, Any]) -> Optional[str]:
    z   = metrics["zScore"]
    rsi = metrics["rsi"]

    if z >= 2.2 and rsi > 45:
        logger.info(f"[MeanRev] SELL — Z={z:.2f} RSI={rsi:.1f}")
        return "MEAN_REVERSAL_SHORT"

    if z <= -2.2 and rsi < 55:
        logger.info(f"[MeanRev] BUY — Z={z:.2f} RSI={rsi:.1f}")
        return "MEAN_REVERSAL_LONG"

    return None


def _strategy_liquidity_sweep(sweep: str, metrics: Dict[str, Any]) -> Optional[str]:
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    dominant = metrics["tapeDominant"]

    if sweep == "ABOVE_HIGHS":
        if ofi < -5 or cvd < 0 or "SELL" in dominant or dominant == "BALANCED":
            logger.info(f"[SweepStrat] SELL after ABOVE_HIGHS")
            return "SELL"

    if sweep == "BELOW_LOWS":
        if ofi > 5 or cvd > 0 or "BUY" in dominant or dominant == "BALANCED":
            logger.info(f"[SweepStrat] BUY after BELOW_LOWS")
            return "BUY"

    return None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 5 — BAYESIAN SIGNAL FUSION ─────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _bayesian_fusion(metrics: Dict[str, Any], direction: str, regime: str, is_sweep: bool = False) -> float:
    """
    Stage 5: Macro Bayesian Logic
    Updates the prior confidence (from QuantEngine) with current directional evidence.
    Returns: Confidence score (0-1) in the *target signal direction*.
    """
    # 1. Start with the prior confidence from Quant Engine Stage 4 (which is P-Bull)
    p_bull_prior = metrics.get("bayesianPosterior", 0.5)
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    # 2. Base Signal Confidence
    p_signal_prior = p_bull_prior if is_long else (1.0 - p_bull_prior)
    
    # [NEW] SWEEP NEUTRALIZER: If we find a sweep, don't let 
    # a historical trend (Prior) handicap the reversion signal.
    if is_sweep:
        p_signal_prior = max(0.50, p_signal_prior)

    # 3. Transform to Odds
    # Clip to avoid division by zero/infinity during transformation
    p_signal_prior = max(0.01, min(0.99, p_signal_prior))
    odds = p_signal_prior / (1.0 - p_signal_prior)

    ofi      = metrics.get("ofi", 0.0)
    cvd      = metrics.get("cvd", 0.0)
    skew     = metrics.get("skewness", 0.0)
    dominant = metrics.get("tapeDominant", "BALANCED")
    tape     = metrics.get("tapeSpeed", "NORMAL")
    rsi      = metrics.get("rsi", 50.0)

    # 4. Flow Multipliers (OFI/CVD) — direction-support check
    # We apply multipliers (>1.0) if the evidence supports our target signal
    flow_factor = 1.0
    if is_long:
        if ofi > 10:  flow_factor *= 1.25
        if cvd > 0:   flow_factor *= 1.15
    else: # SHORT signal
        if ofi < -10: flow_factor *= 1.25
        if cvd < 0:   flow_factor *= 1.15
    
    odds *= flow_factor

    # 5. Contextual Oscillator check — Regime-aware
    osc_factor = 1.0
    if regime == "TREND":
        # Trend continuation: RSI in signal direction confirms momentum
        if is_long and rsi > 65:      osc_factor *= 1.15
        elif not is_long and rsi < 35: osc_factor *= 1.15
    elif regime == "LIQUIDITY":
        # Sweep reversal: Overextended RSI supports a bounce/rejection
        if not is_long and rsi > 60:   osc_factor *= 1.60  # Overbought strongly helps SELL
        elif is_long and rsi < 40:     osc_factor *= 1.60  # Oversold strongly helps BUY
        
        # Momentum Chase Penalty: avoid entry if RSI already buried too deep
        if not is_long and rsi < 32:   osc_factor *= 0.75
        if is_long and rsi > 68:       osc_factor *= 0.75

    odds *= osc_factor

    # 6. Tape Check
    if tape == "SCREAMING":
        if is_long and "BUY" in dominant:        odds *= 1.20
        elif not is_long and "SELL" in dominant: odds *= 1.20

    # 7. Skew check
    if is_long and skew > 0.5:        odds *= 1.15
    elif not is_long and skew < -0.5: odds *= 1.15

    # 8. Convert back to probability (Confidence in Signal)
    p_final = odds / (1.0 + odds)
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

    # Confidence adjustment
    adjusted = min(1.0, confidence + ulis["confidence_boost"])
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
) -> Tuple[float, float]:
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    tp_from_wall = (sell_walls[0] * 0.9995 if sell_walls else None) if is_long \
               else (buy_walls[0] * 1.0005 if buy_walls else None)

    def sl_tp(sl_dist: float) -> Tuple[float, float]:
        if is_long:
            sl = price - sl_dist
            tp_target = price + (sl_dist * 1.5)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall > tp_target) else tp_target
        else:
            sl = price + sl_dist
            tp_target = price - (sl_dist * 1.5)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall < tp_target) else tp_target
        return round(sl, 2), round(tp, 2)

    if strategy_type == "LIQUIDITY_SWEEP" and sweep:
        if sweep == "ABOVE_HIGHS" and sell_walls:
            sl_dist = abs(price - sell_walls[0]) + (atr * 0.5)
        elif sweep == "BELOW_LOWS" and buy_walls:
            sl_dist = abs(price - buy_walls[0]) + (atr * 0.5)
        else:
            sl_dist = atr * 1.0
        return sl_tp(max(sl_dist, atr * 0.5))
    elif strategy_type == "TREND":
        return sl_tp(atr * 1.5)
    elif strategy_type == "MEAN_REVERSION":
        return sl_tp(atr * 1.0)
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
) -> Dict[str, Any]:
    WAIT = {
        "verdict": "WAIT", "confidence": 0.0,
        "stop_loss": 0.0, "take_profit": 0.0,
        "analysis": "", "ulis_verdict": "—"
    }

    if daily_loss_halt:
        logger.warning("[RiskEngine] Daily loss limit hit — all trading halted today.")
        return {**WAIT, "analysis": "Daily loss limit reached. Halted."}

    price = metrics["price"]
    atr   = metrics.get("atr", price * 0.005)

    # Stage 1: Parse walls
    buy_walls, sell_walls = _parse_walls(metrics.get("allWalls"))

    # Stage 2: Regime
    regime = _detect_regime(metrics, buy_walls, sell_walls)
    logger.info(f"[Regime] {regime} | Z={metrics['zScore']:.2f} | "
                f"ATR%={metrics.get('atr_pct', 0):.3%} | Tape={metrics['tapeSpeed']}")

    # Stage 3: Sweep detection
    sweep = _detect_liquidity_sweep(metrics, buy_walls, sell_walls, candle_history)

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
        raw_direction = _strategy_mean_reversion(metrics)
        logger.info("[MetaModel] → MEAN_REVERSION strategy")
    else:
        strategy_type = "NEUTRAL"
        raw_direction = None
        logger.info(f"[MetaModel] → WAIT (regime={regime}, no sweep)")

    if raw_direction is None:
        return {**WAIT, "analysis": f"Regime={regime} strategy={strategy_type} — no edge."}

    # Stage 5: Bayesian fusion
    confidence = _bayesian_fusion(metrics, raw_direction, regime, is_sweep=bool(sweep))
    logger.info(f"[BayesFusion] direction={raw_direction} | P={confidence:.2%}")

    if confidence < MIN_CONFIDENCE:
        return {**WAIT, "analysis": (
            f"Regime={regime} strategy={strategy_type} signal={raw_direction} "
            f"but P={confidence:.2%} < threshold={MIN_CONFIDENCE:.0%}"
        )}

    # Stage 6 ★ ULIS/ALDE gate
    should_trade, confidence, ulis_verdict_str = _apply_ulis_gate(
        metrics, candle_history, feed_state, raw_direction, confidence
    )

    if not should_trade:
        return {**WAIT, "analysis": f"ULIS veto: {ulis_verdict_str}", "ulis_verdict": ulis_verdict_str}

    if confidence < MIN_CONFIDENCE:
        return {**WAIT, "analysis": (
            f"ULIS adjusted confidence {confidence:.2%} below threshold {MIN_CONFIDENCE:.0%}"
        ), "ulis_verdict": ulis_verdict_str}

    # Stage 7: Risk engine
    stop_loss, take_profit = _risk_engine(
        raw_direction, strategy_type, price, atr, buy_walls, sell_walls, sweep
    )

    # Sanity check
    is_long = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    if is_long and (stop_loss >= price or take_profit <= price):
        logger.warning("[RiskEngine] Invalid geometry for LONG — skipped.")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}
    if not is_long and (stop_loss <= price or take_profit >= price):
        logger.warning("[RiskEngine] Invalid geometry for SHORT — skipped.")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}

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

    return {
        "verdict":      verdict,
        "confidence":   round(confidence, 4),
        "stop_loss":    stop_loss,
        "take_profit":  take_profit,
        "analysis":     analysis,
        "ulis_verdict": ulis_verdict_str,
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

    while True:
        try:
            await asyncio.sleep(ANALYSIS_INTERVAL)

            n_candles = len(feed.state.candles)
            if n_candles < QuantEngine.MIN_CANDLES:
                logger.info(f"[Main] Warming up… {n_candles}/{QuantEngine.MIN_CANDLES} candles")
                continue

            # ── Daily loss reset at midnight ─────────────────────────────────
            today = date.today()
            if stats.get("_last_trade_day") != today:
                stats["_last_trade_day"] = today
                stats["daily_pnl"]       = 0.0
                stats["daily_loss_halt"] = False
                logger.info("[RiskEngine] 🌅 Daily counters reset for new trading session.")

            current_price = feed.state.candles[-1]["close"]

            # ── Position exit check — track PnL for daily halt ─────
            if executor.active_position:
                pos_snapshot = dict(executor.active_position)
                exited, pnl = executor.check_position_exit(current_price)
                if exited:
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
                                logger.warning(f"[Executor] Failed to cancel opposing order {cancel_id}: {e}")

                    new_daily_pnl = stats.get("daily_pnl", 0.0) + pnl
                    stats["daily_pnl"] = new_daily_pnl
                    max_loss_usd = ACCOUNT_SIZE * MAX_DAILY_LOSS_PCT / 100.0
                    if new_daily_pnl < -max_loss_usd and not stats.get("daily_loss_halt"):
                        stats["daily_loss_halt"] = True
                        logger.warning(
                            f"[RiskEngine] ⛔ Daily loss limit breached: "
                            f"${new_daily_pnl:.2f} (limit=-${max_loss_usd:.2f}). "
                            f"All trading halted until tomorrow."
                        )

            stats["active_position"] = executor.active_position

            if executor.active_position:
                if not executor.active_position.get("be_triggered", False):
                    await executor.update_breakeven_stop(current_price)

                pos = executor.active_position
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

            # Stage 1: Compute metrics
            metrics = quant.compute_metrics()
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

            # Stages 2–7: Full signal engine
            verdict_json = _compute_signal(
                metrics,
                candle_history=feed.state.candles,
                feed_state=feed.state,
                daily_loss_halt=stats.get("daily_loss_halt", False),
            )

            action      = verdict_json.get("verdict", "WAIT")
            conf        = float(verdict_json.get("confidence", 0))
            stop_loss   = verdict_json.get("stop_loss", 0)
            take_profit = verdict_json.get("take_profit", 0)
            analysis    = verdict_json.get("analysis", "")
            ulis_str    = verdict_json.get("ulis_verdict", "—")

            stats["last_signal"] = action
            stats["last_ulis"]   = ulis_str

            logger.info(f"[Main] {action} | conf={conf:.0%} | SL={stop_loss} TP={take_profit} | ULIS={ulis_str}")
            if analysis:
                logger.info(f"[Main] {analysis}")

            is_actionable = action in ("BUY", "SELL", "MEAN_REVERSAL_LONG", "MEAN_REVERSAL_SHORT")
            if is_actionable:
                await executor.execute_signal(
                    SYMBOL, metrics["price"], verdict_json, MAX_RISK_PCT,
                    account_size=ACCOUNT_SIZE, ulis_verdict=ulis_str
                )
                # Only count the trade if execution actually opened a position
                if executor.active_position is not None:
                    stats["total_trades"] += 1
            else:
                logger.info(f"[Main] WAIT — {analysis[:120]}")

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"[Main] Execution loop error: {e}", exc_info=True)
            await asyncio.sleep(5)


# ══════════════════════════════════════════════════════════════════════
# ── ENTRY POINT ────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def main():
    feed     = BinanceDataFeed(symbol=FEED_SYMBOL, interval=CANDLE_INTERVAL, testnet=TESTNET)
    quant    = QuantEngine(feed.state)
    executor = TradingExecutor(
        api_key=BINANCE_API_KEY,
        api_secret=BINANCE_API_SECRET,
        testnet=TESTNET,
        dry_run=DRY_RUN,
        exchange_id=EXCHANGE,
        coinbase_key_name=CB_KEY_NAME,
        coinbase_private_key=CB_PRIVATE_KEY,
        tg_token=TG_BOT_TOKEN,
        tg_chat_id=TG_CHAT_ID,
    )

    heartbeat.init_firebase()

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
        asyncio.create_task(feed.run(),                                       name="data_feed"),
        asyncio.create_task(execution_loop(feed, quant, executor, BOT_STATS), name="exec_loop"),
        asyncio.create_task(heartbeat.run_heartbeat(BOT_STATS),               name="heartbeat"),
    ]

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
        await executor.close()
        await heartbeat.write_offline(BOT_STATS)
        logger.info("[Main] Bot stopped cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
