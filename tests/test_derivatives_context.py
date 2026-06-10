import time

import httpx
import pytest


class _RateLimitResponse:
    def raise_for_status(self):
        request = httpx.Request("GET", "https://fapi.binance.com/test")
        response = httpx.Response(418, request=request, json={"code": -1003, "msg": "Too many requests"})
        raise httpx.HTTPStatusError("418 I'm a teapot Too Many Requests -1003", request=request, response=response)


class _RateLimitClient:
    def __init__(self):
        self.calls = 0

    async def get(self, url, params=None):
        self.calls += 1
        return _RateLimitResponse()


@pytest.mark.asyncio
async def test_derivatives_rate_limit_uses_stale_cache_and_cools_down():
    from bot.derivatives_context import DerivativesContext

    ctx = DerivativesContext(symbol="ETHUSDT")
    ctx._client = _RateLimitClient()
    ctx._cache["top_trader_ls"] = [{"longAccount": "0.55"}]
    ctx._cache_ts["top_trader_ls"] = time.time() - 999

    first = await ctx._fetch("top_trader_ls", "https://fapi.binance.com/test")
    assert first == [{"longAccount": "0.55"}]
    assert ctx._rate_limited_until > time.time()
    assert ctx._client.calls == 1

    second = await ctx._fetch("taker_flow", "https://fapi.binance.com/test")
    assert second == {}
    assert ctx._client.calls == 1
