"""
bot/dynamic_z_engine.py
========================
Adaptive Dynamic Z Engine — Phase 1 implementation.

Implements Stages 5-7 of the "Adaptive Dynamic Z Engine" proposal
(z_score_update.txt) WITHOUT altering the existing bot architecture:

    Stage 5 — Dynamic Z Optimization   (bounded EV search over candidate Z)
    Stage 6 — Bayesian Online Learning (state updates after every closed trade)
    Stage 7 — Regime Memory            (per-regime optimal-Z distribution,
                                         mean / variance / confidence, not a
                                         single constant)

Deliberately OUT of scope for Phase 1 (see ALPHA_PROPOSITION.pdf, "Phase 2"):
    Stage 3 — Gradient-boosted P(success|X) / E(PnL|X) models
    Stage 4 — Isotonic / Platt probability calibration
    Stage 8 — Full Execution Confidence Index (model agreement, OOD distance)
    Stage 9 — Meta-learner

Those stages require a historical-trade feature warehouse and an offline
training/validation pipeline that does not yet exist for this bot. Building
them on top of a live account without that infrastructure would itself be
the kind of un-vetted change the audit has been trying to eliminate.
This module is intentionally scoped to what can be safely computed online,
from data the bot already produces, with hard bounds and a static fallback
so it can NEVER make the bot more fragile than the current fixed-threshold
system.

Design contract
----------------
- `get_threshold()` NEVER raises. Any internal failure logs a warning and
  returns the caller-supplied static default (the existing REGIME_PARAMS
  z_threshold). Live trading must not be able to break because of this
  module.
- The dynamic threshold is only trusted once a regime has accumulated
  >= COLD_START_TRADE_COUNT closed trades (same constant already used
  elsewhere in signal_config.py for Bayesian cold-start, kept consistent).
  Below that, the static prior is returned unchanged.
- Even once "warm", the dynamic value is blended with the static prior and
  clamped to +/- MAX_DEVIATION_PCT of the prior per recompute, so a bad
  streak of trades cannot swing the live threshold wildly in one step.
- State persists to bot/dynamic_z_state.json (same pattern as
  bot/hmm_params.json) so learning survives restarts.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

logger = logging.getLogger("bot.dynamic_z_engine")

# ── Config ─────────────────────────────────────────────────────────────────
# Kept import-safe (no hard dependency on signal_config) but mirrors its value.
try:
    from .signal_config import COLD_START_TRADE_COUNT as _COLD_START_TRADE_COUNT
except Exception:
    _COLD_START_TRADE_COUNT = 30

DYNAMIC_Z_ENABLED          = True     # master kill-switch — set False to fall back to static REGIME_PARAMS
MIN_SAMPLES_PER_REGIME     = _COLD_START_TRADE_COUNT   # trades before dynamic value is trusted at all
MIN_SAMPLES_PER_CANDIDATE  = 8        # a candidate Z needs this many qualifying trades to be scored
MAX_HISTORY_PER_REGIME     = 300      # rolling window — bounds memory + adapts to regime drift
RECOMPUTE_EVERY_N_TRADES   = 3        # recompute optimal-Z every N new outcomes (not every single one)
MAX_DEVIATION_PCT          = 0.25     # dynamic value can move at most +/-25% from static prior per recompute
BLEND_WARMUP_TRADES        = 150      # sample count at which dynamic weight reaches ~1.0
CANDIDATE_Z_MIN            = 0.30
CANDIDATE_Z_MAX            = 2.00
CANDIDATE_Z_STEP           = 0.05
RISK_AVERSION_LAMBDA       = 0.35     # utility = mean_pnl - lambda * stderr(pnl)

_STATE_PATH = os.path.join(os.path.dirname(__file__), "dynamic_z_state.json")

_CANDIDATES = [
    round(CANDIDATE_Z_MIN + i * CANDIDATE_Z_STEP, 2)
    for i in range(int(round((CANDIDATE_Z_MAX - CANDIDATE_Z_MIN) / CANDIDATE_Z_STEP)) + 1)
]


class _RegimeMemory:
    """Stage 7 — Regime Memory: optimal-Z distribution, not a single constant."""

    __slots__ = ("trades", "optimal_z_mean", "optimal_z_var", "n_recomputes",
                 "n_since_recompute", "last_updated_ts")

    def __init__(self):
        self.trades: Deque[Tuple[float, float]] = deque(maxlen=MAX_HISTORY_PER_REGIME)  # (abs_z_entry, pnl)
        self.optimal_z_mean: Optional[float] = None
        self.optimal_z_var: float = 0.0
        self.n_recomputes: int = 0
        self.n_since_recompute: int = 0
        self.last_updated_ts: float = 0.0

    def to_dict(self) -> dict:
        return {
            "trades":            list(self.trades),
            "optimal_z_mean":    self.optimal_z_mean,
            "optimal_z_var":     self.optimal_z_var,
            "n_recomputes":      self.n_recomputes,
            "n_since_recompute": self.n_since_recompute,
            "last_updated_ts":   self.last_updated_ts,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "_RegimeMemory":
        m = cls()
        for pair in d.get("trades", []):
            try:
                m.trades.append((float(pair[0]), float(pair[1])))
            except Exception:
                continue
        m.optimal_z_mean = d.get("optimal_z_mean")
        m.optimal_z_var = float(d.get("optimal_z_var", 0.0) or 0.0)
        m.n_recomputes = int(d.get("n_recomputes", 0) or 0)
        m.n_since_recompute = int(d.get("n_since_recompute", 0) or 0)
        m.last_updated_ts = float(d.get("last_updated_ts", 0.0) or 0.0)
        return m


class DynamicZEngine:
    """
    Online per-regime adaptive Z-threshold optimizer.

    Usage (see main.py integration):
        z_thr = dynamic_z_engine.get_threshold(regime, static_default=regime_p["z_threshold"])
        ...
        dynamic_z_engine.record_outcome(regime, z_entry=metrics["zScore"], pnl=pnl, won=is_win)
    """

    def __init__(self, state_path: str = _STATE_PATH):
        self._state_path = state_path
        self._regimes: Dict[str, _RegimeMemory] = {}
        self._load()

    # ── Persistence ──────────────────────────────────────────────────────
    def _load(self) -> None:
        if not os.path.exists(self._state_path):
            return
        try:
            with open(self._state_path, "r") as f:
                raw = json.load(f)
            for regime, d in raw.get("regimes", {}).items():
                self._regimes[regime] = _RegimeMemory.from_dict(d)
            logger.info(f"[DynamicZ] Loaded state for {len(self._regimes)} regime(s) from {self._state_path}")
        except Exception as e:
            logger.warning(f"[DynamicZ] Failed to load state ({e}); starting fresh.")
            self._regimes = {}

    def _save(self) -> None:
        try:
            out = {
                "regimes":     {r: m.to_dict() for r, m in self._regimes.items()},
                "saved_ts":    time.time(),
                "candidates":  _CANDIDATES,
            }
            tmp_path = self._state_path + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(out, f, indent=2)
            os.replace(tmp_path, self._state_path)
        except Exception as e:
            logger.warning(f"[DynamicZ] Failed to persist state: {e}")

    # ── Stage 5: Dynamic Z Optimization ─────────────────────────────────
    def _score_candidates(self, mem: _RegimeMemory) -> Optional[float]:
        """
        Bounded EV search: for each candidate Z in [CANDIDATE_Z_MIN, CANDIDATE_Z_MAX],
        evaluate the historical trades that WOULD have fired at that threshold
        (abs_z_entry >= candidate), and score by mean-PnL minus a variance
        penalty (simple mean-variance utility, not a black box).
        Returns the argmax candidate, or None if nothing qualifies.
        """
        trades = list(mem.trades)
        if len(trades) < MIN_SAMPLES_PER_REGIME:
            return None

        best_z, best_utility = None, float("-inf")
        for cand in _CANDIDATES:
            qualifying = [pnl for (z, pnl) in trades if z >= cand]
            n = len(qualifying)
            if n < MIN_SAMPLES_PER_CANDIDATE:
                continue
            mean_pnl = sum(qualifying) / n
            if n > 1:
                var = sum((p - mean_pnl) ** 2 for p in qualifying) / (n - 1)
                stderr = (var ** 0.5) / (n ** 0.5)
            else:
                stderr = 0.0
            utility = mean_pnl - RISK_AVERSION_LAMBDA * stderr
            if utility > best_utility:
                best_utility, best_z = utility, cand

        return best_z

    # ── Stage 6: Bayesian Online Learning ───────────────────────────────
    def record_outcome(self, regime: str, z_entry: float, pnl: float, won: bool = None) -> None:
        """Call once per CLOSED trade (from _process_exit). Never raises."""
        if not DYNAMIC_Z_ENABLED:
            return
        try:
            regime = regime or "NEUTRAL"
            mem = self._regimes.setdefault(regime, _RegimeMemory())
            mem.trades.append((abs(float(z_entry)), float(pnl)))
            mem.n_since_recompute += 1
            mem.last_updated_ts = time.time()

            if mem.n_since_recompute >= RECOMPUTE_EVERY_N_TRADES:
                mem.n_since_recompute = 0
                new_z = self._score_candidates(mem)
                if new_z is not None:
                    # Stage 7: update running optimal-Z distribution (mean/variance),
                    # not just overwrite a constant.
                    if mem.optimal_z_mean is None:
                        mem.optimal_z_mean = new_z
                        mem.optimal_z_var = 0.0
                    else:
                        alpha = 0.20  # EWMA smoothing — regime memory adapts gradually
                        delta = new_z - mem.optimal_z_mean
                        mem.optimal_z_mean += alpha * delta
                        mem.optimal_z_var = (1 - alpha) * (mem.optimal_z_var + alpha * delta ** 2)
                    mem.n_recomputes += 1
                    logger.info(
                        f"[DynamicZ] Recomputed {regime}: optimal_z={mem.optimal_z_mean:.3f} "
                        f"(sigma={mem.optimal_z_var ** 0.5:.3f}, n_trades={len(mem.trades)}, "
                        f"recompute #{mem.n_recomputes})"
                    )
            self._save()
        except Exception as e:
            logger.warning(f"[DynamicZ] record_outcome failed (non-fatal, ignored): {e}")

    # ── Query (used by main.py in place of static regime_p["z_threshold"]) ─
    def get_threshold(self, regime: str, static_default: float) -> float:
        """
        Returns the effective Z-threshold for `regime`.
        Falls back to `static_default` (the existing REGIME_PARAMS value)
        whenever the engine is disabled, cold, or errors out — this function
        must never be the reason a live trade is mis-priced or the bot crashes.
        """
        if not DYNAMIC_Z_ENABLED:
            return static_default
        try:
            mem = self._regimes.get(regime)
            if mem is None or mem.optimal_z_mean is None or len(mem.trades) < MIN_SAMPLES_PER_REGIME:
                return static_default

            # Blend weight ramps from 0 -> 1 as sample count grows past cold-start,
            # so the transition from static to learned is gradual, not a step function.
            n = len(mem.trades)
            weight = min(1.0, (n - MIN_SAMPLES_PER_REGIME) / float(BLEND_WARMUP_TRADES))
            blended = (1 - weight) * static_default + weight * mem.optimal_z_mean

            # Hard safety rail: never let the dynamic value drift more than
            # MAX_DEVIATION_PCT away from the static, human-reviewed prior.
            lo = static_default * (1 - MAX_DEVIATION_PCT)
            hi = static_default * (1 + MAX_DEVIATION_PCT)
            clamped = max(lo, min(hi, blended))
            clamped = max(CANDIDATE_Z_MIN, min(CANDIDATE_Z_MAX, clamped))
            return round(clamped, 3)
        except Exception as e:
            logger.warning(f"[DynamicZ] get_threshold failed for regime={regime} (non-fatal): {e}")
            return static_default

    # ── Introspection / ECI-lite (Stage 8 precursor — logging only in Phase 1) ─
    def get_confidence(self, regime: str) -> dict:
        """Lightweight confidence readout for logging/dashboards. Not used to gate execution in Phase 1."""
        mem = self._regimes.get(regime)
        if mem is None:
            return {"regime": regime, "n_trades": 0, "warm": False}
        n = len(mem.trades)
        return {
            "regime":         regime,
            "n_trades":       n,
            "warm":           n >= MIN_SAMPLES_PER_REGIME,
            "optimal_z_mean": mem.optimal_z_mean,
            "optimal_z_std":  (mem.optimal_z_var ** 0.5) if mem.optimal_z_var else 0.0,
            "n_recomputes":   mem.n_recomputes,
        }


# ── Module-level singleton (matches the rest of the bot's style — e.g. quant, executor) ─
dynamic_z_engine = DynamicZEngine()
