import httpx
import asyncio
import logging
import time
import math

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# GEX Computation (Dr. Klint — critical finding)
# ──────────────────────────────────────────────────────────────────────────────
# Gamma Exposure (GEX) measures dealer hedging pressure per strike.
# GEX > 0 (positive gamma): dealer hedging dampens price moves  → PIN zone (mean-revert)
# GEX < 0 (negative gamma):  dealer hedging amplifies price moves → SWEEP zone (trend continuation)
#
# GEX per strike = Gamma × OI
# Gamma ≈ (1 / (K × σ × √T)) × N(d1)
#
# Key insight: OI-only sweep detection misclassifies ~30-40% of zones.
# When GEX > 0 at a strike, dealer flow SUPPORTS price (fade the sweep).
# When GEX < 0 at a strike, dealer flow AMPLIFIES the sweep (confirm the sweep).
# ──────────────────────────────────────────────────────────────────────────────

def _norm_cdf(x: float) -> float:
    """Standard normal CDF — no scipy dependency."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))

def _black_scholes_gamma(S: float, K: float, T: float, sigma: float) -> float:
    """
    Black-Scholes gamma for an option.
    Gamma = (1/(K*σ*√T)) * N(d1)
    Returns 0 for invalid inputs (zero sigma, expiry, etc.).
    """
    if sigma <= 0 or T <= 0 or K <= 0 or S <= 0:
        return 0.0
    d1 = (math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * math.sqrt(T))
    n_d1 = math.exp(-0.5 * d1 * d1) / math.sqrt(2.0 * math.pi)
    return n_d1 / (K * sigma * math.sqrt(T))

def compute_gex_for_strikes(
    S: float,
    instruments: list,
    gex_threshold_btc: float = 5.0,
) -> dict:
    """
    Compute GEX for each strike from Deribit options data.

    Args:
        S: Current BTC spot price (used to compute d1)
        instruments: list of Deribit instrument dicts with
            instrument_name, open_interest, mark_iv, expiration
        gex_threshold_btc: minimum OI in BTC to classify as a real zone (filters noise)

    Returns:
        {
            "total_gex": float,          # aggregate GEX across all strikes
            "gex_per_strike": dict,     # strike_price → gex_value
            "pin_zones": list,           # strikes with GEX > 0  (positive gamma, mean-revert)
            "sweep_zones": list,         # strikes with GEX < 0  (negative gamma, trend)
            "dominant_signal": str,      # "PIN" | "SWEEP" | "NEUTRAL"
        }
    """
    gex_per_strike = {}
    now_ts = time.time()
    MIN_EXPIRY_SECS = 48 * 3600  # 48h — options expiring sooner are excluded
    MIN_OI_BTC = 0.5            # minimum open interest (BTC) to avoid OI noise

    for inst in instruments:
        try:
            oi       = float(inst.get("open_interest", 0))
            mark_iv  = float(inst.get("mark_iv", 0)) / 100.0  # Deribit returns as %
            exp_ms   = int(inst.get("expiration", 0))
            name     = inst.get("instrument_name", "")

            if oi < MIN_OI_BTC:
                continue
            if not name.endswith(("-P", "-C")):
                continue

            # Parse strike from instrument name — format: BTC-OPTIONS-27JUN25-95000-P
            parts = name.split("-")
            try:
                strike = float(parts[-2])
            except (ValueError, IndexError):
                continue

            # Expiry time in years
            T = max((exp_ms / 1000.0 - now_ts) / (365.25 * 86400.0), 1.0 / 365.25 / 24.0)

            if T * 365.25 * 86400.0 < MIN_EXPIRY_SECS:
                continue  # Skip within-48h expiries — gamma unreliable

            gamma = _black_scholes_gamma(S, strike, T, mark_iv)
            if gamma <= 0:
                continue

            # Black-Scholes gamma is positive for both calls and puts. For a
            # usable dealer-gamma proxy, signed GEX must apply option-side
            # direction; otherwise sweep_zones can never be negative.
            option_type = parts[-1]
            side_sign = 1.0 if option_type == "C" else -1.0
            gex_per_strike[strike] = gex_per_strike.get(strike, 0.0) + side_sign * gamma * oi

        except Exception:
            continue

    if not gex_per_strike:
        return {
            "total_gex": 0.0,
            "gex_per_strike": {},
            "pin_zones": [],
            "sweep_zones": [],
            "dominant_signal": "NEUTRAL",
            "gex_is_signed": True,
        }

    total_gex = sum(gex_per_strike.values())

    pin_zones   = sorted([k for k, v in gex_per_strike.items() if v > 0])
    sweep_zones = sorted([k for k, v in gex_per_strike.items() if v < 0])

    if total_gex > gex_threshold_btc:
        dominant_signal = "PIN"
    elif total_gex < -gex_threshold_btc:
        dominant_signal = "SWEEP"
    else:
        dominant_signal = "NEUTRAL"

    logger.info(
        f"[GEX] total={total_gex:.1f} | PIN strikes={len(pin_zones)} | "
        f"SWEEP strikes={len(sweep_zones)} | signal={dominant_signal}"
    )

    return {
        "total_gex": total_gex,
        "gex_per_strike": gex_per_strike,
        "pin_zones": pin_zones,
        "sweep_zones": sweep_zones,
        "dominant_signal": dominant_signal,
        "gex_is_signed": True,
    }


class DerivativesContext:
    """
    Fetches institutional-grade signals from free public APIs.
    All four sources are completely free — no API key required.
    Run once per candle close, cache for 5 minutes.

    H1 FIX: Persistent httpx.AsyncClient reused across all requests.
    Connection pool eliminates TLS handshake overhead on every call.
    """

    def __init__(self, symbol: str = "BTCUSDT"):
        self.symbol = symbol
        self._cache: dict = {}
        self._cache_ts: dict = {}
        self.CACHE_TTL = 300  # 5 minutes
        self._client: httpx.AsyncClient = None  # H1: lazy-initialized persistent client

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=8.0, limits=httpx.Limits(max_keepalive_connections=5, max_connections=10))
        return self._client

    async def close(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _fetch(self, key: str, url: str, params: dict = None) -> dict:
        now = time.time()
        if key in self._cache and (now - self._cache_ts.get(key, 0)) < self.CACHE_TTL:
            return self._cache[key]
        try:
            client = await self._get_client()
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            # H2 FIX: Only cache truthy non-empty responses.
            # Empty dict/list from API errors or rate-limit blanks should not
            # overwrite a valid prior cache entry or get cached as fresh.
            if data:
                self._cache[key] = data
                self._cache_ts[key] = now
            elif key in self._cache:
                # Return stale cache rather than overwriting with empty
                logger.info(f"[Derivatives] Empty response for {key} — returning stale cache (age={(now - self._cache_ts.get(key, now)):.0f}s)")
                return self._cache[key]
            return data
        except Exception as e:
            logger.warning(f"[Derivatives] {key} fetch failed: {e}")
            if key in self._cache:
                logger.info(f"[Derivatives] Returning stale cache for {key} (age={(now - self._cache_ts.get(key, now)):.0f}s)")
                return self._cache[key]
            return {}

    async def get_open_interest(self) -> dict:
        """
        Binance USDM REST — completely free.
        OI rising + price flat = position building (coiled spring).
        OI collapsing = deleveraging, do not enter new positions.
        """
        current = await self._fetch(
            "oi_current",
            "https://fapi.binance.com/fapi/v1/openInterest",
            {"symbol": self.symbol}
        )
        history = await self._fetch(
            "oi_history",
            "https://fapi.binance.com/futures/data/openInterestHist",
            {"symbol": self.symbol, "period": "15m", "limit": 30}
        )

        current_oi = float(current.get("openInterest", 0))

        oi_change_pct = 0.0
        oi_momentum_1h = 0.0

        if history and len(history) >= 4:
            prev_oi = float(history[-2].get("sumOpenInterest", current_oi))
            oi_change_pct = (current_oi - prev_oi) / max(prev_oi, 1) * 100
            oi_1h_ago = float(history[-4].get("sumOpenInterest", current_oi))
            oi_momentum_1h = (current_oi - oi_1h_ago) / max(oi_1h_ago, 1) * 100

        return {
            "current_oi": current_oi,
            "oi_change_pct_15m": oi_change_pct,
            "oi_momentum_1h": oi_momentum_1h,
            "oi_collapsing": oi_momentum_1h < -2.0,
        }

    async def get_top_trader_positioning(self) -> dict:
        """
        Binance publishes top trader (whale) long/short ratio — free.
        When top traders are >70% long = crowded = CONTRARIAN bearish.
        When top traders are >70% short = crowded short = squeeze risk.
        This is the single most powerful free contrarian signal available.
        """
        data = await self._fetch(
            "top_trader_ls",
            "https://fapi.binance.com/futures/data/topLongShortPositionRatio",
            {"symbol": self.symbol, "period": "15m", "limit": 10}
        )
        if not data:
            return {"top_long_pct": 50.0, "crowd_signal": "NEUTRAL"}

        latest = data[-1]
        long_pct = float(latest.get("longAccount", 0.5)) * 100
        short_pct = 100 - long_pct

        if long_pct > 70:
            crowd_signal = "CROWDED_LONG"    # contrarian bearish
        elif short_pct > 70:
            crowd_signal = "CROWDED_SHORT"   # contrarian bullish squeeze risk
        else:
            crowd_signal = "NEUTRAL"

        return {
            "top_long_pct": long_pct,
            "top_short_pct": short_pct,
            "crowd_signal": crowd_signal,
        }

    async def get_options_context(self) -> dict:
        """
        Deribit options API — completely free, no account needed.
        Put/call ratio > 1.2 = institutions hedging downside = FEAR signal.
        GEX (Gamma Exposure) per strike:
          GEX > 0 (PIN zone)  = dealer hedging dampens price → mean-revert
          GEX < 0 (SWEEP zone) = dealer hedging amplifies price → trend continuation
        The GEX upgrade replaces OI-only sweep detection which misclassified
        ~30-40% of zones (Dr. Klint's critical finding).
        """
        try:
            data = await self._fetch(
                "deribit_options",
                "https://www.deribit.com/api/v2/public/get_book_summary_by_currency",
                {"currency": "BTC", "kind": "option"}
            )
            instruments = data.get("result", [])
            if not instruments:
                return {
                    "put_call_ratio": 1.0,
                    "options_signal": "NEUTRAL",
                    "gex_signal": "NEUTRAL",
                    "total_gex": 0.0,
                    "gex_is_signed": False,
                }

            total_put_oi = sum(
                float(i.get("open_interest", 0))
                for i in instruments if "-P" in i.get("instrument_name", "")
            )
            total_call_oi = sum(
                float(i.get("open_interest", 0))
                for i in instruments if "-C" in i.get("instrument_name", "")
            )

            put_call_ratio = total_put_oi / max(total_call_oi, 1)

            if put_call_ratio > 1.2:
                options_signal = "FEAR"
            elif put_call_ratio < 0.8:
                options_signal = "GREED"
            else:
                options_signal = "NEUTRAL"

            # Deribit doesn't expose spot price directly in this endpoint.
            # Fetch it from Binance as a side-effect-free Taker flow call.
            S = await self._get_btc_spot_price()

            gex_data = compute_gex_for_strikes(S, instruments)
            gex_signal = gex_data["dominant_signal"]

            return {
                "put_call_ratio": round(put_call_ratio, 3),
                "options_signal": options_signal,
                "total_gex": round(gex_data["total_gex"], 3),
                "gex_signal": gex_signal,
                "gex_is_signed": bool(gex_data.get("gex_is_signed", False)),
                "pin_zones": gex_data["pin_zones"],
                "sweep_zones": gex_data["sweep_zones"],
                "gex_per_strike": gex_data["gex_per_strike"],
            }
        except Exception as e:
            return {
                "put_call_ratio": 1.0,
                "options_signal": "NEUTRAL",
                "gex_signal": "NEUTRAL",
                "total_gex": 0.0,
                "gex_is_signed": False,
                "error": str(e),
            }

    async def _get_btc_spot_price(self) -> float:
        """Fetch current BTC spot price from Binance for GEX d1 calculation."""
        try:
            data = await self._fetch(
                "btc_spot",
                "https://api.binance.com/api/v3/ticker/price",
                {"symbol": "BTCUSDT"}
            )
            return float(data.get("price", 0))
        except Exception:
            return 0.0

    async def get_oi_velocity_divergence(self) -> dict:
        """
        OI Velocity Divergence — Dr. Klint priority #2 (highest mechanistic grounding).

        Signal = sign(price_change) × (−1) × sign(OI_velocity)
          +1 = EXHAUSTION   (price up + OI down = longs trapped, bearish)
          -1 = CONTINUATION (price up + OI up   = new money confirming, bullish)
           0 = INCONCLUSIVE

        OI acceleration (second derivative) adds 1-2 candle early warning.
        Raw OI data already fetched every 15m in get_open_interest().
        """
        oi_data = await self.get_open_interest()
        current_oi = oi_data.get("current_oi", 0)

        if not current_oi:
            return {"divergence": 0, "acceleration": 0.0, "signal": "INCONCLUSIVE"}

        # Fetch recent history for price velocity + OI acceleration
        history = await self._fetch(
            "oi_history",
            "https://fapi.binance.com/futures/data/openInterestHist",
            {"symbol": self.symbol, "period": "15m", "limit": 10}
        )

        if not history or len(history) < 4:
            return {"divergence": 0, "acceleration": 0.0, "signal": "INCONCLUSIVE"}

        oi_values = [float(h.get("sumOpenInterest", 0)) for h in history]

        # Price change over last 30min (2 × 15m candles)
        price_data = await self._fetch(
            "btc_klines_15m",
            "https://fapi.binance.com/fapi/v1/klines",
            {"symbol": self.symbol, "interval": "15m", "limit": 5}
        )
        if price_data and len(price_data) >= 2:
            price_now  = float(price_data[-1][4])   # close of most recent candle
            price_prev = float(price_data[-3][4]) if len(price_data) >= 3 else float(price_data[-2][4])
            price_change_pct = (price_now - price_prev) / max(price_prev, 1.0) * 100.0
        else:
            price_change_pct = 0.0

        # OI velocity: change over last 30min
        oi_now  = oi_values[-1]
        oi_prev = oi_values[-2] if len(oi_values) >= 2 else oi_now
        oi_30m_ago = oi_values[-3] if len(oi_values) >= 3 else oi_prev
        k = 1.0
        atr_pct = 0.005
        oi_velocity = (oi_now - oi_prev) / max(k * atr_pct * oi_prev, 1e-9)
        oi_acceleration = (oi_now - 2 * oi_prev + oi_30m_ago) / max(k * atr_pct * oi_prev, 1e-9)

        divergence_raw = math.copysign(1, price_change_pct) * (-1) * math.copysign(1, oi_velocity)
        divergence = int(divergence_raw)  # +1, -1, or 0

        # Acceleration warning: negative acceleration even when divergence is +1
        # signals exhaustion building
        if divergence == 1 and oi_acceleration < -0.5:
            signal = "EXHAUSTION_WARNING"  # 1-2 candle early warning
        elif divergence == 1:
            signal = "EXHAUSTION"
        elif divergence == -1:
            signal = "CONTINUATION"
        else:
            signal = "INCONCLUSIVE"

        logger.info(
            f"[OI-Velocity] divergence={signal} (d={divergence}) "
            f"price_chg={price_change_pct:+.2f}% oi_vel={oi_velocity:+.2f}% "
            f"oi_accel={oi_acceleration:+.3f}%"
        )

        return {
            "divergence": divergence,
            "acceleration": round(oi_acceleration, 4),
            "signal": signal,
            "oi_velocity": round(oi_velocity, 3),
            "price_change_pct": round(price_change_pct, 3),
        }

    async def get_taker_flow(self) -> dict:
        """
        Binance taker buy/sell ratio — free.
        Taker imbalance > 0.3 with BUY signal = aggressive buyers confirming.
        Taker imbalance < -0.3 with SELL signal = aggressive sellers confirming.
        """
        data = await self._fetch(
            "taker_flow",
            "https://fapi.binance.com/futures/data/takerlongshortRatio",
            {"symbol": self.symbol, "period": "5m", "limit": 12}
        )
        if not data:
            return {"taker_imbalance": 0.0}

        latest = data[-1]
        buy_vol = float(latest.get("buyVol", 0))
        sell_vol = float(latest.get("sellVol", 0))
        total = buy_vol + sell_vol

        return {
            "taker_buy_ratio": buy_vol / max(total, 1),
            "taker_sell_ratio": sell_vol / max(total, 1),
            "taker_imbalance": (buy_vol - sell_vol) / max(total, 1),
        }

    async def get_full_context(self) -> dict:
        """Fetch all signals concurrently. Total latency = slowest single call."""
        results = await asyncio.gather(
            self.get_open_interest(),
            self.get_top_trader_positioning(),
            self.get_options_context(),
            self.get_taker_flow(),
            self.get_oi_velocity_divergence(),
            return_exceptions=True
        )
        return {
            "open_interest":        results[0] if not isinstance(results[0], Exception) else {},
            "top_traders":          results[1] if not isinstance(results[1], Exception) else {},
            "options":              results[2] if not isinstance(results[2], Exception) else {},
            "taker_flow":           results[3] if not isinstance(results[3], Exception) else {},
            "oi_velocity_divergence": results[4] if not isinstance(results[4], Exception) else {},
        }
