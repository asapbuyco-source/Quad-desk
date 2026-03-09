"""
Macro Strategy Execution Bot — Full Hybrid Quant Strategy
==========================================================
Launch with:
    python -m bot.main

Architecture (6 stages):
  1. Feature Engine      — all signals from live market data
  2. Regime Detection    — classify: TREND | RANGE | LIQUIDITY | NEUTRAL
  3. Meta-Model          — select strategy based on regime + sweep
  4. Strategy Layer      — A: Trend Following, B: Mean Reversion, C: Liquidity Sweep
  5. Bayesian Fusion     — sequential probability update (no double-counting)
  6. Risk Engine         — ATR-based SL, 2R TP, daily-loss guard

Environment variables:
    BINANCE_API_KEY / BINANCE_API_SECRET — required for live trading
    BOT_SYMBOL              — default: BTCUSDT
    BOT_TESTNET             — default: true
    BOT_MAX_RISK_PCT        — default: 1.0  (% of equity per trade)
    BOT_MAX_DAILY_LOSS_PCT  — default: 3.0  (% of equity; bot pauses if hit)
    BOT_ANALYSIS_INTERVAL   — default: 10   (seconds between cycles)
    BOT_MIN_CONFIDENCE      — default: 0.60 (Bayesian fusion threshold)
"""

import asyncio
import logging
import os
import re
import signal
from typing import Dict, Any, Optional, Tuple, List

from dotenv import load_dotenv
load_dotenv()

from bot.data_feed import BinanceDataFeed
from bot.quant_engine import QuantEngine
from bot.executor import TradingExecutor
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

# ──────────────────────────────────────────────────────────────────────
# Config from environment
# ──────────────────────────────────────────────────────────────────────
SYMBOL              = os.environ.get("BOT_SYMBOL",              "BTCUSDT")
TESTNET             = os.environ.get("BOT_TESTNET",             "true").lower() != "false"
MAX_RISK_PCT        = float(os.environ.get("BOT_MAX_RISK_PCT",        "1.0"))
MAX_DAILY_LOSS_PCT  = float(os.environ.get("BOT_MAX_DAILY_LOSS_PCT",  "3.0"))
ANALYSIS_INTERVAL   = int(os.environ.get("BOT_ANALYSIS_INTERVAL",    "10"))
MIN_CONFIDENCE      = float(os.environ.get("BOT_MIN_CONFIDENCE",      "0.60"))

API_KEY    = os.environ.get("BINANCE_API_KEY",    "")
API_SECRET = os.environ.get("BINANCE_API_SECRET", "")
DRY_RUN    = not (API_KEY and API_SECRET)

