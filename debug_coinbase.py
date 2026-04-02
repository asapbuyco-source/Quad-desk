import asyncio
import os
import traceback
import ccxt.async_support as ccxt
from dotenv import load_dotenv

async def debug():
    load_dotenv()
    name = os.getenv("COINBASE_API_KEY_NAME", "").strip()
    key = os.getenv("COINBASE_PRIVATE_KEY", "").strip().replace("\\n", "\n")
    
    exchange = ccxt.coinbase({
        'apiKey': name,
        'secret': key,
        'enableRateLimit': True,
    })
    
    # Skip V2 currencies explicitly
    exchange.has['fetchCurrencies'] = False
    
    # Force V3 mode (some versions need this)
    exchange.options['version'] = 'v3' 
    
    print("\nAttempting fetch_balance (Force V3)...")
    try:
        balance = await exchange.fetch_balance()
        print("Success!")
    except Exception:
        print("\n--- STACK TRACE ---")
        traceback.print_exc()

    await exchange.close()

if __name__ == "__main__":
    asyncio.run(debug())
