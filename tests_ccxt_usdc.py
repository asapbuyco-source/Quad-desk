import ccxt
exchange = ccxt.binanceusdm()
markets = exchange.load_markets()

# Filter for anything with BTC and USDC
usdc_markets = [m['symbol'] for m in markets.values() if 'BTC' in m['symbol'] and 'USDC' in m['symbol']]
print("USDC Markets:", usdc_markets)

# Check specifically for perpetuals
perps = [m['symbol'] for m in markets.values() if m.get('linear') and m['quote'] == 'USDC' and m['base'] == 'BTC']
print("USDC Perps:", perps)
