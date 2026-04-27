"""
ULIS/ALDE Hybrid Verdict Engine — Python Port
==============================================
This is a direct translation of the computeAIVerdict() function from ULISView.tsx.
It takes the same live market metrics computed by QuantEngine and produces an
8-type verdict that acts as Stage 7 (final confirmation gate) before order execution.

Verdict types:
  STRONG_LONG    — Full ALDE+ULIS bullish alignment (6-condition AND gate)
  LONG           — Moderate bullish bias
  SHORT          — Moderate bearish bias
  STRONG_SHORT   — Full ALDE+ULIS bearish alignment (6-condition AND gate)
  NEUTRAL        — No clear edge (let trade through unchanged)
  BREAKOUT_WATCH — Liquidity vacuum forming (let trade through unchanged)
  AVOID          — Cascade risk critical — veto all trades
  UNWIND         — Pre-cascade — veto all trades
"""

import logging
import math
from typing import Dict, Any, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Helpers (mirror TS clamp / normalize / sigmoid)
# ──────────────────────────────────────────────────────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))

def _normalize(v: float, lo: float, hi: float) -> float:
    return _clamp((v - lo) / (hi - lo), 0.0, 1.0) if hi > lo else 0.0

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


# ──────────────────────────────────────────────────────────────────────────────
# Proxy Score Builder
# ──────────────────────────────────────────────────────────────────────────────

