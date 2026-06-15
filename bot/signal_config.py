"""
bot/signal_config.py
====================
Single source of truth for ALL signal thresholds across the Quad-Desk trading bot.

Update thresholds HERE — never in individual files.  Both the live execution engine
(bot/main.py) and backtester (bot/backtest_hybrid.py) should import from this module
so that backtest and live results are always synchronised.
"""

# ── Risk / Position Sizing ────────────────────────────────────────────────────
MAX_RISK_PCT           = 1.0    # Max risk per trade as % of equity
MAX_DAILY_LOSS_PCT     = 3.0    # Stop trading if daily loss hits this %
MAX_DRAWDOWN_PCT       = 15.0   # Hard session drawdown halt (restart required)

# ── Equity Thresholds (P17 FIX: centralized here) ──────────────────────────────
# P17 FIX: Centralized equity thresholds — import from signal_config in main.py
EQUITY_HARD_BLOCK      = 50.0   # Bot refuses to trade below this
EQUITY_SMALL_ACCOUNT   = 150.0  # Below this: small-account risk cap (0.75% instead of 1%)
EQUITY_RECOMMENDED     = 200.0  # Below this: warning logged at startup


# ── Global Confidence Floor ───────────────────────────────────────────────────
MIN_CONFIDENCE_GLOBAL  = 0.62   # Used as floor for MIN_CONFIDENCE env override

# ── Cooldowns ─────────────────────────────────────────────────────────────────
POST_TRADE_COOLDOWN_S  = 90     # seconds after any exit before new entry allowed

# ── Bayesian Cold-Start ─────────────────────────────────────────────────────────
COLD_START_TRADE_COUNT = 30
COLD_START_CONFIDENCE_DISCOUNT = 0.05

# ── Strategy / Signal Thresholds ──────────────────────────────────────────────
FUNDING_LONG_BLOCK = 0.0008
FUNDING_SHORT_BLOCK = -0.0005
BAYES_OVERRIDE_THRESHOLD = 0.78
CVD_VETO_STRENGTH = 0.62
CVD_VETO_VOL_SPIKE = 1.40
MIN_SWEEP_CONFIRMS = 2

# ── Per-Symbol ATR Normalisation Scale ─────────────────────────────────────────
# The HMM emission matrices (_MU/_SIGMA) were calibrated on 1-year BTC 15m data.
# SOL and ETH have structurally higher ATR% at the same market regime (e.g. SOL
# RANGE looks like BTC TREND from a raw ATR% perspective). Dividing atr_pct by
# this factor before feeding into the HMM re-anchors each coin to the BTC scale,
# so the BTC-calibrated thresholds classify all symbols correctly.
#
# Values derived from 6-month median ATR% ratios vs BTC (Jun 2026):
#   BTC median RANGE ATR% ≈ 0.21%
#   ETH median RANGE ATR% ≈ 0.29%  → scale ≈ 1.4
#   SOL median RANGE ATR% ≈ 0.68%  → scale ≈ 3.2
SYMBOL_ATR_SCALE = {
    "BTC":  1.0,    # reference — no scaling
    "ETH":  1.4,    # ~40% more volatile than BTC at same regime
    "SOL":  3.2,    # ~3× more volatile than BTC at same regime
    "BNB":  1.8,
    "AVAX": 2.5,
    "DOGE": 2.8,
    "WIF":  4.0,
    "PEPE": 5.0,
    "INJ":  3.0,
    "ARB":  2.5,
    "OP":   2.5,
}
# Default scale for unknown symbols (assume moderately more volatile than BTC)
SYMBOL_ATR_SCALE_DEFAULT = 2.0

# ── OFI Normaliser Warm-Up Guard ──────────────────────────────────────────────
# After a restart the OFI EWMA needs ~20 cycles to settle from the arbitrary
# seed values (mu=0, var=1). During this window OFI readings are meaningless.
# Any OFI-gated decisions treat OFI as neutral (0.0) for this many cycles.
OFI_WARMUP_CYCLES = 20

