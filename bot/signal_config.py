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
MIN_CONFIDENCE_GLOBAL  = 0.60   # P11 FIX: was 0.62 — 38 signals were blocked just below threshold

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

# A3 FIX: RV/IV compression/expansion thresholds — single source of truth.
# Both quant_engine.py (vol_state classification) and main.py (regime override)
# import from here. Previously 0.01 and 0.50 were used in different files.
RV_IV_COMPRESSION_THRESHOLD = 0.50
RV_IV_EXPANSION_THRESHOLD   = 1.20

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
        "rr_target":          2.3,   # 2.3:1 minimum R:R
        "be_lock_trigger":    0.8,   # Move SL to break-even after 0.8×ATR profit
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      900,
        "time_exit_hard_cap_s": 1800,
        "panic_threshold":    10.0,
        "candle_gate_sec":    30,
        "htf_block":          False,
        "cascade_cooldown_s": 180,
    },
    "COMPRESSION": {
        # F-02 FIX: Compression = coiling spring — low micro-vol but tightening ATR rank.
        # This is the pre-breakout state where volatility is building but |z| is still low.
        # Strategy: mean-reversion with moderate SL, achievable TP from coiling resolution.
        "z_threshold":        1.20,
        "atr_multiplier_sl":  1.20,   # Moderate SL — compression is slow, needs breathing room
        "ofi_bound":          0.08,
        "min_confidence":     0.62,
        "rr_target":          1.8,   # Achievable R:R — live trade showed 2.8 was unreachable (TP=2.94×ATR, market moved 0.25%)
        "be_lock_trigger":    1.0,
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      3600,  # 1 hour — coil resolves slowly, needs time (was 600s)
        "time_exit_hard_cap_s": 5400,  # 1.5h hard cap
        "panic_threshold":    10.0,
        "candle_gate_sec":    30,
        "htf_block":          False,
        "cascade_cooldown_s": 120,
    },
    "NEUTRAL": {
        # Normal-volatility: balanced thresholds
        # P11 FIX: z_threshold lowered 1.50→1.20 — exceeded once in 5 sessions.
        # slope+RSI gate provides signal quality filtering, allowing lower Z threshold.
        "z_threshold":        1.20,
        "atr_multiplier_sl":  1.43,
        "ofi_bound":          0.10,
        "min_confidence":     0.65,
        "rr_target":          2.5,
        "be_lock_trigger":    1.5,
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      1200,
        "time_exit_hard_cap_s": 2400,
        "panic_threshold":    10.0,
        "candle_gate_sec":    45,
        "htf_block":          False,  # P11 FIX: was True — blocked 100% of entries when HTF was BULL/BEAR
        "cascade_cooldown_s": 180,
    },
    "TREND": {
        # High-volatility: trend-following
        "z_threshold":        2.0,
        "atr_multiplier_sl":  2.09,
        "ofi_bound":          0.20,
        "min_confidence":     0.65,
        "rr_target":          3.0,
        "be_lock_trigger":    2.0,
        "partial_take_r":     0.75,
        "partial_take_pct":   0.40,
        "time_exit_sec":      5400,
        "time_exit_hard_cap_s": 10800,
        "panic_threshold":    10.0,
        "candle_gate_sec":    60,
        "htf_block":          True,
        "cascade_cooldown_s": 240,
    },
    "VOLATILE": {
        # Elevated ATR but no clean sweep. Prefer trend continuation; allow
        # stricter mean reversion only when tape is not screaming.
        "z_threshold":        1.75,
        "atr_multiplier_sl":  1.65,
        "ofi_bound":          0.20,
        "min_confidence":     0.65,
        "rr_target":          2.30,
        "be_lock_trigger":    2.0,
        "partial_take_r":     0.75,
        "partial_take_pct":   0.40,
        "time_exit_sec":      900,
        "time_exit_hard_cap_s": 1200,
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
        "rr_target":          2.5,
        "be_lock_trigger":    1.5,  # widened: move SL to BE only after 1.5×ATR profit
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      900,
        "time_exit_hard_cap_s": 1800,
        "panic_threshold":    10.0,  # FIX-R4: was 5.0 — unify with ATR panic gate at 0.90
        "candle_gate_sec":    45,
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
        "rr_target":          3.5,   # WIDER TP: squeeze snaps back violently
        "be_lock_trigger":    1.0,   # Lock BE faster — squeeze resolves in 3-8 candles
        "partial_take_r":     0.50,
        "partial_take_pct":   0.50,
        "time_exit_sec":      600,
        "time_exit_hard_cap_s": 1200,
        "panic_threshold":    5.0,   # Tighter panic — squeeze moves fast
        "candle_gate_sec":    30,
        "htf_block":          False,
        "cascade_cooldown_s": 120,   # 2min — squeeze can repeat rapidly
    },
    # C FIX: Orthogonal strategy risk profiles — CVD_FLIP and FUNDING_CONTRA
    # previously inherited the active regime's risk params (wrong causal link).
    "CVD_FLIP": {
        "z_threshold":        1.20,
        "atr_multiplier_sl":  1.40,   # Moderate SL — institutional reversals are usually real
        "ofi_bound":          0.12,
        "min_confidence":     0.55,   # Lower bar — CVD flip is a high-conviction structural signal
        "rr_target":          1.8,    # Moderate R:R — flips reverse fast, don't trend
        "be_lock_trigger":    1.0,
        "partial_take_r":     0.50,
        "partial_take_pct":   0.50,
        "time_exit_sec":      600,
        "time_exit_hard_cap_s": 1200,
        "panic_threshold":    10.0,
        "candle_gate_sec":    60,
        "htf_block":          False,
        "cascade_cooldown_s": 120,
    },
    "FUNDING_CONTRA": {
        "z_threshold":        1.50,
        "atr_multiplier_sl":  1.60,   # Wide SL — funding-driven reversals can overshoot
        "ofi_bound":          0.12,
        "min_confidence":     0.60,   # Moderate — funding is a slow signal
        "rr_target":          2.2,    # Good R:R — funding reversals have structural edge
        "be_lock_trigger":    1.5,
        "partial_take_r":     0.60,
        "partial_take_pct":   0.50,
        "time_exit_sec":      900,
        "time_exit_hard_cap_s": 1800,
        "panic_threshold":    10.0,
        "candle_gate_sec":    120,   # Longer — funding changes slowly
        "htf_block":          False,
        "cascade_cooldown_s": 180,
    },
}

# F-02 FIX: REGIME_ALIAS maps HMM state names that don't have their own
# REGIME_PARAMS entry to an existing entry. COMPRESSION and SQUEEZE now have
# their own entries so aliasing is no longer needed.
REGIME_ALIAS = {
}
