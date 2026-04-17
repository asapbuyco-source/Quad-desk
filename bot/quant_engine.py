can import time
import logging
import math
import numpy as np
import pandas as pd
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
        # Beta prior parameters — updated via update_win_rate() after each trade exit.
        # Alpha = wins+1, Beta = losses+1  →  mean = α/(α+β) = 0.5 at startup (uniform prior)
        self._alpha: float = 1.0   # pseudo-successes (bull wins)
        self._beta:  float = 1.0   # pseudo-failures  (bull losses)

    # ------------------------------------------------------------------
    # Public: update win-rate tracker after each trade
    # ------------------------------------------------------------------
    def update_win_rate(self, side: str, won: bool):
        """
        Call after each trade exit.
        side  = 'buy' | 'sell'
        won   = True if trade closed at TP, False if closed at SL
        """
        bull_win  = (side == "buy"  and won)
        bull_loss = (side == "buy"  and not won)
        bear_win  = (side == "sell" and won)
        bear_loss = (side == "sell" and not won)

        # For bull prior: track bull_wins vs bear_wins (direction-agnostic accuracy)
        if bull_win or bear_win:
            self._alpha += 1.0
        else:
            self._beta  += 1.0

        p_bull = self._alpha / (self._alpha + self._beta)
        n = self._alpha + self._beta - 2          # subtract the two pseudo-counts
        logger.info(
            f"[QuantEngine] Win-rate prior updated: α={self._alpha:.0f} β={self._beta:.0f} "
            f"→ P(bull)={p_bull:.2%}  (n={n:.0f} trades)"
        )

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
        rsi            = self._rsi(closes)
        tape_speed, dominant_side = self._tape_metrics()
        ofi, wall_context, all_walls_str = self._lob_metrics(current_price)
        bayesian_posterior = self._bayesian(rsi, z_score, skewness, ofi)
        cvd = self.state.cvd
        atr = self._atr(highs, lows, closes)
        vpoc = self._volume_poc(c_list)
        funding_rate = getattr(self.state, 'funding_rate', 0.0)

        return {
            "symbol":            self.state.symbol,
            "price":             current_price,
            "skewness":          skewness,
            "bayesianPosterior": bayesian_posterior,
            "zScore":            z_score,
            "rsi":               rsi,
            "ofi":               ofi,
            "cvd":               cvd,
            "tapeSpeed":         tape_speed,
            "tapeDominant":      dominant_side,
            "wallContext":       wall_context,
            "allWalls":          all_walls_str,
            "atr":               atr,
            "atr_pct":           atr / current_price if current_price > 0 else 0.0,
            "vpoc":              vpoc,
            "funding_rate":      funding_rate,
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
    # 3. RSI (14 period)
    # ------------------------------------------------------------------
    def _rsi(self, closes: np.ndarray) -> float:
        if len(closes) < 15:
            return 50.0
        delta  = np.diff(closes)
        gains  = np.where(delta > 0, delta, 0.0)
        losses = np.where(delta < 0, -delta, 0.0)

        g_sma = np.mean(gains[-14:])
        l_sma = np.mean(losses[-14:])

        if l_sma == 0 and g_sma > 0:  return 100.0
        if l_sma == 0 and g_sma == 0: return 50.0

        rs = g_sma / l_sma
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

        MAX_DIST   = 0.005
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

        return ofi, wall_context, "; ".join(wall_parts)

    # ------------------------------------------------------------------
    # 6. Bayesian Posterior P(Bull | Evidence) — Beta conjugate prior
    # ------------------------------------------------------------------
    def _bayesian(self, rsi: float, z_score: float, skewness: float, ofi: float) -> float:
        """
        Beta(α,β) conjugate prior — self-calibrates to historical win rate.

        The Beta prior mean  P_bull_prior = α / (α + β)  replaces the implicit
        50/50 prior of the old version.  After N trades the prior converges to
        the actual observed win-rate, making the posterior more accurate.

        Likelihood ratios (L_*) are unchanged — they modulate the prior
        using Naïve Bayes odds update.
        """
        # ── Step 1: Beta prior ───────────────────────────────────────────
        p_prior = self._alpha / (self._alpha + self._beta)  # E[Beta(α,β)]
        prior_odds = p_prior / (1.0 - p_prior)

        # ── Step 2: RSI likelihood ───────────────────────────────────────
        L_rsi = 1.8 if rsi > 60 else 0.55 if rsi < 40 else 1.0

        # ── Step 3: OFI + Z-Score (correlated — apply combined gate) ─────
        if z_score < -1.5 and ofi > 5:
            L_flow = 2.0   # Corroborated oversold + buying flow
        elif z_score > 1.5 and ofi < -5:
            L_flow = 0.5   # Corroborated overbought + selling flow
        else:
            L_z    = 1.3 if z_score < -1.5 else 0.76 if z_score > 1.5 else 1.0
            L_o    = 1.2 if ofi > 10       else 0.83 if ofi < -10      else 1.0
            L_flow = L_z * L_o

        # ── Step 4: Skewness likelihood ──────────────────────────────────
        L_skew = 1.2 if skewness > 0.3 else 0.83 if skewness < -0.3 else 1.0

        # ── Step 5: Update odds with likelihoods ─────────────────────────
        posterior_odds = prior_odds * L_rsi * L_flow * L_skew

        # ── Step 6: Convert back to probability ──────────────────────────
        p_bull = posterior_odds / (1.0 + posterior_odds)

        logger.debug(
            f"[QuantEngine] Bayesian — prior={p_prior:.2%} "
            f"L_rsi={L_rsi:.2f} L_flow={L_flow:.2f} L_skew={L_skew:.2f} "
            f"→ posterior={p_bull:.2%}"
        )
        return float(p_bull)

    # ------------------------------------------------------------------
    # 7. ATR — Average True Range (14 periods)
    # ------------------------------------------------------------------
    def _atr(self, highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
        """Wilder ATR over `period` bars using numpy directly."""
        if len(closes) < period + 1:
            return 0.0

        h = highs[-(period + 1):]
        l = lows[-(period + 1):]
        c = closes[-(period + 1):]
        prev_c = c[:-1]

        tr1 = h[1:] - l[1:]
        tr2 = np.abs(h[1:] - prev_c)
        tr3 = np.abs(l[1:] - prev_c)

        tr = np.maximum(tr1, np.maximum(tr2, tr3))
        return float(np.mean(tr))

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