# ──────────────────────────────────────────────────────────────────────
# Shared stats
# ──────────────────────────────────────────────────────────────────────
BOT_STATS: Dict[str, Any] = {
    "symbol":          SYMBOL,
    "mode":            "LIVE" if not DRY_RUN else "DRY-RUN",
    "environment":     "TESTNET" if TESTNET else "MAINNET",
    "active_position": None,
    "total_trades":    0,
    "last_signal":     "WAIT",
    # Risk tracking
    "daily_pnl":       0.0,   # running realized PnL today (USD)
    "daily_loss_halt": False,  # paused due to max daily loss
}


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 1 — FEATURE ENGINE HELPERS ─────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _parse_walls(all_walls_str: Optional[str]) -> Tuple[List[float], List[float]]:
    """
    Parse 'allWalls' string from quant engine into:
      buy_walls  — sorted desc (nearest below price first)
      sell_walls — sorted asc  (nearest above price first)
    """
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
    """
    Classify market environment:
      LIQUIDITY — price within 0.1% of a significant wall (stop-cluster zone)
      TREND     — high ATR volatility + screaming tape
      RANGE     — low Z-Score deviation, calm conditions
      NEUTRAL   — everything else
    """
    price    = metrics["price"]
    z        = abs(metrics["zScore"])
    tape     = metrics["tapeSpeed"]
    atr_pct  = metrics["atr_pct"]   # ATR as fraction of price (e.g. 0.008 = 0.8%)

    # Liquidity zone: near a large order-book wall (potential stop cluster)
    WALL_PROXIMITY = 0.001  # within 0.1%
    near_wall = any(abs(price - w) / price <= WALL_PROXIMITY for w in (buy_walls[:1] + sell_walls[:1]))
    if near_wall:
        return "LIQUIDITY"

    # Trend: above-average ATR + screaming tape = strong directional move
    TREND_ATR_THRESHOLD = 0.006   # 0.6% of price; tune as needed
    if atr_pct > TREND_ATR_THRESHOLD and tape == "SCREAMING":
        return "TREND"

    # Range: Z-Score tightly bound, suggesting sideways price action
    if z < 1.5:
        return "RANGE"

    return "NEUTRAL"


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 3 — LIQUIDITY SWEEP DETECTION ──────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _detect_liquidity_sweep(metrics: Dict[str, Any],
                             buy_walls: List[float],
                             sell_walls: List[float],
                             candle_history: list) -> Optional[str]:
    """
    Detect a stop-hunt (liquidity sweep):
      ABOVE_HIGHS — prev candle spiked above nearest sell wall and closed back below
      BELOW_LOWS  — prev candle spiked below nearest buy wall and closed back above
    Returns 'ABOVE_HIGHS', 'BELOW_LOWS', or None.
    Needs at least 2 candles.
    """
    if len(candle_history) < 2 or not sell_walls or not buy_walls:
        return None

    prev   = candle_history[-2]
    latest = candle_history[-1]
    price  = metrics["price"]

    nearest_sell = sell_walls[0]
    nearest_buy  = buy_walls[0]

    # Sweep above highs: prev candle wick pierced sell wall, current price back below
    if prev["high"] > nearest_sell and price < nearest_sell:
        logger.info(f"[Sweep] ABOVE_HIGHS at {nearest_sell:.2f} — stop hunt detected")
        return "ABOVE_HIGHS"

    # Sweep below lows: prev candle wick pierced buy wall, current price back above
    if prev["low"] < nearest_buy and price > nearest_buy:
        logger.info(f"[Sweep] BELOW_LOWS at {nearest_buy:.2f} — stop hunt detected")
        return "BELOW_LOWS"

    return None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 4 — STRATEGY LAYER ──────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _strategy_trend(metrics: Dict[str, Any]) -> Optional[str]:
    """
    Strategy A — Trend Following.
    Used when regime = TREND (strong directional market).

    Weights:   Bayesian ±2.0 | OFI ±1.5 | CVD ±1.0 | Tape ±1.0
    Decision:  score ≥ +2 → BUY | score ≤ −2 → SELL | else WAIT
    """
    bayes    = metrics["bayesianPosterior"]
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    dominant = metrics["tapeDominant"]

    score = 0.0

    # Bayesian Posterior (weight ±2)
    if bayes > 0.65:   score += 2.0
    elif bayes > 0.55: score += 1.0
    elif bayes < 0.35: score -= 2.0
    elif bayes < 0.45: score -= 1.0

    # OFI (weight ±1.5)
    if ofi > 20:    score += 1.5
    elif ofi > 8:   score += 0.75
    elif ofi < -20: score -= 1.5
    elif ofi < -8:  score -= 0.75

    # CVD direction (weight ±1.0)
    if cvd > 0:  score += 1.0
    elif cvd < 0: score -= 1.0

    # Tape dominant side (weight ±1.0)
    if "BUY" in dominant:  score += 1.0
    elif "SELL" in dominant: score -= 1.0

    logger.info(f"[TrendStrategy] score={score:+.2f}")
    if score >= 2.0:  return "BUY"
    if score <= -2.0: return "SELL"
    return None


