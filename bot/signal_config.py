"""
bot/signal_config.py
====================
Single source of truth for ALL signal thresholds across the Quad-Desk trading bot.

Update thresholds HERE — never in individual files.  Both the live execution engine
(bot/main.py) and backtester (bot/backtest_hybrid.py) should import from this module
so that backtest and live results are always synchronised.

OFI RANGE NOTE (v3, Apr 2026):
    After the Three-Stage OFI Integrity Pipeline (quant_engine.py), OFI output
    is in the range (-1, +1) via tanh normalisation.  All OFI thresholds below
    are expressed in this new normalised scale.  Old scale was ±100.
"""

# ── Bayesian / Confidence ─────────────────────────────────────────────────────
MIN_BAYESIAN           = 0.62   # Minimum posterior confidence for any entry
MIN_BAYESIAN_STRONG    = 0.72   # Strong-signal threshold (STRONG_LONG / STRONG_SHORT)

# ── Z-Score (Student's t-distribution VWAP Z) ────────────────────────────────
Z_OVERSOLD             = -1.5   # Z below this = statistically depressed price
Z_OVERBOUGHT           =  1.5   # Z above this = statistically stretched price
MEAN_REV_Z_THRESHOLD   =  2.2   # |Z| required for a mean-reversion signal

# ── OFI (tanh output, range -1 to +1) ────────────────────────────────────────
OFI_STRONG_THRESHOLD   =  0.6   # Strong directional flow (equivalent to old |OFI| > 40)
OFI_MID_THRESHOLD      =  0.3   # Moderate flow (equivalent to old |OFI| > 10)
OFI_WEAK_THRESHOLD     =  0.15  # Weak / noise floor

# ── Skewness ──────────────────────────────────────────────────────────────────
SKEW_SIGNIFICANT       = 0.3    # |skewness| above this is considered meaningful

# ── Risk / Position Sizing ────────────────────────────────────────────────────
MAX_RISK_PCT           = 1.0    # Max risk per trade as % of equity
MAX_DAILY_LOSS_PCT     = 3.0    # Stop trading if daily loss hits this %
MAX_DRAWDOWN_PCT       = 15.0   # Hard session drawdown halt (restart required)
ATR_SL_MULTIPLIER      = 1.5    # SL = entry ± ATR × this
ATR_TP_MULTIPLIER      = 3.0    # TP = entry ± ATR × this (3:2 RR minimum)

# ── Strategy Scoring ──────────────────────────────────────────────────────────
TREND_SCORE_MIN        = 1.5    # Minimum composite score for a trend entry
WALL_PROXIMITY_PCT     = 0.003  # % distance to qualify as LIQUIDITY regime

# ── ULIS Gate ─────────────────────────────────────────────────────────────────
ULIS_CONFIDENCE_STRONG = 0.68   # ALDE confidence threshold for STRONG_LONG/SHORT
ULIS_CASCADE_ABORT     = 0.65   # cascade_risk above this → AVOID verdict

# ── Cooldowns ─────────────────────────────────────────────────────────────────
POST_TRADE_COOLDOWN_S  = 180    # seconds after any exit before new entry allowed
CASCADE_COOLDOWN_S     = 300    # seconds after SL exit (cascade prevention)
CONSECUTIVE_LOSS_HALT  = 2      # consecutive SL exits triggers 2-hour hard timeout

# ══════════════════════════════════════════════════════════════════════════════
# ── REGIME-CONDITIONAL PARAMETER MATRIX (HMM Spec, Apr 2026) ─────────────────
# ══════════════════════════════════════════════════════════════════════════════
#
# Every downstream stage reads from this dict rather than using static constants.
# Replaces fixed thresholds (e.g. z >= 2.2 always) with adaptive ones that fit
# the current market environment as classified by the HMM.
#
# Regime → Strategy mapping:
#   RANGE     → Mean-reversion dominant (quiet market, tight SL, low Z bar)
#   NEUTRAL   → All strategies active  (default / transitional)
#   TREND     → Trend-following dominant (noisy market, wide SL, high Z bar)
#   LIQUIDITY → Wall-proximity sweep   (same defaults as NEUTRAL, no HTF block)
#
REGIME_PARAMS = {
    "RANGE": {
        # Low-volatility: small deviations are statistically meaningful
        "z_threshold":        1.5,   # Lower than default — z=1.5 is a big move in quiet markets
        "atr_multiplier_sl":  1.2,   # Tight SL — low vol absorbs less noise
        "atr_multiplier_tp":  2.2,   # TP = SL × TP_MULT (spec RR target 1.8:1)
        "ofi_bound":          0.10,  # tanh scale — moderate OFI sufficient in RANGE
        "min_confidence":     0.58,  # More liberal — RANGE mean-reversion edges are cleaner
        "rr_target":          1.8,   # 1.8:1 minimum R:R (lower fees in futures allow this)
        "be_lock_trigger":    0.8,   # Move SL to break-even after 0.8×ATR profit
        "panic_threshold":    2.5,   # Flash-crash trigger: 2.5% drop in 5 candles
        "candle_gate_sec":    45,    # Tight sweep window — RANGE reversals are fast
        "htf_block":          False, # Counter-HTF mean-reversion IS the strategy in RANGE
    },
    "NEUTRAL": {
        # Normal-volatility: balanced thresholds, all strategies valid
        "z_threshold":        1.8,
        "atr_multiplier_sl":  1.5,
        "atr_multiplier_tp":  3.0,   # 2.0:1 R:R
        "ofi_bound":          0.15,
        "min_confidence":     0.62,
        "rr_target":          2.0,
        "be_lock_trigger":    1.0,
        "panic_threshold":    5.0,
        "candle_gate_sec":    60,
        "htf_block":          True,
    },
    "TREND": {
        # High-volatility: only high-conviction signals, wide stops
        "z_threshold":        2.5,   # High bar — z=1.5 is just noise in a trending market
        "atr_multiplier_sl":  2.2,   # Wide SL — trending moves are volatile
        "atr_multiplier_tp":  5.5,   # 2.5:1 R:R at 2.2×ATR SL
        "ofi_bound":          0.25,  # Strong OFI required in noisy TREND market
        "min_confidence":     0.72,  # Higher bar — more false signals in volatile regime
        "rr_target":          2.5,
        "be_lock_trigger":    1.2,
        "panic_threshold":    8.0,   # Only halt on extreme crash in TREND (crashes part of it)
        "candle_gate_sec":    90,    # Wider sweep window — TREND moves persist longer
        "htf_block":          True,  # Always require HTF alignment in TREND
    },
    "LIQUIDITY": {
        # Wall-proximity: sweep-focused, NEUTRAL defaults with no HTF block
        "z_threshold":        1.8,
        "atr_multiplier_sl":  1.5,
        "atr_multiplier_tp":  3.0,
        "ofi_bound":          0.15,
        "min_confidence":     0.60,  # Slightly more liberal — wall sweeps are high-probability
        "rr_target":          2.0,
        "be_lock_trigger":    1.0,
        "panic_threshold":    5.0,
        "candle_gate_sec":    60,
        "htf_block":          False, # Don't block counter-trend sweeps — they're the strategy
    },
}
