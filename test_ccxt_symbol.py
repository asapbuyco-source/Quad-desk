import asyncio
import ccxt.async_support as ccxt
async def main():
    ex = ccxt.binanceusdm()
    await ex.load_markets()
    print("BTC/USDT in markets?", 'BTC/USDT' in ex.markets)
    print("BTC/USDT:USDT in markets?", 'BTC/USDT:USDT' in ex.markets)
    await ex.close()
asyncio.run(main())