# These regime parameters are hand-tuned placeholders. The HMM emission
# parameters (_MU, _SIGMA in main.py _HMMRegimeClassifier) are ALSO
# hand-tuned placeholders. Run `python -m bot.hmm_calibrate` on ≥6 months
# of historical 15m data to derive validated HMM emission parameters.
# Then update _MU / _SIGMA in main.py before deploying with live capital.
# The backtest/sensitivity analysis script (bot/sensitivity_analysis.py) can
# be used to derive optimal REGIME_PARAMS values for your risk tolerance.
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
        "z_threshold":        1.06,  # M-02 FIX: was 1.3, Student-t adj (1.3×0.8165)
        "atr_multiplier_sl":  1.14,   # Was 1.2 — 5% reduction post-Wilder compensation
        "ofi_bound":          0.08,  # Was 0.10. Needs less order flow to enter
        "min_confidence":     0.62,  # was 0.55 — raised to match LIQUIDITY threshold
        "rr_target":          1.8,   # 1.8:1 minimum R:R
        "be_lock_trigger":    0.8,   # Move SL to break-even after 0.8×ATR profit
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      900,   # Hold at least one 15m candle before regime time exit
        "panic_threshold":    10.0,  # FIX-R4: was 2.5 — unify with ATR panic gate at 0.90
        "candle_gate_sec":    30,    # Was 45s. Faster entry
        "htf_block":          False, # Counter-HTF is the strategy in RANGE
        "cascade_cooldown_s": 180,   # PHASE-2.5: was 300s, lowered to 180s for RANGE recovery
    },
    "NEUTRAL": {
        # Normal-volatility: balanced thresholds
        "z_threshold":        1.50,  # B3: raised from 1.22 (Student-t adj no longer applied)
        "atr_multiplier_sl":  1.43,
        "ofi_bound":          0.10,  # PHASE-4.1: was 0.12, lowered to 0.10 for more signal pass-through
        "min_confidence":     0.62,  # was 0.55 — raised to match LIQUIDITY threshold
        "rr_target":          2.0,
        "be_lock_trigger":    1.5,  # widened: move SL to BE only after 1.5×ATR profit
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      1200,  # 20 min max hold; avoids premature churn on 15m signals
        "panic_threshold":    10.0,  # FIX-R4: was 5.0 — unify with ATR panic gate at 0.90
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
        "partial_take_r":     0.75,
        "partial_take_pct":   0.40,
        "time_exit_sec":      1800,  # 30 min max hold; trend setups need room to resolve
        "panic_threshold":    10.0,  # FIX-R4: was 8.0 — unify with ATR panic gate at 0.90
        "candle_gate_sec":    60,    # Was 90s
        "htf_block":          True,  
        "cascade_cooldown_s": 240,   # STRATEGY-B: 4min (trend may still be valid)
    },
    "VOLATILE": {
        # Elevated ATR but no clean sweep. Prefer trend continuation; allow
        # stricter mean reversion only when tape is not screaming.
        "z_threshold":        1.75,
        "atr_multiplier_sl":  1.65,  # Phase 4.1: was 2.25
        "ofi_bound":          0.20,
        "min_confidence":     0.65,
        "rr_target":          1.80,  # Phase 4.1: was 2.3
        "be_lock_trigger":    2.0,
        "partial_take_r":     0.75,
        "partial_take_pct":   0.40,
        "time_exit_sec":      900,   # Phase 4.1: was 1200
        "panic_threshold":    10.0,
        "candle_gate_sec":    60,
        "htf_block":          True,
        "cascade_cooldown_s": 240,
    },
    "LIQUIDITY": {
        # Wall-proximity sweeps
        "z_threshold":        1.50,  # B3: raised from 1.22 (Student-t adj no longer applied)
        "atr_multiplier_sl":  1.43,
        "ofi_bound":          0.12,
        "min_confidence":     0.62,  # FIX-P10: was 0.55 which == sweep neutralizer floor (no-op); raised to 0.62 so threshold is meaningful
        "rr_target":          2.0,
        "be_lock_trigger":    1.5,  # widened: move SL to BE only after 1.5×ATR profit
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      900,   # Hold at least one 15m candle for liquidity sweeps
        "panic_threshold":    10.0,  # FIX-R4: was 5.0 — unify with ATR panic gate at 0.90
        "candle_gate_sec":    45,    # Was 60s
        "htf_block":          False,
        "cascade_cooldown_s": 180,   # STRATEGY-B: 3min (sweep may repeat next candle)
    },
    "SQUEEZE": {
        # Apr 2026 (Dr. Klint spec): Vacuum cascade / short squeeze detection
        # HMM state 2 (SQUEEZE) maps to LIQUIDITY for backwards compat (_LABELS[2]="LIQUIDITY").
        # This entry provides the tighter SL / wider TP strategy for when SQUEEZE fires.
        "z_threshold":        1.50,
        "atr_multiplier_sl":  0.50,   # TIGHTER SL: 0.5×ATR — vacuum can extend further
        "ofi_bound":          0.12,
        "min_confidence":     0.65,   # Higher bar — squeeze entries are risky
        "rr_target":          3.0,   # WIDER TP: squeeze snaps back violently
        "be_lock_trigger":    1.0,   # Lock BE faster — squeeze resolves in 3-8 candles
        "partial_take_r":     0.50,
        "partial_take_pct":   0.50,
        "time_exit_sec":      600,   # 10 min max for vacuum resolution without instant churn
        "panic_threshold":    5.0,   # Tighter panic — squeeze moves fast
        "candle_gate_sec":    30,
        "htf_block":          False,
        "cascade_cooldown_s": 120,   # 2min — squeeze can repeat rapidly
    },
}

# REGIME_ALIAS: maps HMM state names that don't have their own REGIME_PARAMS entry
# to an existing entry. SQUEEZE (HMM state 2) is named LIQUIDITY in _LABELS, so
# this alias is for the case where the HMM regime label is literally "SQUEEZE".
# The bot currently uses LIQUIDITY params for SQUEEZE state (backwards compat).
REGIME_ALIAS = {
    "SQUEEZE": "LIQUIDITY",
}
