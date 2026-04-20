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
