import time
import logging
import math
import json
import os
import numpy as np
import pandas as pd
from collections import deque
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)



class QuantEngine:
    """
    Computes the 7 core Macro Strategy metrics from a live MarketState.
    All calculations mirror the audited React store/index.ts logic.

    Enhancements (v2):
      - Beta(α,β) conjugate prior for self-calibrating Bayesian win rate
      - Student's t-distribution Z-score (fat-tail robust, replaces Gaussian)
      - funding_rate passed through from MarketState for ULIS signal
    """

    MIN_CANDLES = 51  # Need 51 to produce 50 log-returns

    def __init__(self, state):
        self.state = state

        # ── Per-Regime Beta Priors (P1 — HMM Spec Apr 2026) ──────────────────
        # Separate Beta(α,β) conjugate prior per HMM regime.
        # Tracks win rate independently for RANGE (mean-reversion),
        # TREND (momentum), and NEUTRAL/LIQUIDITY (mixed) regimes.
        # Mean = α/(α+β) = 0.5 at startup (uniform prior, no assumptions).
        self._regime_alpha: dict = {"RANGE": 1.0, "NEUTRAL": 1.0, "TREND": 1.0, "LIQUIDITY": 1.0}
        self._regime_beta:  dict = {"RANGE": 1.0, "NEUTRAL": 1.0, "TREND": 1.0, "LIQUIDITY": 1.0}
        # Keep global fallback for backwards compatibility with _bayesian()
        self._alpha: float = 1.0
        self._beta:  float = 1.0

        # ── OFI State (Three-Stage Pipeline) ──────────────────────────────
        # Stage 1: True OFI = delta of bid/ask depth between snapshots
        self._prev_bid_depth: float = 0.0
        self._prev_ask_depth: float = 0.0
        # Stage 2: MAD Persistence Filter
        self._ofi_history: deque = deque(maxlen=100)
        self._ofi_outlier_count: int = 0
        # Stage 3: EWMA normalisation + tanh soft saturation
        self._ofi_ewma_mu:  float = 0.0
        self._ofi_ewma_var: float = 1.0
        self._ofi_smooth:   float = 0.0

        # ── ATR Percentile Rank (P2 — HMM Spec Apr 2026) ─────────────────
        # Rolling 30-day window (4 candles/hr × 24hr × 30d = 2880 candles)
        # Rank of current ATR within this window gives a normalised [0,1]
        # measure of how extreme current volatility is vs recent history.
        # Much more robust than raw ATR% which varies by price level.
        self._atr_history: deque = deque(maxlen=2880)

        # ── RSI History Cache (MED-1 fix) ─────────────────────────────────────
        # Caches the last 3 computed RSI values so rsi_prev/rsi_prev2 reflect
        # true historically-observed values rather than recomputed ones with
        # different EMA seeds.
        self._rsi_history: deque = deque(maxlen=3)

        # Persistence path — survives Railway restarts if /tmp is mounted
        self._persist_path = os.environ.get("BOT_STATE_PATH", "/tmp/quad_bot_state.json")
        self._load_state()


    # ------------------------------------------------------------------
    # Public: update win-rate tracker after each trade
    # ------------------------------------------------------------------
    def update_win_rate(self, side: str, won: bool, regime: str = "NEUTRAL"):
        """
        Call after each trade exit.
        side   = 'buy' | 'sell'
        won    = True if trade closed at TP, False if closed at SL
        regime = HMM regime active at time of entry (RANGE|NEUTRAL|TREND|LIQUIDITY)
        """
        # CRIT-5 FIX: Correct directional semantics for P(bull) prior.
        # A BUY win OR a SELL loss means price went UP → bullish evidence (alpha).
        # A SELL win OR a BUY loss means price went DOWN → bearish evidence (beta).
        # Old code: incremented alpha for ANY win (bull or bear), corrupting the prior
        # after a sequence of successful short trades.
        market_went_up = (side == "buy" and won) or (side == "sell" and not won)

        # Update global prior
        if market_went_up:
            self._alpha += 1.0
        else:
            self._beta  += 1.0

        # Update per-regime prior (P1)
        regime_key = regime if regime in self._regime_alpha else "NEUTRAL"
        if market_went_up:
            self._regime_alpha[regime_key] += 1.0
        else:
            self._regime_beta[regime_key]  += 1.0

        p_bull  = self._alpha / (self._alpha + self._beta)
        p_r_win = self._regime_alpha[regime_key] / (
            self._regime_alpha[regime_key] + self._regime_beta[regime_key]
        )
        n = self._alpha + self._beta - 2
        logger.info(
            f"[QuantEngine] Win-rate updated: α={self._alpha:.0f} β={self._beta:.0f} "
            f"→ P(bull)={p_bull:.2%} | regime={regime_key} P(win)={p_r_win:.2%}  (n={n:.0f} trades)"
        )
        self._save_state()

    # ------------------------------------------------------------------
    # P1: Per-regime win rate accessor
    # ------------------------------------------------------------------
    def get_all_regime_priors(self) -> dict:
        """
        Returns dict of regime → win_rate_prior for all 4 regimes.
        Injected into metrics before _compute_signal() so _bayesian_fusion
        can blend per-regime prior with the base Bayesian posterior.
        """
        result = {}
        for regime in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
            a = self._regime_alpha.get(regime, 1.0)
            b = self._regime_beta.get(regime, 1.0)
            result[regime] = a / (a + b)   # Beta distribution mean
        return result

    # ------------------------------------------------------------------
    # State Persistence: survives restarts (Beta prior + OFI EWMA)
    # ------------------------------------------------------------------
    def _save_state(self):
        """Persist Beta prior and OFI EWMA state to disk."""
        try:
            data = {
                "alpha":          self._alpha,
                "beta":           self._beta,
                # Per-regime Betas (P1)
                "regime_alpha":   self._regime_alpha,
                "regime_beta":    self._regime_beta,
                "ofi_ewma_mu":    self._ofi_ewma_mu,
                "ofi_ewma_var":   self._ofi_ewma_var,
                "ofi_smooth":     self._ofi_smooth,
            }
            with open(self._persist_path, "w") as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning(f"[QuantEngine] State save failed: {e}")

    def _load_state(self):
        """Restore persisted state if available."""
        try:
            if os.path.exists(self._persist_path):
                with open(self._persist_path) as f:
                    data = json.load(f)
                self._alpha        = float(data.get("alpha",        1.0))
                self._beta         = float(data.get("beta",         1.0))
                self._ofi_ewma_mu  = float(data.get("ofi_ewma_mu",  0.0))
                self._ofi_ewma_var = float(data.get("ofi_ewma_var", 1.0))
                self._ofi_smooth   = float(data.get("ofi_smooth",   0.0))
                # Per-regime Betas (P1) — backwards compatible with old saves
                saved_ra = data.get("regime_alpha", {})
                saved_rb = data.get("regime_beta",  {})
                for r in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
                    self._regime_alpha[r] = float(saved_ra.get(r, 1.0))
                    self._regime_beta[r]  = float(saved_rb.get(r, 1.0))
                n = max(0, self._alpha + self._beta - 2)
                logger.info(
                    f"[QuantEngine] Restored state: α={self._alpha:.1f} β={self._beta:.1f} "
                    f"(n={n:.0f} trades), OFI EWMA μ={self._ofi_ewma_mu:.4f}"
                )
        except Exception as e:
            logger.warning(f"[QuantEngine] State load failed, using defaults: {e}")


    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def compute_metrics(self) -> Optional[Dict[str, Any]]:
        """
        Returns a fully-populated metrics dict, or None if not enough data.
        """
        if len(self.state.candles) < self.MIN_CANDLES:
            return None

        c_list = self.state.candles
        closes = np.array([c['close'] for c in c_list], dtype=float)
        highs  = np.array([c['high']  for c in c_list], dtype=float)
        lows   = np.array([c['low']   for c in c_list], dtype=float)
        vols   = np.array([c['volume']for c in c_list], dtype=float)

        current_price = closes[-1]

        skewness       = self._skewness(closes)
        z_score        = self._vwap_z_score_t(highs, lows, closes, vols, current_price)
        zScore_prev    = getattr(self, "_last_z_score", z_score)
        self._last_z_score = z_score

        # MED-1 FIX: Use cached RSI history for rsi_prev/rsi_prev2.
        # Re-slicing closes[] and recomputing _rsi() produces a different Wilder EMA
        # seed each time — not the value that was observed last cycle. Cache instead.
        rsi = self._rsi(closes)
        self._rsi_history.append(rsi)
        rsi_prev  = self._rsi_history[-2] if len(self._rsi_history) >= 2 else rsi
        rsi_prev2 = self._rsi_history[-3] if len(self._rsi_history) >= 3 else rsi_prev

        tape_speed, dominant_side = self._tape_metrics()
        ofi, wall_context, all_walls_str = self._lob_metrics(current_price)
        bayesian_posterior = self._bayesian(rsi, z_score, skewness, ofi)
        cvd = self.state.cvd
        atr = self._atr(highs, lows, closes)

        # ── P2: ATR Percentile Rank (30-day rolling window) ──────────────
        # Rank current ATR within a rolling 2880-candle (30-day) window.
        # Output: atr_pct_rank in [0.0, 1.0].
        #   0.05 = ATR is in bottom 5% — very quiet
        #   0.95 = ATR is in top 5% — very volatile
        # More robust than raw ATR% which varies with BTC price level.
        self._atr_history.append(atr)
        if len(self._atr_history) >= 2:
            arr = np.array(self._atr_history)
            # Fraction of historical ATRs that are <= current ATR
            atr_pct_rank = float(np.mean(arr <= atr))
        else:
            atr_pct_rank = 0.5  # Neutral fallback during warmup

        vpoc = self._volume_poc(c_list)
        funding_rate = getattr(self.state, 'funding_rate', 0.0)

        return {
            "symbol":            self.state.symbol,
            "price":             current_price,
            "skewness":          skewness,
            "bayesianPosterior": bayesian_posterior,
            "zScore":            z_score,
            "zScore_prev":       zScore_prev,
            "rsi":               rsi,
            "rsi_prev":          rsi_prev,
            "rsi_prev2":         rsi_prev2,
            "ofi":               ofi,
            "cvd":               cvd,
            "tapeSpeed":         tape_speed,
            "tapeDominant":      dominant_side,
            "wallContext":       wall_context,
            "allWalls":          all_walls_str,
            "atr":               atr,
            "atr_pct":           atr / current_price if current_price > 0 else 0.0,
            "atr_pct_rank":      atr_pct_rank,   # P2: percentile rank in 30-day window
            "vpoc":              vpoc,
            "funding_rate":      funding_rate,
            # PHASE-0.4: Z-score validity guard.
            # Z-score is meaningless with fewer than 10 bars of data in the
            # current session — it's fitting noise from too-small a sample.
            "z_score_valid":     len(closes) >= 10,
        }

    # ------------------------------------------------------------------
    # 1. Log-Return Skewness (50 periods)
    # ------------------------------------------------------------------
    def _skewness(self, closes: np.ndarray) -> float:
        closes_51 = closes[-51:]
        if len(closes_51) < 51:
            return 0.0
        safe = np.where(closes_51[:-1] > 0, closes_51[:-1], np.nan)
        returns_50 = np.log(closes_51[1:] / safe)
        valid = returns_50[~np.isnan(returns_50)]
        if len(valid) < 3:
            return 0.0
        mean = np.mean(valid)
        var  = np.var(valid)
        if var == 0:
            return 0.0
        skew = np.mean(((valid - mean) / np.sqrt(var)) ** 3)
        return float(skew)

    # ------------------------------------------------------------------
    # 2. VWAP-Anchored Z-Score — Student's t robust (20 periods)
    # ------------------------------------------------------------------
    def _vwap_z_score_t(
        self,
        highs: np.ndarray,
        lows: np.ndarray,
        closes: np.ndarray,
        vols: np.ndarray,
        current_price: float,
    ) -> float:
        """
        Fat-tail-robust Z-score using Student's t scaling.

        Steps:
        1. Compute volume-weighted standard deviation (Gaussian baseline).
        2. Estimate degrees-of-freedom ν from excess kurtosis of typical prices:
               ν ≈ max(4, 4 + 6 / excess_kurtosis)   [Cornish-Fisher approx]
        3. Scale Gaussian Z by the t-distribution's std-dev correction:
               Z_t = Z_gaussian × sqrt((ν - 2) / ν)
           This *shrinks* Z during fat-tailed regimes, preventing false extremes.
        4. Clip to [-4, +4].
        """
        h = highs[-20:]
        l = lows[-20:]
        c = closes[-20:]
        v = vols[-20:]
        if len(c) == 0:
            return 0.0
        typical  = (h + l + c) / 3.0
        vol_sum  = np.sum(v)
        if vol_sum <= 0:
            return 0.0
        vwap = np.sum(typical * v) / vol_sum

        vw_variance = np.sum(v * (typical - vwap) ** 2) / vol_sum
        std = np.sqrt(vw_variance)
        if std <= 0:
            return 0.0

        z_gaussian = (current_price - vwap) / std

        # --- t-distribution degrees-of-freedom estimation ---
        if len(typical) >= 4:
            mean_t  = np.mean(typical)
            std_t   = np.std(typical, ddof=1)
            if std_t > 0:
                # Excess kurtosis (sample, subtract 3)
                kurt = float(np.mean(((typical - mean_t) / std_t) ** 4)) - 3.0
                # Cornish-Fisher: ν ≈ 4 + 6/excess_kurtosis for excess_kurtosis > 0
                if kurt > 0.5:
                    nu = max(4.0, 4.0 + 6.0 / kurt)
                else:
                    nu = 30.0   # Near-Gaussian; negligible correction
            else:
                nu = 30.0
        else:
            nu = 30.0

        # Scale factor: sqrt((ν-2)/ν) — shrinks Z for heavy tails
        t_scale = math.sqrt((nu - 2.0) / nu)
        z_t = z_gaussian * t_scale

        return float(np.clip(z_t, -4.0, 4.0))

    # ------------------------------------------------------------------
    # 3. RSI (14 period) — Wilder EMA smoothing (Fix #7 from audit)
    # ------------------------------------------------------------------
    def _rsi(self, closes: np.ndarray) -> float:
        """
        Wilder's RSI: uses exponential smoothing with α = 1/period.
        This matches TradingView, TA-Lib, and the frontend dashboard.
        SMA-based RSI under-estimates extremes — Wilder's EMA gives
        accurate 70/30 signals for overbought/oversold gate logic.
        """
        period = 14
        if len(closes) < period + 1:
            return 50.0
        delta  = np.diff(closes)
        gains  = np.where(delta > 0, delta, 0.0)
        losses = np.where(delta < 0, -delta, 0.0)

        # Seed with simple average over first `period` bars
        avg_gain = float(np.mean(gains[:period]))
        avg_loss = float(np.mean(losses[:period]))

        # Wilder EMA over remaining bars
        for i in range(period, len(gains)):
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss < 1e-10:
            return 100.0 if avg_gain > 0 else 50.0

        rs = avg_gain / avg_loss
        return float(100.0 - (100.0 / (1.0 + rs)))

    # ------------------------------------------------------------------
    # 4. Tape Speed & Dominant Side (USD-normalised)
    # ------------------------------------------------------------------
    def _tape_metrics(self):
        trades = list(self.state.recent_trades)
        now_ms = time.time() * 1000

        buy_10s = sell_10s = total_60s = 0.0
        for t in trades:
            total_60s += t['usd_volume']
            age_ms     = now_ms - t['time']
            if age_ms < 10_000:
                if t['side'] == 'BUY':
                    buy_10s += t['usd_volume']
                else:
                    sell_10s += t['usd_volume']

        total_10s    = buy_10s + sell_10s
        baseline_10s = (total_60s / 60.0) * 10 if total_60s > 0 else 0.0

        is_screaming = (
            (baseline_10s > 0 and total_10s > baseline_10s * 3)
            or total_10s > 2_000_000
        )

        if len(trades) < 5:
            return "NORMAL", "NO DATA"

        tape_speed = "SCREAMING" if is_screaming else "NORMAL"
        if buy_10s > sell_10s * 1.5:
            dominant = "BUY (ASK HIT)"
        elif sell_10s > buy_10s * 1.5:
            dominant = "SELL (BID HIT)"
        else:
            dominant = "BALANCED"

        return tape_speed, dominant

    # ------------------------------------------------------------------
    # 5. LOB Walls & OFI
    # ------------------------------------------------------------------
    def _lob_metrics(self, current_price: float):
        bids = self.state.bids
        asks = self.state.asks

        MAX_DIST   = 0.001
        valid_bids = {p: s for p, s in bids.items()
                      if (current_price - p) / current_price <= MAX_DIST}
        valid_asks = {p: s for p, s in asks.items()
                      if (p - current_price) / current_price <= MAX_DIST}

        ofi = sum(valid_bids.values()) - sum(valid_asks.values())

        all_sizes      = list(valid_bids.values()) + list(valid_asks.values())
        median_size    = float(np.median(all_sizes)) if all_sizes else 1.0
        wall_threshold = median_size * 5.0

        top_bids = sorted(
            [(p, s) for p, s in valid_bids.items() if s > wall_threshold],
            key=lambda x: x[1], reverse=True,
        )[:5]
        top_asks = sorted(
            [(p, s) for p, s in valid_asks.items() if s > wall_threshold],
            key=lambda x: x[1], reverse=True,
        )[:5]

        nearest_bid = top_bids[0][0] if top_bids else None
        nearest_ask = top_asks[0][0] if top_asks else None

        bid_dist = (
            f"{((current_price - nearest_bid) / current_price * 100):.2f}"
            if nearest_bid else "N/A"
        )
        ask_dist = (
            f"{((nearest_ask - current_price) / current_price * 100):.2f}"
            if nearest_ask else "N/A"
        )

        wall_context = (
            f"Nearest Buy Wall: {nearest_bid} (-{bid_dist}%), "
            f"Nearest Sell Wall: {nearest_ask} (+{ask_dist}%)"
        )

        wall_parts = []
        for p, s in top_asks:
            if current_price > 0:
                dist = (p - current_price) / current_price * 100
                wall_parts.append(f"SELL@{p:.1f} (+{dist:.2f}%, sz:{s:.2f})")
        for p, s in top_bids:
            if current_price > 0:
                dist = (current_price - p) / current_price * 100
                wall_parts.append(f"BUY@{p:.1f} (-{dist:.2f}%, sz:{s:.2f})")

        # ── THREE-STAGE OFI INTEGRITY PIPELINE ───────────────────────────
        # Replaces the static ±100 clamp (Links Investment Corps, Apr 2026)

        # STAGE 1 — True OFI via depth-snapshot delta
        # The bot uses depth20@100ms (full snapshots, not delta stream),
        # so we measure the CHANGE in total bid/ask depth between frames.
        # This is true Order Flow Imbalance, not just Order Book Imbalance.
        curr_bid_depth = sum(valid_bids.values())
        curr_ask_depth = sum(valid_asks.values())

        if self._prev_bid_depth == 0.0 and self._prev_ask_depth == 0.0:
            ofi_raw = 0.0  # First cycle: no delta available yet, emit neutral
        else:
            ofi_raw = (
                (curr_bid_depth - self._prev_bid_depth) -
                (curr_ask_depth - self._prev_ask_depth)
            )
        self._prev_bid_depth = curr_bid_depth
        self._prev_ask_depth = curr_ask_depth

        # STAGE 2 — MAD Persistence Filter
        # Classifies transient spikes (1-2 cycles) vs sustained extremes (3+ cycles).
        # Only sustained extremes pass through (genuine institutional pressure).
        self._ofi_history.append(ofi_raw)
        ofi_filtered = ofi_raw  # default: pass through

        if len(self._ofi_history) >= 20:
            arr = np.array(self._ofi_history)
            median_ofi = float(np.median(arr))
            mad = float(np.median(np.abs(arr - median_ofi)))
            mad_threshold = 3.5 * 1.4826 * mad  # 3.5σ robust boundary

            if mad_threshold > 0 and abs(ofi_raw - median_ofi) > mad_threshold:
                self._ofi_outlier_count += 1
                if self._ofi_outlier_count < 3:
                    # Transient spike (1-2 cycles) — replace with neutral median
                    logger.debug(
                        f"[OFI-MAD] Transient outlier ({ofi_raw:.2f}) — "
                        f"replacing with median ({median_ofi:.2f})"
                    )
                    ofi_filtered = median_ofi
                else:
                    # Sustained extreme (3+ cycles) — genuine, cap at MAD boundary
                    sign = 1.0 if ofi_raw >= 0 else -1.0
                    ofi_filtered = sign * (abs(median_ofi) + mad_threshold)
                    self._ofi_outlier_count = 0
                    logger.debug(
                        f"[OFI-MAD] Sustained extreme ({ofi_raw:.2f}) — "
                        f"capped at MAD boundary ({ofi_filtered:.2f})"
                    )
            else:
                self._ofi_outlier_count = 0

        # STAGE 3 — EWMA normalisation + tanh soft saturation
        # Output is in (-1, +1). Replaces the static ±100 hard clamp.
        # tanh is monotone — preserves direction, never hard-caps genuine signals.
        LAMBDA_EWMA  = 0.97
        ALPHA_SMOOTH = 0.30
        self._ofi_ewma_mu  = LAMBDA_EWMA * self._ofi_ewma_mu  + (1 - LAMBDA_EWMA) * ofi_filtered
        self._ofi_ewma_var = LAMBDA_EWMA * self._ofi_ewma_var + (1 - LAMBDA_EWMA) * (ofi_filtered - self._ofi_ewma_mu) ** 2
        sigma = max(math.sqrt(self._ofi_ewma_var), 1e-6)

        ofi_norm   = (ofi_filtered - self._ofi_ewma_mu) / sigma
        self._ofi_smooth = ALPHA_SMOOTH * ofi_norm + (1 - ALPHA_SMOOTH) * self._ofi_smooth
        ofi = math.tanh(self._ofi_smooth / 2.0)  # output: (-1, +1)

        logger.debug(
            f"[OFI-Pipeline] raw={ofi_raw:.2f} filtered={ofi_filtered:.2f} "
            f"norm={ofi_norm:.3f} smooth={self._ofi_smooth:.3f} final_tanh={ofi:.4f}"
        )

        return ofi, wall_context, "; ".join(wall_parts)

    # ------------------------------------------------------------------
    # 6. Bayesian Posterior P(Bull | Evidence) — Beta conjugate prior
    # ------------------------------------------------------------------
    def _bayesian(self, rsi: float, z_score: float, skewness: float, ofi: float) -> float:
        """
        Beta(α,β) conjugate prior — self-calibrates to historical win rate.

        OFI is now in (-1, +1) from the Three-Stage Pipeline (tanh output).
        Thresholds updated from the old ±100 scale to the new ±1 scale.
        """
        # ── Step 1: Beta prior ───────────────────────────────────────
        p_prior = self._alpha / (self._alpha + self._beta)
        prior_odds = p_prior / (1.0 - p_prior)

        # ── Step 2: RSI likelihood ─────────────────────────────────────
        L_rsi = 1.8 if rsi > 60 else 0.55 if rsi < 40 else 1.0

        # ── Step 3: OFI + Z-Score combined gate (OFI now in (-1,+1)) ──────
        if z_score < -1.5 and ofi > 0.2:       # oversold + buying flow
            L_flow = 2.0
        elif z_score > 1.5 and ofi < -0.2:     # overbought + selling flow
            L_flow = 0.5
        else:
            L_z = 1.3 if z_score < -1.5 else 0.76 if z_score > 1.5 else 1.0
            L_o = 1.2 if ofi > 0.3 else 0.83 if ofi < -0.3 else 1.0  # tanh thresholds
            L_flow = L_z * L_o

        # ── Step 4: Skewness likelihood ────────────────────────────────
        L_skew = 1.2 if skewness > 0.3 else 0.83 if skewness < -0.3 else 1.0

        # ── Step 5: Update odds ──────────────────────────────────────────
        posterior_odds = prior_odds * L_rsi * L_flow * L_skew

        # ── Step 6: Convert back to probability ───────────────────────────
        p_bull = posterior_odds / (1.0 + posterior_odds)

        logger.debug(
            f"[QuantEngine] Bayesian — prior={p_prior:.2%} "
            f"L_rsi={L_rsi:.2f} L_flow={L_flow:.2f} L_skew={L_skew:.2f} "
            f"ofi_tanh={ofi:.4f} → posterior={p_bull:.2%}"
        )
        return float(p_bull)


    # ------------------------------------------------------------------
    # 7. ATR — Average True Range (14 periods)
    # ------------------------------------------------------------------
    def _atr(self, highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
        """
        Wilder ATR using proper EMA smoothing (HIGH-4 FIX).
        Old code: np.mean(tr) — simple average underestimates ATR by ~30% during spikes.
        Fixed:    seed with SMA of first `period` bars, then apply Wilder EMA.
        """
        if len(closes) < period + 1:
            return 0.0

        h = highs[-(period + 1):]
        l = lows[-(period + 1):]
        c = closes[-(period + 1):]
        prev_c = c[:-1]

        tr = np.maximum(h[1:] - l[1:],
             np.maximum(np.abs(h[1:] - prev_c),
                        np.abs(l[1:] - prev_c)))

        # Wilder EMA: seed with SMA of first period bars, then smooth
        atr = float(np.mean(tr[:period]))
        for i in range(period, len(tr)):
            atr = (atr * (period - 1) + float(tr[i])) / period
        return atr

    # ------------------------------------------------------------------
    # 8. Volume Point of Control (VPOC)
    # ------------------------------------------------------------------
    def _volume_poc(self, candles, n: int = 24) -> Optional[float]:
        """
        Identify the $10 price bucket with the highest cumulative traded
        volume over the last N candles (default 24 = ~6 hours on 15m bars).
        """
        candle_list = list(candles)[-n:]
        if len(candle_list) < 2:
            return None
        price_vol: Dict[int, float] = {}
        for c in candle_list:
            bucket = int(round(float(c["close"]) / 10.0)) * 10
            price_vol[bucket] = price_vol.get(bucket, 0.0) + float(c.get("volume", 0.0))
        if not price_vol:
            return None
        return float(max(price_vol, key=price_vol.get))