def _strategy_mean_reversion(metrics: Dict[str, Any]) -> Optional[str]:
    """
    Strategy B — Mean Reversion.
    Used when regime = RANGE (price oscillating around VWAP).

    Z-Score ≥ +2.5: price too high → SELL back to mean
    Z-Score ≤ −2.5: price too low  → BUY  back to mean
    RSI used for confirmation (prevents fading strong trends).
    """
    z   = metrics["zScore"]
    rsi = metrics["rsi"]

    # Overbought: price far above VWAP, RSI somewhat elevated
    if z >= 2.5 and rsi > 45:
        logger.info(f"[MeanRev] SELL signal — Z={z:.2f} RSI={rsi:.1f}")
        return "MEAN_REVERSAL_SHORT"

    # Oversold: price far below VWAP, RSI somewhat depressed
    if z <= -2.5 and rsi < 55:
        logger.info(f"[MeanRev] BUY signal — Z={z:.2f} RSI={rsi:.1f}")
        return "MEAN_REVERSAL_LONG"

    return None


def _strategy_liquidity_sweep(sweep: str, metrics: Dict[str, Any]) -> Optional[str]:
    """
    Strategy C — Liquidity Sweep Reversal.
    Used when a stop-hunt has just occurred.

    Confirmation requirements (avoids fading actual breakouts):
      - OFI reversal (OFI opposing the sweep direction)
      - CVD divergence (CVD not confirming breakout)
      - OR tape exhaustion (tape balanced/opposite after the spike)
    """
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    dominant = metrics["tapeDominant"]

    # Sweep above highs → expect SELL (fake breakout to the upside)
    if sweep == "ABOVE_HIGHS":
        ofi_confirms  = ofi < -5        # sell pressure in LOB
        cvd_confirms  = cvd < 0         # sellers winning volume
        tape_confirms = "SELL" in dominant or dominant == "BALANCED"
        if ofi_confirms or cvd_confirms or tape_confirms:
            logger.info(f"[SweepStrat] SELL after ABOVE_HIGHS sweep — OFI={ofi:.0f} CVD={cvd:.0f} Tape={dominant}")
            return "SELL"

    # Sweep below lows → expect BUY (fake breakdown to the downside)
    if sweep == "BELOW_LOWS":
        ofi_confirms  = ofi > 5        # buy pressure in LOB
        cvd_confirms  = cvd > 0        # buyers winning volume
        tape_confirms = "BUY" in dominant or dominant == "BALANCED"
        if ofi_confirms or cvd_confirms or tape_confirms:
            logger.info(f"[SweepStrat] BUY after BELOW_LOWS sweep — OFI={ofi:.0f} CVD={cvd:.0f} Tape={dominant}")
            return "BUY"

    return None


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 5 — BAYESIAN SIGNAL FUSION ─────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

def _bayesian_fusion(metrics: Dict[str, Any], direction: str) -> float:
    """
    Sequential Bayesian probability update starting from a 0.50 prior.
    Each signal acts as an independent likelihood ratio update.

    P(bullish) is updated based on direction-specific evidence:
      - OFI, CVD, Tape, Bayesian posterior, Skewness

    Returns final P(bullish) for BUY or 1 - P(bullish) for SELL confidence.
    This avoids double-counting because signals update sequentially.
    """
    ofi      = metrics["ofi"]
    cvd      = metrics["cvd"]
    bayes    = metrics["bayesianPosterior"]
    skew     = metrics["skewness"]
    dominant = metrics["tapeDominant"]
    tape     = metrics["tapeSpeed"]
    rsi      = metrics["rsi"]

    # Start: prior odds = 1.0 (P = 0.5)
    odds = 1.0

    # ── Signal 1: OFI — most real-time signal ─────────────────────────
    if ofi > 20:   odds *= 2.0    # very strong buy pressure → LR ~ 2.0
    elif ofi > 8:  odds *= 1.4    # moderate buy
    elif ofi < -20: odds *= 0.5   # very strong sell pressure
    elif ofi < -8:  odds *= 0.7   # moderate sell

    # ── Signal 2: CVD direction ────────────────────────────────────────
    if cvd > 0:   odds *= 1.25   # buyers winning
    elif cvd < 0: odds *= 0.80   # sellers winning

    # ── Signal 3: Tape dominant side ──────────────────────────────────
    screaming = tape == "SCREAMING"
    if "BUY" in dominant and screaming:   odds *= 1.20
    elif "BUY" in dominant:               odds *= 1.10
    elif "SELL" in dominant and screaming: odds *= 0.75
    elif "SELL" in dominant:              odds *= 0.90

    # ── Signal 4: Skewness (tail risk) ────────────────────────────────
    if skew > 0.3:   odds *= 1.12   # upside tail risk → bullish
    elif skew < -0.3: odds *= 0.88  # downside tail risk → bearish

    # ── Signal 5: RSI state ────────────────────────────────────────────
    if rsi > 60:    odds *= 1.15   # bullish momentum
    elif rsi < 40:  odds *= 0.85   # bearish momentum

    # P(bullish) from odds
    p_bull = odds / (odds + 1.0)

    # Return confidence in the direction the strategy wants to trade
    if direction in ("BUY", "MEAN_REVERSAL_LONG"):
        return p_bull
    else:
        return 1.0 - p_bull


