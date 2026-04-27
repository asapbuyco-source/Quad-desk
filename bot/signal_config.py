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
MEAN_REV_Z_THRESHOLD   =  1.5   # matches NEUTRAL z_threshold in REGIME_PARAMS

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
POST_TRADE_COOLDOWN_S  = 90     # seconds after any exit before new entry allowed
CASCADE_COOLDOWN_S     = 300    # seconds after SL exit (cascade prevention)
CONSECUTIVE_LOSS_HALT  = 3      # was 2 — reduces false lockouts

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
        "z_threshold":        1.3,   # Was 1.5. Triggers mean-reversion earlier
        "atr_multiplier_sl":  1.14,   # Was 1.2 — 5% reduction post-Wilder compensation
        "ofi_bound":          0.08,  # Was 0.10. Needs less order flow to enter
        "min_confidence":     0.55,  # Was 0.58. 55% win-probability required
        "rr_target":          1.8,   # 1.8:1 minimum R:R
        "be_lock_trigger":    0.8,   # Move SL to break-even after 0.8×ATR profit
        "panic_threshold":    2.5,   # Flash-crash trigger
        "candle_gate_sec":    30,    # Was 45s. Faster entry
        "htf_block":          False, # Counter-HTF is the strategy in RANGE
        "cascade_cooldown_s": 180,   # STRATEGY-B: 3min (quiet market recovers fast)
    },
    "NEUTRAL": {
        # Normal-volatility: balanced thresholds
        "z_threshold":        1.5,
        "atr_multiplier_sl":  1.43,
        "ofi_bound":          0.12,
        "min_confidence":     0.58,
        "rr_target":          2.0,
        "be_lock_trigger":    1.5,  # widened: move SL to BE only after 1.5×ATR profit
        "panic_threshold":    5.0,
        "candle_gate_sec":    45,    # Was 60s
        "htf_block":          True,
        "cascade_cooldown_s": 300,   # STRATEGY-B: 5min (default)
    },
    "TREND": {
        # High-volatility: trend-following
        "z_threshold":        2.0,   # Was 2.5. Triggers on shallower pullbacks
        "atr_multiplier_sl":  2.09,  # Was 2.2 — 5% reduction post-Wilder compensation 
        "ofi_bound":          0.20,  # Was 0.25
        "min_confidence":     0.65,  # Was 0.72. Massive increase in trend trades
        "rr_target":          2.5,
        "be_lock_trigger":    2.0,  # widened: let trend breathe — do not lock BE until 2×ATR profit
        "panic_threshold":    8.0,   
        "candle_gate_sec":    60,    # Was 90s
        "htf_block":          True,  
        "cascade_cooldown_s": 240,   # STRATEGY-B: 4min (trend may still be valid)
    },
"LIQUIDITY": {
        # Wall-proximity sweeps
        "z_threshold":        1.5,
        "atr_multiplier_sl":  1.43,
        "ofi_bound":          0.12,
        "min_confidence":     0.62,
        "rr_target":          2.0,
        "be_lock_trigger":    1.5,  # widened: move SL to BE only after 1.5×ATR profit
        "panic_threshold":    5.0,
        "candle_gate_sec":    45,    # Was 60s
        "htf_block":          False, 
        "cascade_cooldown_s": 180,   # STRATEGY-B: 3min (sweep may repeat next candle)
    },
}
