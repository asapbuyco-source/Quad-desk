import httpx
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class DerivativesContext:
    """
    Fetches institutional-grade signals from free public APIs.
    All four sources are completely free — no API key required.
    Run once per candle close, cache for 5 minutes.
    """

    def __init__(self, symbol: str = "BTCUSDT"):
        self.symbol = symbol
        self._cache: dict = {}
        self._cache_ts: dict = {}
        self.CACHE_TTL = 300  # 5 minutes

    async def _fetch(self, key: str, url: str, params: dict = None) -> dict:
        now = time.time()
        if key in self._cache and (now - self._cache_ts.get(key, 0)) < self.CACHE_TTL:
            return self._cache[key]
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
            self._cache[key] = data
            self._cache_ts[key] = now
            return data
        except Exception as e:
            logger.warning(f"[Derivatives] {key} fetch failed: {e}")
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
        This is what every hedge fund uses for directional bias.
        Your bot has ZERO options awareness right now.
        """
        try:
            data = await self._fetch(
                "deribit_options",
                "https://www.deribit.com/api/v2/public/get_book_summary_by_currency",
                {"currency": "BTC", "kind": "option"}
            )
            instruments = data.get("result", [])
            if not instruments:
                return {"put_call_ratio": 1.0, "options_signal": "NEUTRAL"}

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
                options_signal = "FEAR"       # institutions buying downside protection
            elif put_call_ratio < 0.8:
                options_signal = "GREED"      # no hedging = complacent = contrarian caution
            else:
                options_signal = "NEUTRAL"

            return {
                "put_call_ratio": round(put_call_ratio, 3),
                "options_signal": options_signal,
            }
        except Exception as e:
            return {"put_call_ratio": 1.0, "options_signal": "NEUTRAL", "error": str(e)}

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
        """Fetch all four signals concurrently. Total latency = slowest single call."""
        results = await asyncio.gather(
            self.get_open_interest(),
            self.get_top_trader_positioning(),
            self.get_options_context(),
            self.get_taker_flow(),
            return_exceptions=True
        )
        return {
            "open_interest": results[0] if not isinstance(results[0], Exception) else {},
            "top_traders":   results[1] if not isinstance(results[1], Exception) else {},
            "options":       results[2] if not isinstance(results[2], Exception) else {},
            "taker_flow":    results[3] if not isinstance(results[3], Exception) else {},
        }