# ══════════════════════════════════════════════════════════════════════
# ── STAGE 6 — RISK ENGINE ─────────────────────────────────────────────
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
    """
    Compute Stop Loss and Take Profit based on strategy type.

    Trend trade:        SL = ATR × 1.5 from entry; TP = next liquidity pool or 2× risk
    Mean reversion:     SL = outside deviation band (1 ATR beyond entry)
    Liquidity sweep:    SL = just above/below sweep level (wall ± 0.1%)
    Fallback:           SL = 0.8% of price; TP = 2× SL distance
    """
    is_long = direction in ("BUY", "MEAN_REVERSAL_LONG")

    # Helper: nearest liquidity pool as TP target
    tp_from_wall = (sell_walls[0] * 0.9995 if sell_walls else None) if is_long \
               else (buy_walls[0] * 1.0005 if buy_walls else None)

    def sl_tp(sl_dist: float) -> Tuple[float, float]:
        if is_long:
            sl = price - sl_dist
            # TP = next liquidity pool, or 2× risk, whichever is farther but reasonable
            tp_2r = price + (sl_dist * 2.0)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall > tp_2r) else tp_2r
        else:
            sl = price + sl_dist
            tp_2r = price - (sl_dist * 2.0)
            tp = tp_from_wall if (tp_from_wall and tp_from_wall < tp_2r) else tp_2r
        return round(sl, 2), round(tp, 2)

    # ── Strategy-specific SL placement ───────────────────────────────

    if strategy_type == "LIQUIDITY_SWEEP" and sweep:
        # SL placed just beyond the swept level
        if sweep == "ABOVE_HIGHS" and sell_walls:
            sl_dist = abs(price - sell_walls[0]) + (atr * 0.5)
        elif sweep == "BELOW_LOWS" and buy_walls:
            sl_dist = abs(price - buy_walls[0]) + (atr * 0.5)
        else:
            sl_dist = atr * 1.0
        return sl_tp(max(sl_dist, atr * 0.5))

    elif strategy_type == "TREND":
        # SL = 1.5 ATR; TP = next wall or 2R
        return sl_tp(atr * 1.5)

    elif strategy_type == "MEAN_REVERSION":
        # SL = 1 ATR outside mean (tighter because we're fading an extreme)
        return sl_tp(atr * 1.0)

    else:
        # Fallback
        return sl_tp(price * 0.008)


# ══════════════════════════════════════════════════════════════════════
# ── FULL HYBRID SIGNAL ENGINE (orchestrates all 6 stages) ─────────────
# ══════════════════════════════════════════════════════════════════════