def _build_scores_from_metrics(metrics: Dict[str, Any], bids: List, asks: List) -> Dict[str, Any]:
    """
    Derive the ULIS score components directly from QuantEngine metrics.
    Since we don't have the full frontend data pipeline (GLR feeds, ETF flows, etc.)
    we use principled proxies derived from metrics we DO have.

    v2 change: GLR score now uses FUNDING RATE instead of OFI.
    OFI was collinear with bayesianPosterior (both driven by order-flow) causing
    confidence inflation. Funding rate is orthogonal — it captures crowding/positioning
    pressure rather than instantaneous order imbalance.
    """
    ofi          = metrics.get("ofi", 0.0)
    rsi          = metrics.get("rsi", 50.0)
    z            = metrics.get("zScore", 0.0)
    bayes        = metrics.get("bayesianPosterior", 0.5)
    cvd          = metrics.get("cvd", 0.0)
    atr_pct      = metrics.get("atr_pct", 0.005)
    tape         = metrics.get("tapeSpeed", "NORMAL")
    dominant     = metrics.get("tapeDominant", "BALANCED")
    funding_rate = metrics.get("funding_rate", 0.0)   # NEW: independent signal

    # NLF Score proxy: bayesian posterior is the best single-metric bull field indicator
    nlf_score = _clamp(bayes, 0.0, 1.0)

    # GLR Score proxy: RSI momentum + FUNDING RATE (orthogonal to OFI/Bayes) + CVD direction
    # Funding rate interpretation:
    #   Positive (+) = longs paying shorts → crowded long → bearish pressure on price
    #   Negative (-) = shorts paying longs → crowded short → bullish squeeze risk
    # We INVERT and normalise so that negative funding → high (bullish) score.
    rsi_norm     = _normalize(rsi, 20.0, 80.0)
    # Funding range: typical Binance USDM range is ±0.05% per 8h (±0.0005)
    # Invert sign: negative funding is bullish→ maps to high norm value
    funding_norm = _normalize(-funding_rate, -0.0005, 0.0005)
    cvd_norm     = 0.6 if cvd > 0 else 0.4
    glr_score    = _clamp(rsi_norm * 0.40 + funding_norm * 0.35 + cvd_norm * 0.25, 0.0, 1.0)

    # Reflexivity Score proxy: high ATR% + screaming tape = high reflexivity (instability)
    atr_reflexivity  = _normalize(atr_pct, 0.003, 0.025)
    tape_reflexivity = 0.7 if tape == "SCREAMING" else 0.2
    reflexivity_score = _clamp(atr_reflexivity * 0.6 + tape_reflexivity * 0.4, 0.0, 1.0)

    # Fragility proxy: distance from Z-Score extremes indicates fragility
    z_fragility = _normalize(abs(z), 0.5, 3.0)
    fragility   = _clamp(z_fragility * 0.5 + atr_reflexivity * 0.5, 0.0, 1.0)

    # Visible liquidity proxy from OFI depth
    # OFI is now in (-1, +1) after the Three-Stage Pipeline (tanh output)
    visible_liquidity = _normalize(abs(ofi), 0.0, 0.6)

    # Latent liquidity: inverse of reflexivity (stable market = more resting liquidity)
    latent_liquidity = _clamp(1.0 - reflexivity_score, 0.0, 1.0)

    bayesian_baseline = bayes * 100.0
    glr_components = {
        "stablecoins": bayesian_baseline + (funding_rate * -10000.0),  # funding drag/boost in bps
        "etfFlows":    bayesian_baseline + (cvd / 5000.0),
    }

    return {
        "nlfScore":         nlf_score,
        "glrScore":         glr_score,
        "reflexivityScore": reflexivity_score,
        "fragility":        fragility,
        "visibleLiquidity": visible_liquidity,
        "latentLiquidity":  latent_liquidity,
        "glrComponents":    glr_components,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Sweep / BOS Counters (derived from candle history)
# ──────────────────────────────────────────────────────────────────────────────

def _count_sweeps(candles: list, bids_dict: Dict, asks_dict: Dict) -> Tuple[int, List]:
    """
    Count liquidity sweeps (wick pierces a wall then closes back).
    Uses last 10 candles for recency.
    Returns (sweep_count, bos_list).
    """
    sweep_count = 0
    bos_list = []

    if len(candles) < 3 or not bids_dict or not asks_dict:
        return sweep_count, bos_list

    # Nearest walls
    bid_prices = sorted(bids_dict.keys(), reverse=True)
    ask_prices = sorted(asks_dict.keys())
    if not bid_prices or not ask_prices:
        return sweep_count, bos_list

    nearest_bid = bid_prices[0]
    nearest_ask = ask_prices[0]

    recent = list(candles)[-10:]
    for i in range(1, len(recent)):
        c = recent[i]
        p = recent[i - 1]
        if p["high"] > nearest_ask and c["close"] < nearest_ask:
            sweep_count += 1
        if p["low"] < nearest_bid and c["close"] > nearest_bid:
            sweep_count += 1
        # BOS: consecutive higher-lows or lower-highs = structure break
        if c["close"] > p["high"]:
            bos_list.append({"dir": "up", "price": c["close"]})
        elif c["close"] < p["low"]:
            bos_list.append({"dir": "down", "price": c["close"]})

    return sweep_count, bos_list


# ──────────────────────────────────────────────────────────────────────────────
# FVG Counter (Fair Value Gap) from candles
# ──────────────────────────────────────────────────────────────────────────────

def _count_fvgs(candles: list) -> int:
    """Count fair-value gaps in last 15 candles (3-candle gap pattern)."""
    count = 0
    recent = list(candles)[-15:]
    for i in range(2, len(recent)):
        prev2 = recent[i - 2]
        curr = recent[i]
        if curr["low"] > prev2["high"]:   # bullish FVG
            count += 1
        elif curr["high"] < prev2["low"]:  # bearish FVG
            count += 1
    return count


# ──────────────────────────────────────────────────────────────────────────────
# Order Book Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _book_to_levels(book_dict: Dict[float, float]) -> List[Dict[str, float]]:
    """Convert {price: size} dict to list of {price, size} for TS parity."""
    return [{"price": p, "size": s, "classification": "WALL" if s > 0 else "NORMAL"}
            for p, s in book_dict.items()]


# ──────────────────────────────────────────────────────────────────────────────
# Main ULIS Verdict Function
# ──────────────────────────────────────────────────────────────────────────────

MIN_SWEEP_CONFIRMS = 2

def _sweep_micro_confirms(metrics: dict, sweep_direction: str) -> int:
    """FIX NEW-H1: 3rd signal now orthogonal funding rate."""
    confirms = 0
    rsi = metrics.get("rsi", 50.0)
    if sweep_direction == "bull" and rsi < 38:
        confirms += 1
    elif sweep_direction == "bear" and rsi > 62:
        confirms += 1
    ofi = metrics.get("ofi", 0.0)
    if sweep_direction == "bull" and ofi > 0.15:
        confirms += 1
    elif sweep_direction == "bear" and ofi < -0.15:
        confirms += 1
    funding = metrics.get("funding_rate", 0.0)
    if sweep_direction == "bull" and funding < -0.0005:
        confirms += 1
    elif sweep_direction == "bear" and funding > 0.0008:
        confirms += 1
    return confirms

def compute_ulis_verdict(
    metrics: Dict[str, Any],
    candles: list,
    bids_dict: Dict[float, float],
    asks_dict: Dict[float, float],
) -> Dict[str, Any]:
    """
    Run the ALDE+ULIS hybrid verdict engine on live market metrics.

    Returns:
        {
            verdict: str,           # STRONG_LONG | LONG | SHORT | STRONG_SHORT | NEUTRAL | AVOID | UNWIND | BREAKOUT_WATCH
            confidence: float,      # 0–1
            cascade_risk: float,    # 0–1 sigmoid cascade index
            liquidity_vector: float,# -1 to +1  (+ = bullish pressure)
            regime_label: str,      # human-readable market state description
            should_trade: bool,     # False → veto the trade entirely
            confidence_boost: float,# positive = boost, negative = reduce
        }
    """
    ofi           = metrics.get("ofi", 0.0)
    z_score       = metrics.get("zScore", 0.0)
    bayes         = metrics.get("bayesianPosterior", 0.5)
    cvd           = metrics.get("cvd", 0.0)
    price         = metrics.get("price", 0.0)

    bids = _book_to_levels(bids_dict)
    asks = _book_to_levels(asks_dict)

    # ── Build proxy scores ────────────────────────────────────────────────────
    scores = _build_scores_from_metrics(metrics, bids, asks)

    # ── Sweep / BOS / FVG counters ────────────────────────────────────────────
    sweep_count, bos_list = _count_sweeps(candles, bids_dict, asks_dict)
    fvg_count = _count_fvgs(candles)

    # ── Phase 1: Feature Fusion ───────────────────────────────────────────────
    # OFI is now in (-1, +1) from tanh pipeline — no need to divide by 40
    ofi_signal    = _clamp(ofi, -1.0, 1.0)
    bayes_signal  = (bayes - 0.5) * 2.0         # -1 to +1
    # leverage_proxy: OFI tanh output, scaled so |1| maps to high leverage
    leverage_proxy = _normalize(abs(ofi), 0.0, 0.8)

    total_bid = sum(b["size"] for b in bids)
    total_ask = sum(a["size"] for a in asks)
    total_depth = total_bid + total_ask or 1.0
    bid_frac = total_bid / total_depth
    ask_frac = total_ask / total_depth

    sweep_bull = min(sweep_count / 6.0, 1.0) if sweep_count > 0 and bayes_signal > 0 else 0.0
    sweep_bear = min(sweep_count / 6.0, 1.0) if sweep_count > 0 and bayes_signal < 0 else 0.0

    # ── Phase 2: ALDE Market State Classifier ────────────────────────────────
    trend_agreement = (
        math.copysign(1, ofi_signal) == math.copysign(1, bayes_signal) and
        abs(ofi_signal) > 0.15 and abs(bayes_signal) > 0.15
    )

    if trend_agreement:
        cascade_risk = _sigmoid(
            scores["reflexivityScore"] * 1.5 +
            scores["fragility"] * 1.5 +
            leverage_proxy * 2.0 - 4.0
        )
    else:
        cascade_risk = _sigmoid(
            scores["reflexivityScore"] * 3.0 +
            scores["fragility"] * 2.0 +
            leverage_proxy * 2.0 - 3.0
        )
    if cascade_risk > 0.70 or scores["fragility"] > 0.65:
        market_state = "UNSTABLE"
    elif abs(bayes_signal) > 0.25 and trend_agreement:
        market_state = "TRENDING"
    else:
        market_state = "RANGE"

    # ── Phase 3: Liquidity Pressure Scores ───────────────────────────────────
    glr_stables = scores["glrComponents"].get("stablecoins", 55.0)
    glr_etf     = scores["glrComponents"].get("etfFlows", 50.0)

    ulp = _clamp(
        bid_frac * 0.30 +
        scores["nlfScore"] * scores["latentLiquidity"] * 0.30 +
        sweep_bull * 0.15 +
        (glr_stables / 100.0) * 0.25,
        0.0, 1.0
    )
    dlp = _clamp(
        ask_frac * 0.30 +
        (1.0 - scores["nlfScore"]) * scores["latentLiquidity"] * 0.30 +
        sweep_bear * 0.15 +
        (1.0 - glr_etf / 100.0) * 0.25,
        0.0, 1.0
    )

    # ── Phase 4: Net Liquidity Vector ────────────────────────────────────────
    liquidity_vector = _clamp(ulp - dlp, -1.0, 1.0)

    # ── Phase 5: ALDE Confidence Score ───────────────────────────────────────
    ilih_score = _normalize(total_depth, 1000.0, 80000.0)
    alde_conf0 = (
        0.25 * ilih_score +
        0.22 * scores["glrScore"] +
        0.20 * scores["nlfScore"] +   # reduced from 0.25: bayes already priced via nlf_score
        0.20 * (1.0 - scores["reflexivityScore"]) +
        0.13 * (1.0 - scores["fragility"])
    )
    # 3.2 FIX: Removed bayes_boost — bayesianPosterior already feeds nlf_score (double-counting).
    # Only CVD boost remains as it's an orthogonal (independent) signal.
    cvd_boost   = _clamp(cvd / 5_000_000.0, -0.06, 0.06) * math.copysign(1, liquidity_vector or 1)
    alde_confidence = _clamp(alde_conf0 + cvd_boost, 0.0, 1.0)

    # ── Phase 6: Verdict AND-Gates ───────────────────────────────────────────
    is_high_volatility   = scores["fragility"] > 0.55 or scores["reflexivityScore"] > 0.55
    is_mean_reversion    = abs(z_score) > 1.8 and not trend_agreement
    is_liquidity_vacuum  = scores["visibleLiquidity"] < 0.35 and fvg_count > 1
    is_bos_confirmed     = len(bos_list) > 0
    cascade_warning      = cascade_risk > 0.60

    if cascade_risk > 0.65 and scores["reflexivityScore"] > 0.50:
        verdict = "AVOID"
        regime_label = "Cascade Risk Critical — Liquidity Singularity · STAND ASIDE"
    elif cascade_warning and is_high_volatility and cascade_risk > 0.55:
        verdict = "UNWIND"
        regime_label = "Pre-Cascade: Volatility Expansion · Reduce Exposure Now"
    elif market_state == "UNSTABLE" and not is_mean_reversion:
        verdict = "NEUTRAL"
        regime_label = "Market Unstable — Cascade Elevated · Wait for Stabilisation"
    elif (
        liquidity_vector > 0.28 and
        scores["nlfScore"] > 0.58 and
        scores["glrScore"] > 0.50 and
        cascade_risk < 0.45 and
        alde_confidence > 0.68 and
        bayes > 0.58
    ):
        verdict = "STRONG_LONG"
        regime_label = "ALDE+ULIS Bullish Confluence · Full Alignment — High Probability Long"
    elif liquidity_vector > 0.12 and alde_confidence > 0.58 and cascade_risk < 0.62:
        verdict = "LONG"
        regime_label = "Bullish Bias · Liquidity Vector Positive — Moderate ALDE Alignment"
    elif (
        liquidity_vector < -0.28 and
        scores["nlfScore"] < 0.42 and
        scores["glrScore"] < 0.50 and
        cascade_risk < 0.45 and
        alde_confidence > 0.68 and
        bayes < 0.42
    ):
        verdict = "STRONG_SHORT"
        regime_label = "ALDE+ULIS Bearish Confluence · Full Alignment — High Probability Short"
    elif liquidity_vector < -0.12 and alde_confidence > 0.58 and cascade_risk < 0.62:
        verdict = "SHORT"
        regime_label = "Bearish Bias · Liquidity Vector Negative — Moderate ALDE Alignment"
    elif is_mean_reversion:
        verdict = "SHORT" if z_score > 0 else "LONG"
        regime_label = "Mean Reversion Play — Z-Score Extreme · Fade the Extension"
    elif is_liquidity_vacuum and abs(liquidity_vector) > 0.12:
        verdict = "BREAKOUT_WATCH"
        regime_label = "Liquidity Vacuum · Breakout Conditions Forming"
    else:
        verdict = "NEUTRAL"
        regime_label = "ALDE Equilibrium — Liquidity Vector Near Zero · No Actionable Edge"

    # ── Determine trade gate ──────────────────────────────────────────────────
    should_trade = verdict not in ("AVOID", "UNWIND")

    # ── Confidence modifier ───────────────────────────────────────────────────
    confidence_boost = 0.0
    if verdict == "STRONG_LONG" or verdict == "STRONG_SHORT":
        confidence_boost = 0.08
    elif verdict == "AVOID" or verdict == "UNWIND":
        confidence_boost = -1.0   # This ensures confidence drops below threshold
    elif verdict == "NEUTRAL":
        confidence_boost = 0.0    # No ULIS edge but no veto — let regime/Bayesian decide
    elif verdict == "BREAKOUT_WATCH":
        confidence_boost = -0.02  # Mild caution: breakout vacuum, not a directional veto

    logger.info(
        f"[ULIS] verdict={verdict} | vector={liquidity_vector:.3f} | "
        f"cascade={cascade_risk:.2f} | conf={alde_confidence:.2%} | "
        f"state={market_state} | sweeps={sweep_count} | BOS={len(bos_list)}"
    )

    return {
        "verdict":          verdict,
        "confidence":       round(alde_confidence, 4),
        "cascade_risk":     round(cascade_risk, 4),
        "liquidity_vector": round(liquidity_vector, 4),
        "regime_label":     regime_label,
        "should_trade":     should_trade,
        "confidence_boost": confidence_boost,
        "ulp":              round(ulp, 4),
        "dlp":              round(dlp, 4),
        "market_state":     market_state,
        "sweep_count":      sweep_count,
    }
