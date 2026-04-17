import os
import json
import asyncio
import logging
from dotenv import load_dotenv

# Set up logging to console
logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)s | %(message)s')
logger = logging.getLogger("debug_connectivity")

# 1. Load Environment
load_dotenv()

async def test_binance():
    logger.info("--- Testing Binance USDM Futures Connectivity ---")
    api_key = os.environ.get("BINANCE_API_KEY")
    api_secret = os.environ.get("BINANCE_API_SECRET") or os.environ.get("BINANCE_ED25519_PRIVATE_KEY")
    exchange_id = os.environ.get("BOT_EXCHANGE", "binanceusdm")
    testnet = os.environ.get("BOT_TESTNET", "false").lower() != "false"

    if not api_key or not api_secret:
        logger.error("❌ BINANCE_API_KEY or secret missing in .env")
        return

    from bot.executor import TradingExecutor
    import ccxt.async_support as ccxt
    try:
        # We test the static method fix directly
        exchange = TradingExecutor._init_binance(api_key, api_secret, testnet, exchange_id)
        
        # [DEBUG] Force CCXT to only fetch futures to avoid -2015 on margin endpoints
        exchange.options['fetchMarkets'] = ['future']
        
        logger.info(f"Connecting to Binance ({exchange_id})...")
        await exchange.load_markets()
        
        logger.info("Fetching balance...")
        balance = await exchange.fetch_balance()
        
        usdc_free = balance.get('USDC', {}).get('free', 0)
        usdt_free = balance.get('USDT', {}).get('free', 0)
        
        logger.info(f"✅ Connection Successful!")
        logger.info(f"💰 USDT Balance: {usdt_free}")
        logger.info(f"💰 USDC Balance: {usdc_free}")
        
        await exchange.close()
    except Exception as e:
        logger.error(f"❌ Binance Test Failed: {e}")
        # Try a simpler call that doesn't load markets
        try:
             logger.info("Retrying with direct fapi fetch (no load_markets)...")
             # Re-init without broad load
             exchange = TradingExecutor._init_binance(api_key, api_secret, testnet, exchange_id)
             res = await exchange.fapiPrivateGetAccount()
             logger.info("✅ Direct fapiPrivateGetAccount Successful! The API Key is GOOD for Futures.")
             await exchange.close()
        except Exception as e2:
             logger.error(f"❌ Direct FAPI fetch also failed: {e2}")

async def test_firebase():
    logger.info("\n--- Testing Firebase Connectivity & PEM Debug ---")
    cred_json = os.environ.get("FIREBASE_ADMIN_CREDENTIALS", "").strip()
    if not cred_json:
        logger.error("❌ FIREBASE_ADMIN_CREDENTIALS missing")
        return

    logger.info(f"Raw Cred length: {len(cred_json)}")
    try:
        cred_dict = json.loads(cred_json)
        raw_key = cred_dict.get("private_key", "")
        logger.info(f"Raw Key start: {raw_key[:50]}...")
        
        from bot.heartbeat import _normalize_pem, init_firebase
        normalized = _normalize_pem(raw_key)
        logger.info("--- Normalized PEM Preview ---")
        lines = normalized.splitlines()
        for i, l in enumerate(lines):
            if i < 2 or i > len(lines) - 3:
                logger.info(f"Line {i}: {l}")
            elif i == 2:
                logger.info("... body ...")
        
        logger.info(f"Normalized length: {len(normalized)}")
        
        # Test loading directly via firebase_admin
        import firebase_admin
        from firebase_admin import credentials
        if firebase_admin._apps:
            for app in list(firebase_admin._apps.values()):
                firebase_admin.delete_app(app)
        
        cred_dict["private_key"] = normalized
        cred = credentials.Certificate(cred_dict)
        firebase_admin.initialize_app(cred)
        logger.info("✅ Firebase initialized successfully in debug script!")
        
    except Exception as e:
        logger.error(f"❌ Firebase Debug Failed: {e}")

async def main():
    await test_firebase()
    await test_binance()

if __name__ == "__main__":
    asyncio.run(main())
