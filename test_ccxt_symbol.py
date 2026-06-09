import os

import pytest


pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_NETWORK_TESTS") != "1",
    reason="set RUN_NETWORK_TESTS=1 to call Binance during this test",
)


@pytest.mark.asyncio
async def test_binanceusdm_symbol_mapping():
    import ccxt.async_support as ccxt

    ex = ccxt.binanceusdm()
    try:
        await ex.load_markets()
        assert "BTC/USDT:USDT" in ex.markets
    finally:
        await ex.close()
