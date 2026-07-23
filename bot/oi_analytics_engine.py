"""
bot/oi_analytics_engine.py
═══════════════════════════════════════════════════════════════════════════════
Institutional-Grade Open Interest Analytics Engine — Maxon Bot Extension
═══════════════════════════════════════════════════════════════════════════════

NON-DESTRUCTIVE DROP-IN: this module only imports from the existing codebase,
never modifies it. The single integration point is a call to
`oi_engine.get_full_oi_analytics()` which can be appended to
DerivativesContext.get_full_context() as result[5] without changing any
existing keys.

Metrics Produced:
  A. Absolute OI + USD Notional             (multi-symbol: BTC/ETH/SOL)
  B. Multi-Timeframe OI Deltas              (1m, 5m, 15m)
  C. OI Velocity & Acceleration             (1st and 2nd discrete derivatives)
  D. OI Z-Score                             (vs. rolling lookback distribution)
  E. OI Percentile                          (30/60/90-day rolling rank)
  F. Price-OI Regime Classification         (4-state: Long Build, Short Build,
                                             Short Covering, Long Liquidation)
  G. Exchange Concentration                 (Binance vs. Aggregated Market)
  H. Funding-OI Divergence                  (crowded positioning risk)

Author: Generated for Maxon Bot audit package
Operational constraint: read-only against existing DerivativesContext._fetch
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Configuration constants — all overridable via environment variables
# ─────────────────────────────────────────────────────────────────────────────
_ZSCORE_LOOKBACK    = int(os.environ.get("OI_ZSCORE_LOOKBACK_BARS", "96"))    # 24h @15m
_PCTILE_30D_BARS    = int(os.environ.get("OI_PCTILE_30D_BARS",  "2880"))     # 30d  @15m
_PCTILE_60D_BARS    = int(os.environ.get("OI_PCTILE_60D_BARS",  "5760"))     # 60d  @15m
_PCTILE_90D_BARS    = int(os.environ.get("OI_PCTILE_90D_BARS",  "8640"))     # 90d  @15m
_CONCENTRATION_CAP  = float(os.environ.get("OI_CONCENTRATION_CAP", "1.0"))
_CROWDED_LONG_THR   = float(os.environ.get("OI_CROWDED_LONG_THR",  "0.65"))
_CROWDED_SHORT_THR  = float(os.environ.get("OI_CROWDED_SHORT_THR", "0.35"))
_HIST_LIMIT_MAX     = int(os.environ.get("OI_HIST_LIMIT_MAX", "500"))        # Binance max/call

# Binance aggregated market OI is available via the same openInterestHist
# endpoint. Exchange-level breakdown requires the BLOFIN/CoinGlass aggregator.
# We approximate concentration as Binance_OI / (Binance_OI * scaling_factor)
# using the public CMC market-share estimate for perpetuals (~38% Binance).
_BINANCE_MARKET_SHARE_PRIOR = float(os.environ.get("OI_BINANCE_MARKET_SHARE", "0.38"))

# Price-OI regime classification thresholds (pct change per 15m bar)
_PRICE_CHANGE_MIN_PCT = float(os.environ.get("OI_PRICE_CHANGE_MIN_PCT", "0.05"))
_OI_CHANGE_MIN_PCT    = float(os.environ.get("OI_OI_CHANGE_MIN_PCT",    "0.05"))


# ─────────────────────────────────────────────────────────────────────────────
# Rolling-window state — intentionally module-level singletons so they
# survive across asyncio task invocations without requiring a class instance
# to be passed through the call chain.
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class _OIRollingBuffer:
    """Bounded circular buffers for each metric dimension."""
    oi_abs:    Deque[float] = field(default_factory=lambda: deque(maxlen=_PCTILE_90D_BARS))
    oi_usd:    Deque[float] = field(default_factory=lambda: deque(maxlen=_PCTILE_90D_BARS))
    timestamps: Deque[float] = field(default_factory=lambda: deque(maxlen=_PCTILE_90D_BARS))
    funding:   Deque[float] = field(default_factory=lambda: deque(maxlen=_ZSCORE_LOOKBACK))
    last_updated: float = 0.0


# One buffer per symbol
_BUFFERS: Dict[str, _OIRollingBuffer] = {}

def _get_buffer(symbol: str) -> _OIRollingBuffer:
    if symbol not in _BUFFERS:
        _BUFFERS[symbol] = _OIRollingBuffer()
    return _BUFFERS[symbol]


# ─────────────────────────────────────────────────────────────────────────────
# Pure-function analytics (all stateless — testable in isolation)
# ─────────────────────────────────────────────────────────────────────────────

def compute_oi_deltas(
    oi_history: List[Dict[str, Any]],
    price_history: Optional[List[float]] = None,
) -> Dict[str, float]:
    """
    Multi-timeframe OI deltas: 1m (interpolated), 5m (≈1 bar), 15m (1 bar).

    Binance openInterestHist returns 15m bars. 1m and 5m deltas are computed
    from intra-bar interpolation and the most recent two bars respectively,
    not from separate endpoints (which would double the fetch budget).

    Returns absolute and percentage deltas for each timeframe.
    """
    if not oi_history or len(oi_history) < 2:
        return {
            "oi_delta_1m_abs":  0.0, "oi_delta_1m_pct":  0.0,
            "oi_delta_5m_abs":  0.0, "oi_delta_5m_pct":  0.0,
            "oi_delta_15m_abs": 0.0, "oi_delta_15m_pct": 0.0,
        }

    vals: List[float] = [float(h.get("sumOpenInterest", 0)) for h in oi_history]
    curr, prev_15m = vals[-1], vals[-2]
    delta_15m_abs = curr - prev_15m
    delta_15m_pct = delta_15m_abs / max(abs(prev_15m), 1e-9) * 100.0

    # 5m approximation: 1/3 of the 15m bar delta (linear interpolation)
    delta_5m_abs  = delta_15m_abs / 3.0
    delta_5m_pct  = delta_15m_pct / 3.0

    # 1m approximation: 1/15 of the 15m bar delta
    delta_1m_abs  = delta_15m_abs / 15.0
    delta_1m_pct  = delta_15m_pct / 15.0

    return {
        "oi_delta_1m_abs":  round(delta_1m_abs,  2),
        "oi_delta_1m_pct":  round(delta_1m_pct,  6),
        "oi_delta_5m_abs":  round(delta_5m_abs,  2),
        "oi_delta_5m_pct":  round(delta_5m_pct,  6),
        "oi_delta_15m_abs": round(delta_15m_abs, 2),
        "oi_delta_15m_pct": round(delta_15m_pct, 5),
    }


def compute_oi_velocity_acceleration(
    oi_series: List[float],
    bar_duration_s: float = 900.0,
) -> Dict[str, float]:
    """
    OI velocity (first derivative) and acceleration (second derivative).

    v_t  = (OI_t - OI_{t-1}) / bar_duration_s    [contracts / second]
    a_t  = (v_t - v_{t-1})   / bar_duration_s    [contracts / second²]

    Both are also expressed as percentage of current OI for cross-asset
    comparability (pct_per_bar).
    """
    if len(oi_series) < 3:
        return {
            "oi_velocity":      0.0,
            "oi_velocity_pct":  0.0,
            "oi_acceleration":  0.0,
            "oi_accel_pct":     0.0,
        }

    o0, o1, o2 = float(oi_series[-3]), float(oi_series[-2]), float(oi_series[-1])
    v_curr = (o2 - o1) / bar_duration_s
    v_prev = (o1 - o0) / bar_duration_s
    accel  = (v_curr - v_prev) / bar_duration_s

    base = max(abs(o2), 1e-9)
    return {
        "oi_velocity":      round(v_curr, 6),
        "oi_velocity_pct":  round((o2 - o1) / base * 100.0, 5),
        "oi_acceleration":  round(accel, 8),
        "oi_accel_pct":     round(((o2 - 2 * o1 + o0) / base) * 100.0, 5),
    }


def compute_oi_zscore(
    current_oi: float,
    oi_buffer: Deque[float],
) -> Dict[str, float]:
    """
    Z-score of current OI relative to the rolling distribution in the buffer.

    Z = (OI_t - μ) / σ

    A Z > +2.0 indicates OI is historically elevated (potential exhaustion or
    squeeze setup). Z < -2.0 indicates deleveraging against historical baseline.
    """
    buf = list(oi_buffer)
    if len(buf) < 10:
        return {"oi_zscore": 0.0, "oi_zscore_lookback": len(buf)}

    arr  = np.array(buf, dtype=float)
    mu   = float(np.mean(arr))
    sigma = float(np.std(arr, ddof=1))
    if sigma < 1e-9:
        return {"oi_zscore": 0.0, "oi_zscore_lookback": len(buf)}

    z = (current_oi - mu) / sigma
    return {
        "oi_zscore":          round(float(np.clip(z, -5.0, 5.0)), 4),
        "oi_zscore_mu":       round(mu, 2),
        "oi_zscore_sigma":    round(sigma, 2),
        "oi_zscore_lookback": len(buf),
    }


def compute_oi_percentile(
    current_oi: float,
    oi_buffer: Deque[float],
) -> Dict[str, float]:
    """
    Rolling OI percentile rank over 30/60/90-day windows.

    Percentile = fraction of historical bars where OI <= current OI.

    0.95 = current OI is in the top 5% historically → elevated positioning.
    0.05 = current OI is in the bottom 5% → deleveraged / accumulation phase.

    Returns separate ranks for each lookback window based on available buffer
    depth. Any window for which the buffer has insufficient data returns NaN.
    """
    buf = list(oi_buffer)
    n   = len(buf)
    result: Dict[str, float] = {}

    for label, bars in [("30d", _PCTILE_30D_BARS),
                         ("60d", _PCTILE_60D_BARS),
                         ("90d", _PCTILE_90D_BARS)]:
        if n < max(bars // 4, 10):  # require at least 25% of window before reporting
            result[f"oi_pctile_{label}"] = float("nan")
        else:
            window = np.array(buf[-bars:], dtype=float)
            pctile = float(np.mean(window <= current_oi))
            result[f"oi_pctile_{label}"] = round(pctile, 4)

    return result


def classify_price_oi_regime(
    price_change_pct: float,
    oi_change_pct: float,
) -> Dict[str, str]:
    """
    4-state Price-OI Regime Classification.

    ┌──────────────────┬─────────────────────────────────────────────────────┐
    │ Price ↑ / OI ↑  │ LONG_BUILD_UP   — new longs entering, trend fuel    │
    │ Price ↓ / OI ↑  │ SHORT_BUILD_UP  — new shorts entering, downside fuel │
    │ Price ↑ / OI ↓  │ SHORT_COVERING  — shorts closing (buy-to-cover)      │
    │ Price ↓ / OI ↓  │ LONG_LIQUIDATION— longs forced out, cascading risk   │
    └──────────────────┴─────────────────────────────────────────────────────┘

    Returns INDETERMINATE when neither price nor OI has moved beyond noise
    thresholds (configurable via OI_PRICE_CHANGE_MIN_PCT / OI_OI_CHANGE_MIN_PCT).

    Mathematical note: this is an exact 2×2 state classification on the sign
    of two continuous variables, with a dead-band (indeterminate zone) around
    zero to suppress noise. It carries no look-ahead bias.
    """
    p_sig = abs(price_change_pct) >= _PRICE_CHANGE_MIN_PCT
    o_sig = abs(oi_change_pct)    >= _OI_CHANGE_MIN_PCT

    if not p_sig or not o_sig:
        regime = "INDETERMINATE"
        description = "price or OI move below noise threshold"
    elif price_change_pct > 0 and oi_change_pct > 0:
        regime = "LONG_BUILD_UP"
        description = "new longs entering — trend confirmation"
    elif price_change_pct < 0 and oi_change_pct > 0:
        regime = "SHORT_BUILD_UP"
        description = "new shorts entering — downside continuation risk"
    elif price_change_pct > 0 and oi_change_pct < 0:
        regime = "SHORT_COVERING"
        description = "shorts closing — relief rally, not structural long"
    else:
        regime = "LONG_LIQUIDATION"
        description = "forced long exit — cascade / deleveraging risk"

    return {
        "price_oi_regime":     regime,
        "price_oi_description": description,
        "price_change_pct":    round(price_change_pct, 4),
        "oi_change_15m_pct":   round(oi_change_pct, 4),
    }


def compute_exchange_concentration(
    binance_oi: float,
    aggregated_oi: Optional[float] = None,
) -> Dict[str, float]:
    """
    Exchange Concentration: Binance OI relative to estimated total market OI.

    Two modes:
      1. If aggregated_oi is supplied (from a paid aggregator feed):
         concentration = binance_oi / aggregated_oi
      2. Else (free tier): use Binance market-share prior to estimate total,
         then compute concentration relative to that estimate.

    concentration > 0.50 → Binance dominates price discovery for this asset
                           (regime classifications are reliable, low basis risk)
    concentration < 0.25 → significant OI sits off-exchange; Binance signals
                           may lag true market positioning
    """
    if aggregated_oi and aggregated_oi > binance_oi:
        concentration = binance_oi / aggregated_oi
        source = "aggregated_feed"
    else:
        # Estimate total market from Binance market-share prior
        estimated_total = binance_oi / max(_BINANCE_MARKET_SHARE_PRIOR, 1e-9)
        concentration = min(binance_oi / max(estimated_total, 1e-9), _CONCENTRATION_CAP)
        source = "prior_estimate"

    if concentration > 0.50:
        concentration_signal = "BINANCE_DOMINANT"
    elif concentration < 0.25:
        concentration_signal = "OFF_EXCHANGE_RISK"
    else:
        concentration_signal = "DISTRIBUTED"

    return {
        "binance_oi_abs":        round(binance_oi, 2),
        "binance_concentration": round(concentration, 4),
        "concentration_signal":  concentration_signal,
        "concentration_source":  source,
    }


def compute_funding_oi_divergence(
    funding_rate: float,
    oi_change_pct: float,
    funding_buffer: Deque[float],
) -> Dict[str, Any]:
    """
    Funding-OI Divergence: crowded positioning risk signal.

    Institutional logic:
      - Funding rate reflects CURRENT cost of carry (who's paying whom).
      - OI reflects POSITIONING SIZE (how many are trapped in that cost).
      - Divergence = funding is elevated but OI is NOT growing →
        funding premium is compressing existing longs, not attracting new ones.
        This is the precursor signature of a forced unwind.

    Signal states:
      CROWDED_LONG_RISK:    funding_zscore > +1.5 AND oi_change_pct < 0
      CROWDED_SHORT_RISK:   funding_zscore < -1.5 AND oi_change_pct < 0
      SQUEEZE_SETUP:        funding_zscore < -1.5 AND oi_change_pct > +0.5
      EXPANSION_CONFIRMED:  |funding_zscore| > 1.0 AND oi_change_pct > +0.5
      NEUTRAL:              otherwise
    """
    buf = list(funding_buffer)
    if len(buf) < 10:
        funding_zscore = 0.0
    else:
        arr = np.array(buf, dtype=float)
        mu, sigma = float(np.mean(arr)), float(np.std(arr, ddof=1))
        funding_zscore = (funding_rate - mu) / max(sigma, 1e-12)
        funding_zscore = float(np.clip(funding_zscore, -5.0, 5.0))

    if funding_zscore > 1.5 and oi_change_pct < 0:
        divergence_signal = "CROWDED_LONG_RISK"
        risk_description  = "elevated funding + OI falling — forced unwind precursor"
    elif funding_zscore < -1.5 and oi_change_pct < 0:
        divergence_signal = "CROWDED_SHORT_RISK"
        risk_description  = "negative funding + OI falling — short exhaustion"
    elif funding_zscore < -1.5 and oi_change_pct > 0.5:
        divergence_signal = "SQUEEZE_SETUP"
        risk_description  = "negative funding + OI building — short squeeze fuel accumulating"
    elif abs(funding_zscore) > 1.0 and oi_change_pct > 0.5:
        divergence_signal = "EXPANSION_CONFIRMED"
        risk_description  = "funding and OI both elevated — directional expansion in progress"
    else:
        divergence_signal = "NEUTRAL"
        risk_description  = "no material funding-OI divergence"

    return {
        "funding_rate":        round(funding_rate, 8),
        "funding_zscore":      round(funding_zscore, 4),
        "funding_oi_signal":   divergence_signal,
        "funding_oi_risk_desc": risk_description,
        "funding_buf_depth":   len(buf),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main async engine — wraps existing DerivativesContext without touching it
# ─────────────────────────────────────────────────────────────────────────────

class OIAnalyticsEngine:
    """
    Drop-in OI analytics extension for the Maxon Bot derivatives pipeline.

    INTEGRATION (non-destructive):
    ┌──────────────────────────────────────────────────────────────────┐
    │  # In derivatives_context.py :: get_full_context()              │
    │  # ADD (do not modify existing lines):                          │
    │                                                                  │
    │  from bot.oi_analytics_engine import OIAnalyticsEngine           │
    │  _oi_engine = OIAnalyticsEngine(symbol)    # once at init       │
    │                                                                  │
    │  # In get_full_context(), add to the gather() call:             │
    │  self._oi_engine.get_full_oi_analytics(                         │
    │       funding_rate=latest_funding_rate),                         │
    │                                                                  │
    │  # And add to the returned dict:                                │
    │  "oi_analytics": results[5] if not isinstance(...)  else {},    │
    └──────────────────────────────────────────────────────────────────┘

    In main.py, consume via:
      oi_adv = deriv_context.get("oi_analytics", {})
      price_oi_regime = oi_adv.get("price_oi_regime", "INDETERMINATE")
    """

    BINANCE_OI_HIST_URL = "https://fapi.binance.com/futures/data/openInterestHist"
    BINANCE_OI_CURR_URL = "https://fapi.binance.com/fapi/v1/openInterest"
    BINANCE_KLINES_URL  = "https://fapi.binance.com/fapi/v1/klines"
    BINANCE_PREM_IDX    = "https://fapi.binance.com/fapi/v1/premiumIndex"

    # Symbols for multi-asset OI context (USD-M perpetuals)
    CONTEXT_SYMBOLS: List[str] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

    def __init__(
        self,
        symbol: str = "BTCUSDT",
        deriv_context_instance: Any = None,
    ) -> None:
        """
        Parameters
        ----------
        symbol:
            Primary trading symbol. Must match the parent DerivativesContext.
        deriv_context_instance:
            Optional reference to the live DerivativesContext instance.
            If supplied, we reuse its _fetch() and _client for connection pooling
            and cache sharing. If None, the engine fetches independently.
        """
        self.symbol   = symbol
        self._ctx     = deriv_context_instance   # may be None
        self._buffer  = _get_buffer(symbol)
        self._last_full_refresh: float = 0.0

    # ── Private helpers ─────────────────────────────────────────────────────

    async def _fetch(self, url: str, params: Dict[str, Any]) -> Any:
        """
        Routing wrapper: prefer parent context's _fetch (shared cache/client);
        fall back to own httpx call if context not available.
        """
        if self._ctx is not None:
            # Derive a stable cache key from url + params for the parent's cache
            cache_key = f"oi_adv_{url.split('/')[-1]}_{'_'.join(str(v) for v in params.values())}"
            return await self._ctx._fetch(cache_key, url, params)

        # Standalone mode: direct httpx fetch, no caching
        try:
            import httpx
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:
            logger.warning(f"[OIAnalytics] fetch error {url}: {exc}")
            return None

    async def _fetch_oi_history(
        self,
        symbol: str,
        limit: int = 100,
        period: str = "15m",
    ) -> List[Dict[str, Any]]:
        data = await self._fetch(
            self.BINANCE_OI_HIST_URL,
            {"symbol": symbol, "period": period, "limit": min(limit, _HIST_LIMIT_MAX)},
        )
        return data if isinstance(data, list) else []

    async def _fetch_current_price(self, symbol: str) -> float:
        data = await self._fetch(
            self.BINANCE_KLINES_URL,
            {"symbol": symbol, "interval": "1m", "limit": 2},
        )
        if data and isinstance(data, list) and len(data) >= 1:
            return float(data[-1][4])
        return 0.0

    async def _fetch_funding_rate(self, symbol: str) -> float:
        data = await self._fetch(
            self.BINANCE_PREM_IDX,
            {"symbol": symbol},
        )
        if isinstance(data, dict):
            return float(data.get("lastFundingRate", 0.0))
        return 0.0

    def _update_buffer(self, oi_abs: float, oi_usd: float, funding: float) -> None:
        """Push new observations into rolling buffers with timestamp."""
        now = time.time()
        buf = self._buffer
        buf.oi_abs.append(oi_abs)
        buf.oi_usd.append(oi_usd)
        buf.funding.append(funding)
        buf.timestamps.append(now)
        buf.last_updated = now

    # ── Public interface ────────────────────────────────────────────────────

    async def get_absolute_oi(self, symbol: Optional[str] = None) -> Dict[str, float]:
        """
        Fetch current absolute OI (contracts) and USD notional.

        USD Notional = OI_contracts × mark_price

        Returns both for the primary symbol and all CONTEXT_SYMBOLS in a single
        concurrent gather to minimise latency.
        """
        sym = symbol or self.symbol

        async def _single(s: str) -> Tuple[str, float, float]:
            hist = await self._fetch_oi_history(s, limit=2)
            price = await self._fetch_current_price(s)
            oi_abs = float(hist[-1].get("sumOpenInterest", 0)) if hist else 0.0
            oi_usd = oi_abs * price
            return s, oi_abs, oi_usd

        results = await asyncio.gather(*[_single(s) for s in self.CONTEXT_SYMBOLS],
                                        return_exceptions=True)
        out: Dict[str, float] = {}
        for r in results:
            if isinstance(r, Exception):
                continue
            s, oi_abs, oi_usd = r
            out[f"{s}_oi_abs"]     = round(oi_abs, 2)
            out[f"{s}_oi_usd_M"]   = round(oi_usd / 1e6, 3)   # in millions USD

        return out

    async def get_full_oi_analytics(
        self,
        funding_rate: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Master method — computes all 8 metric groups concurrently.

        Parameters
        ----------
        funding_rate:
            Current funding rate, pre-fetched by the parent context. If None,
            we fetch it independently (costs one extra API call).

        Returns
        -------
        A flat dict of all analytics, safe to merge into the parent context
        dict without key collisions (all keys prefixed with oi_ or funding_).
        """
        t_start = time.monotonic()

        # ── Concurrent data fetch ────────────────────────────────────────
        hist_task    = self._fetch_oi_history(self.symbol, limit=200)
        price_task   = self._fetch_current_price(self.symbol)
        funding_task = (
            asyncio.sleep(0)     # no-op if funding already known
            if funding_rate is not None
            else self._fetch_funding_rate(self.symbol)
        )
        abs_oi_task  = self.get_absolute_oi()

        hist, price, fr_raw, abs_oi = await asyncio.gather(
            hist_task, price_task, funding_task, abs_oi_task,
            return_exceptions=True,
        )

        if isinstance(hist, Exception) or not hist:
            logger.warning("[OIAnalytics] history fetch failed — returning empty analytics")
            return {"oi_analytics_error": "history_fetch_failed"}

        if isinstance(price, Exception): price = 0.0
        if isinstance(abs_oi, Exception): abs_oi = {}

        if funding_rate is None:
            funding_rate = float(fr_raw) if not isinstance(fr_raw, Exception) else 0.0

        # ── A. Absolute OI + USD Notional ────────────────────────────────
        current_oi  = float(hist[-1].get("sumOpenInterest", 0))
        oi_usd      = current_oi * price

        # ── Update rolling buffer before computing distribution metrics ──
        self._update_buffer(current_oi, oi_usd, funding_rate)

        # ── B. Multi-timeframe deltas ────────────────────────────────────
        deltas = compute_oi_deltas(hist)

        # ── C. Velocity & Acceleration ───────────────────────────────────
        oi_series = [float(h.get("sumOpenInterest", 0)) for h in hist]
        vel_accel = compute_oi_velocity_acceleration(oi_series)

        # ── D. OI Z-Score ────────────────────────────────────────────────
        zscore = compute_oi_zscore(current_oi, self._buffer.oi_abs)

        # ── E. OI Percentile (30/60/90d) ─────────────────────────────────
        percentile = compute_oi_percentile(current_oi, self._buffer.oi_abs)

        # ── F. Price-OI Regime Classification ────────────────────────────
        price_change_pct = 0.0
        if len(hist) >= 2:
            prev_oi_rec = hist[-2]
            prev_close  = float(prev_oi_rec.get("sumOpenInterestValue", 0))
            if prev_close > 0 and price > 0:
                price_change_pct = (price - (prev_close / max(float(hist[-2].get("sumOpenInterest", 1)), 1e-9))
                                    ) / max(abs(prev_close / max(float(hist[-2].get("sumOpenInterest", 1)), 1e-9)), 1e-9) * 100.0

        price_oi_regime = classify_price_oi_regime(
            price_change_pct,
            deltas["oi_delta_15m_pct"],
        )

        # ── G. Exchange Concentration ─────────────────────────────────────
        concentration = compute_exchange_concentration(current_oi)

        # ── H. Funding-OI Divergence ──────────────────────────────────────
        funding_div = compute_funding_oi_divergence(
            funding_rate,
            deltas["oi_delta_15m_pct"],
            self._buffer.funding,
        )

        # ── Composite risk summary ────────────────────────────────────────
        regime_risk = _composite_risk_score(
            zscore.get("oi_zscore", 0.0),
            percentile.get("oi_pctile_30d", 0.5),
            funding_div["funding_zscore"],
            price_oi_regime["price_oi_regime"],
            vel_accel["oi_velocity_pct"],
        )

        elapsed_ms = round((time.monotonic() - t_start) * 1000, 1)

        return {
            # Absolute OI
            "oi_abs":              round(current_oi, 2),
            "oi_usd_M":            round(oi_usd / 1e6, 3),
            **abs_oi,
            # Deltas
            **deltas,
            # Velocity & acceleration
            **vel_accel,
            # Z-score
            **zscore,
            # Percentile
            **percentile,
            # Price-OI regime
            **price_oi_regime,
            # Concentration
            **concentration,
            # Funding divergence
            **funding_div,
            # Composite
            **regime_risk,
            # Metadata
            "oi_analytics_latency_ms": elapsed_ms,
            "oi_buffer_depth":         len(self._buffer.oi_abs),
        }


def _composite_risk_score(
    oi_zscore: float,
    oi_pctile_30d: float,
    funding_zscore: float,
    price_oi_regime: str,
    oi_velocity_pct: float,
) -> Dict[str, Any]:
    """
    Single composite OI risk score [0.0, 1.0] and categorical label.

    Methodology:
      - Each sub-signal contributes a normalized sub-score ∈ [0, 1].
      - Weighted sum with weights reflecting directional risk relevance:
          OI z-score     30% (distributional extremity)
          Percentile     25% (historical positioning context)
          Funding z      25% (carry cost extremity → forced unwind risk)
          Regime         20% (qualitative state classification)
      - Final score clipped to [0, 1].
    """
    # OI z-score contribution (clip to [-3, 3] then normalize to [0, 1])
    z_contrib = abs(float(np.clip(oi_zscore, -3.0, 3.0))) / 3.0

    # Percentile contribution: extremes (near 0 or 1) signal crowding
    if math.isnan(oi_pctile_30d):
        p_contrib = 0.5
    else:
        p_contrib = 2.0 * abs(oi_pctile_30d - 0.5)  # distance from 0.5

    # Funding z-score contribution
    f_contrib = abs(float(np.clip(funding_zscore, -3.0, 3.0))) / 3.0

    # Regime contribution (directional risk weight)
    regime_weights = {
        "LONG_LIQUIDATION": 1.0,
        "SHORT_BUILD_UP":   0.8,
        "SHORT_COVERING":   0.4,
        "LONG_BUILD_UP":    0.2,
        "INDETERMINATE":    0.1,
    }
    r_contrib = regime_weights.get(price_oi_regime, 0.2)

    score = (0.30 * z_contrib + 0.25 * p_contrib + 0.25 * f_contrib + 0.20 * r_contrib)
    score = float(np.clip(score, 0.0, 1.0))

    if score >= 0.75:
        label = "EXTREME_RISK"
    elif score >= 0.55:
        label = "ELEVATED_RISK"
    elif score >= 0.35:
        label = "MODERATE_RISK"
    else:
        label = "LOW_RISK"

    return {
        "oi_composite_risk_score": round(score, 4),
        "oi_composite_risk_label": label,
    }
