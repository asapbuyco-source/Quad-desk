import os
import ccxt.async_support as ccxt
import asyncio
from dotenv import load_dotenv

load_dotenv()

async def check_ed25519():
    api_key = os.environ.get("BINANCE_API_KEY")
    # Using the key the user provided in the context
    ed25519_priv = (
        "-----BEGIN PRIVATE KEY-----\n"
        "MC4CAQAwBQYDK2VwBCIEIAGWty648nzz75R4OaTdfLsQq006Nn7t/AaTVWWBuZln\n"
        "-----END PRIVATE KEY-----\n"
    )
    
    if not api_key:
        print("[ERROR] BINANCE_API_KEY not found in .env")
        return

    print(f"Testing API Key: {api_key[:10]}...")
    print("Using Ed25519 Private Key signature...")
    
    # Initialize with specialized options to prevent Spot/Margin leakage
    exchange = ccxt.binanceusdm({
        "apiKey": api_key,
        "secret": ed25519_priv,
        "enableRateLimit": True,
        "options": {
            "defaultType": "future",
            "fetchMarkets": ["future"], # Fix: Only fetch futures markets
        }
    })
    
    # Critical: Disable margin checks that hit api.binance.com (SAPI)
    exchange.has['fetchMarginAllPairs'] = False
    exchange.has['fetchFundingHistory'] = False
    
    try:
        print("\n1. Testing Connectivity (Ping)...")
        # We try to fetch something simple that doesn't require full market load if possible
        # but fetch_balance usually requires it. Let's try to load only what we need.
        await exchange.load_markets()
        print("✓ Connectivity confirmed")
        
        print("\n2. Testing Authentication (Fetch Balance)...")
        # This will trigger an authenticated request to fapi.binance.com
        balance = await exchange.fetch_balance()
        print("✓ SUCCESS! Ed25519 key is valid and authenticated.")
        
        # Check permissions by seeing if we can see USDC
        free = balance.get("free", {})
        usdc = free.get("USDC", 0.0)
        usdt = free.get("USDT", 0.0)
        print(f"   Balances: USDC={usdc} | USDT={usdt}")
        
    except ccxt.AuthenticationError as e:
        print("\n[!] AUTHENTICATION ERROR (-2015):")
        print(e)
        print("\nDiagnosis: The API Key and Private Key do NOT match, or the key was deleted on Binance.")
    except ccxt.PermissionDenied as e:
        print("\n[!] PERMISSION ERROR:")
        print(e)
        print("\nDiagnosis: The key is authenticated but does not have 'Enable Futures' checked.")
    except Exception as e:
        print(f"\n[!] UNEXPECTED ERROR: {type(e).__name__}")
        print(e)
    finally:
        await exchange.close()

if __name__ == "__main__":
    asyncio.run(check_ed25519())