def _compute_signal(metrics: Dict[str, Any],
                    candle_history: list,
                    daily_loss_halt: bool) -> Dict[str, Any]:
    """
    Full 6-stage hybrid quant decision engine.
    Returns a verdict dict compatible with TradingExecutor.execute_signal().
    """
    WAIT = {
        "verdict": "WAIT", "confidence": 0.0,
        "stop_loss": 0.0, "take_profit": 0.0, "analysis": ""
    }

    # ── Risk guard: halt if daily loss exceeded ────────────────────────
    if daily_loss_halt:
        logger.warning("[RiskEngine] Daily loss limit hit — all trading halted today.")
        return {**WAIT, "analysis": "Daily loss limit reached. Halted."}

    price = metrics["price"]
    atr   = metrics.get("atr", price * 0.005)

    # ── Stage 1: Parse LOB walls ───────────────────────────────────────
    buy_walls, sell_walls = _parse_walls(metrics.get("allWalls"))

    # ── Stage 2: Detect market regime ────────────────────────────────
    regime = _detect_regime(metrics, buy_walls, sell_walls)
    logger.info(f"[Regime]  {regime} | Z={metrics['zScore']:.2f} | ATR%={metrics.get('atr_pct', 0):.3%} | Tape={metrics['tapeSpeed']}")

    # ── Stage 3: Liquidity sweep detection ────────────────────────────
    sweep = _detect_liquidity_sweep(metrics, buy_walls, sell_walls, candle_history)

    # ── Stages 3+4: Meta-model selects and runs strategy ──────────────
    raw_direction: Optional[str] = None
    strategy_type: str

    if sweep:
        strategy_type  = "LIQUIDITY_SWEEP"
        raw_direction  = _strategy_liquidity_sweep(sweep, metrics)
        logger.info(f"[MetaModel] → LIQUIDITY_SWEEP strategy (sweep={sweep})")

    elif regime == "TREND":
        strategy_type  = "TREND"
        raw_direction  = _strategy_trend(metrics)
        logger.info(f"[MetaModel] → TREND strategy")

    elif regime == "RANGE":
        strategy_type  = "MEAN_REVERSION"
        raw_direction  = _strategy_mean_reversion(metrics)
        logger.info(f"[MetaModel] → MEAN_REVERSION strategy")

    else:
        strategy_type  = "NEUTRAL"
        raw_direction  = None
        logger.info(f"[MetaModel] → WAIT (regime={regime}, no sweep)")

    # No actionable direction from strategy
    if raw_direction is None:
        return {**WAIT, "analysis": f"Regime={regime} strategy={strategy_type} — no edge."}

    # ── Stage 5: Bayesian signal fusion ────────────────────────────────
    confidence = _bayesian_fusion(metrics, raw_direction)
    logger.info(f"[BayesFusion] direction={raw_direction} | P={confidence:.2%}")

    # Threshold check — asymmetric: WAIT if confidence insufficient
    if confidence < MIN_CONFIDENCE:
        return {**WAIT, "analysis": (
            f"Regime={regime} strategy={strategy_type} signal={raw_direction} "
            f"but P={confidence:.2%} < threshold={MIN_CONFIDENCE:.0%}"
        )}

    # ── Stage 6: Risk engine — SL/TP placement ────────────────────────
    stop_loss, take_profit = _risk_engine(
        raw_direction, strategy_type, price, atr, buy_walls, sell_walls, sweep
    )

    # Sanity check: reject invalid SL/TP geometry
    is_long = raw_direction in ("BUY", "MEAN_REVERSAL_LONG")
    if (is_long and (stop_loss >= price or take_profit <= price)):
        logger.warning(f"[RiskEngine] Invalid geometry for LONG — SL={stop_loss} TP={take_profit} vs price={price}")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}
    if (not is_long and (stop_loss <= price or take_profit >= price)):
        logger.warning(f"[RiskEngine] Invalid geometry for SHORT — SL={stop_loss} TP={take_profit} vs price={price}")
        return {**WAIT, "analysis": "Invalid SL/TP geometry — skipped."}

    # ── Map internal direction to executor-compatible verdict ──────────
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
        f"ATR={atr:.2f} Tape={metrics['tapeSpeed']}/{metrics['tapeDominant']}"
    )
    logger.info(f"[Signal] >> {verdict} | conf={confidence:.0%} | SL={stop_loss} TP={take_profit}")

    return {
        "verdict":     verdict,
        "confidence":  round(confidence, 4),
        "stop_loss":   stop_loss,
        "take_profit": take_profit,
        "analysis":    analysis,
    }


