import time
import logging
import numpy as np
import pandas as pd
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


class QuantEngine:
    """
    Computes the 7 core Macro Strategy metrics from a live MarketState.
    All calculations mirror the audited React store/index.ts logic.
    """

    MIN_CANDLES = 51  # Need 51 to produce 50 log-returns

    def __init__(self, state):
        self.state = state

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def compute_metrics(self) -> Optional[Dict[str, Any]]:
        """
        Returns a fully-populated metrics dict, or None if not enough data.
        """
        if len(self.state.candles) < self.MIN_CANDLES:
            return None

        df = pd.DataFrame(self.state.candles)
        current_price = float(df['close'].iloc[-1])

        skewness       = self._skewness(df)
        z_score        = self._vwap_z_score(df, current_price)
        rsi            = self._rsi(df)
        tape_speed, dominant_side = self._tape_metrics()
        ofi, wall_context, all_walls_str = self._lob_metrics(current_price)
        bayesian_posterior = self._bayesian(rsi, ofi, z_score, skewness)
        cvd = self.state.cvd

        return {
            "symbol": self.state.symbol,
            "price": current_price,
            "skewness": skewness,
            "bayesianPosterior": bayesian_posterior,
            "zScore": z_score,
            "rsi": rsi,
            "ofi": ofi,
            "cvd": cvd,
            "tapeSpeed": tape_speed,
            "tapeDominant": dominant_side,
            "wallContext": wall_context,
            "allWalls": all_walls_str,
        }

    # ------------------------------------------------------------------
    # 1. Log-Return Skewness (50 periods)
    # ------------------------------------------------------------------
    def _skewness(self, df: pd.DataFrame) -> float:
        closes_51 = df['close'].tail(51).values
        if len(closes_51) < 51:
            return 0.0
        # Guard against zero prices before log
        safe = np.where(closes_51[:-1] > 0, closes_51[:-1], np.nan)
        returns_50 = np.log(closes_51[1:] / safe)
        valid = returns_50[~np.isnan(returns_50)]
        if len(valid) < 3:
            return 0.0
        return float(pd.Series(valid).skew())

    # ------------------------------------------------------------------
    # 2. VWAP-Anchored Z-Score (20 periods)
    # ------------------------------------------------------------------
    def _vwap_z_score(self, df: pd.DataFrame, current_price: float) -> float:
        recent = df.tail(20).copy()
        recent['typical'] = (recent['high'] + recent['low'] + recent['close']) / 3
        vol_sum = recent['volume'].sum()
        if vol_sum <= 0:
            return 0.0
        vwap = (recent['typical'] * recent['volume']).sum() / vol_sum
        std = float(recent['typical'].std(ddof=0))
        if std <= 0:
            return 0.0
        return float((current_price - vwap) / std)

    # ------------------------------------------------------------------
    # 3. RSI (14 period) — handles zero-loss edge case
    # ------------------------------------------------------------------
    def _rsi(self, df: pd.DataFrame) -> float:
        delta = df['close'].diff()
        gain = delta.where(delta > 0, 0.0).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0.0)).rolling(window=14).mean()

        rsi_series = pd.Series(index=df.index, dtype=float)
        # When loss == 0, RSI = 100 (pure uptrend); avoid divide-by-zero
        valid_loss = loss != 0
        rsi_series[valid_loss] = 100 - (100 / (1 + gain[valid_loss] / loss[valid_loss]))
        rsi_series[~valid_loss & (gain > 0)] = 100.0
        rsi_series[~valid_loss & (gain == 0)] = 50.0

        last = rsi_series.iloc[-1]
        return float(last) if not pd.isna(last) else 50.0

    # ------------------------------------------------------------------
    # 4. Tape Speed & Dominant Side (USD-normalised)
    # ------------------------------------------------------------------
    def _tape_metrics(self):
        trades = list(self.state.recent_trades)
        now_ms = time.time() * 1000

        buy_10s = sell_10s = total_60s = 0.0
        for t in trades:
            total_60s += t['usd_volume']
            age_ms = now_ms - t['time']
            if age_ms < 10_000:
                if t['side'] == 'BUY':
                    buy_10s += t['usd_volume']
                else:
                    sell_10s += t['usd_volume']

        total_10s = buy_10s + sell_10s
        baseline_10s = (total_60s / 60.0) * 10 if total_60s > 0 else 0.0

        # "Screaming": 3× the expected rate OR absolute $2M/10s
        is_screaming = (baseline_10s > 0 and total_10s > baseline_10s * 3) or total_10s > 2_000_000

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

        # Filter orders too far from spread (mitigates deep spoofing)
        MAX_DIST = 0.005  # 0.5% (tighter range)
        valid_bids = {p: s for p, s in bids.items() if (current_price - p) / current_price <= MAX_DIST}
        valid_asks = {p: s for p, s in asks.items() if (p - current_price) / current_price <= MAX_DIST}

        # OFI only using near-spread orders to prevent deep spoofing distortion
        ofi = sum(valid_bids.values()) - sum(valid_asks.values())

        # Calculate median size of all valid orders to establish a wall threshold
        all_sizes = list(valid_bids.values()) + list(valid_asks.values())
        median_size = float(np.median(all_sizes)) if all_sizes else 1.0
        wall_threshold = median_size * 5.0

        # Find top walls that exceed the threshold
        top_bids = sorted([(p, s) for p, s in valid_bids.items() if s > wall_threshold], key=lambda x: x[1], reverse=True)[:5]
        top_asks = sorted([(p, s) for p, s in valid_asks.items() if s > wall_threshold], key=lambda x: x[1], reverse=True)[:5]

        nearest_bid = top_bids[0][0] if top_bids else None
        nearest_ask = top_asks[0][0] if top_asks else None

        bid_dist = f"{((current_price - nearest_bid) / current_price * 100):.2f}" if nearest_bid else "N/A"
        ask_dist = f"{((nearest_ask - current_price) / current_price * 100):.2f}" if nearest_ask else "N/A"

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
    # 6. Bayesian Posterior P(Bull | Evidence)
    # ------------------------------------------------------------------
    def _bayesian(self, rsi: float, ofi: float, z_score: float, skewness: float) -> float:
        L_rsi  = 3.0   if rsi > 55      else 0.333 if rsi < 45      else 1.0
        L_ofi  = 1.5   if ofi > 10      else 0.667 if ofi < -10     else 1.0
        L_z    = 1.6   if z_score < -1.5 else 0.625 if z_score > 1.5 else 1.0
        L_skew = 1.2   if skewness > 0.3 else 0.833 if skewness < -0.3 else 1.0

        bull_odds = L_rsi * L_ofi * L_z * L_skew
        return float(bull_odds / (bull_odds + 1.0))