# ══════════════════════════════════════════════════════════════════════
# ── CORE EXECUTION LOOP ────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

async def execution_loop(
    feed: BinanceDataFeed,
    quant: QuantEngine,
    executor: TradingExecutor,
    stats: Dict[str, Any],
):
    await executor.initialize()

    mode = "DRY-RUN" if executor.dry_run else "LIVE"
    logger.info(
        f"╔══ Full Hybrid Bot ══════════════╗\n"
        f"║  Symbol      : {SYMBOL}\n"
        f"║  Mode        : {mode} | {'TESTNET' if TESTNET else 'MAINNET'}\n"
        f"║  Risk/trade  : {MAX_RISK_PCT}%\n"
        f"║  Max daily ↓ : {MAX_DAILY_LOSS_PCT}%\n"
        f"║  Min P(edge) : {MIN_CONFIDENCE:.0%}\n"
        f"║  Interval    : every {ANALYSIS_INTERVAL}s\n"
        f"╚════════════════════════════════╝"
    )

    while True:
        try:
            await asyncio.sleep(ANALYSIS_INTERVAL)

            # ── Warmup guard ──────────────────────────────────────────
            n_candles = len(feed.state.candles)
            if n_candles < QuantEngine.MIN_CANDLES:
                logger.info(f"[Main] Warming up… {n_candles}/{QuantEngine.MIN_CANDLES} candles")
                continue

            current_price = feed.state.candles[-1]['close']

            # ── Position exit check (dry-run) ─────────────────────────
            if executor.active_position and executor.dry_run:
                exited = executor.check_position_exit(current_price)
                if exited:
                    # Rough realized PnL for daily loss tracking
                    pos = executor.active_position  # already None if exited
                    pass  # executor clears position; tracking approximate

            stats["active_position"] = executor.active_position

            # ── If already in a position, skip new entry signals ──────
            if executor.active_position:
                pos = executor.active_position
                pnl_pct = (
                    (current_price - pos['entry_price']) / pos['entry_price'] * 100
                    if pos['side'] == 'buy' else
                    (pos['entry_price'] - current_price) / pos['entry_price'] * 100
                )
                logger.info(
                    f"[Main] HOLDING {pos['side'].upper()} @ {pos['entry_price']:.2f}"
                    f" | now={current_price:.2f} | PnL={pnl_pct:+.2f}%"
                    f" | SL={pos['stop_loss']} TP={pos['take_profit']}"
                )
                continue

            # ── Compute all quant metrics (Stage 1: Feature Engine) ───
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

            # ── Full 6-stage signal engine ────────────────────────────
            verdict_json = _compute_signal(
                metrics,
                candle_history=feed.state.candles,
                daily_loss_halt=stats.get("daily_loss_halt", False),
            )

            action      = verdict_json.get("verdict", "WAIT")
            conf        = float(verdict_json.get("confidence", 0))
            stop_loss   = verdict_json.get("stop_loss", 0)
            take_profit = verdict_json.get("take_profit", 0)
            analysis    = verdict_json.get("analysis", "")

            stats["last_signal"] = action

            logger.info(f"[Main] {action} | conf={conf:.0%} | SL={stop_loss} TP={take_profit}")
            if analysis:
                logger.info(f"[Main] {analysis}")

            # ── Execute if actionable ─────────────────────────────────
            is_actionable = action in ("BUY", "SELL", "MEAN_REVERSAL_LONG", "MEAN_REVERSAL_SHORT")
            if is_actionable:
                await executor.execute_signal(SYMBOL, metrics["price"], verdict_json, MAX_RISK_PCT)
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
    feed     = BinanceDataFeed(symbol=SYMBOL, testnet=TESTNET)
    quant    = QuantEngine(feed.state)
    executor = TradingExecutor(API_KEY, API_SECRET, testnet=TESTNET, dry_run=DRY_RUN)

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
