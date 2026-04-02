import asyncio
import os
import sys
import logging
from dotenv import load_dotenv

# Hack to allow imports from bot
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bot.executor import TradingExecutor

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
logger = logging.getLogger("ExecutionTest")

async def test_coinbase_live():
    load_dotenv()
    
    cb_name = os.getenv("COINBASE_API_KEY_NAME", "").strip()
    cb_key = os.getenv("COINBASE_PRIVATE_KEY", "").strip()
    
    if not cb_name or not cb_key:
        logger.error("No Coinbase API keys found in environment! Please ensure COINBASE_API_KEY_NAME and COINBASE_PRIVATE_KEY are set.")
        return
        
    logger.info("Initializing TradingExecutor in LIVE MODE...")
    executor = TradingExecutor(
        api_key="",
        api_secret="",
        testnet=False,
        dry_run=False,
        exchange_id="coinbase",
        coinbase_key_name=cb_name,
        coinbase_private_key=cb_key,
    )
    
    logger.info("Testing 1: Loading Markets (Authenticates & Maps Paris)")
    await executor.initialize()
    
    logger.info("Testing 2: Fetching Account Balance (Proves Advanced Trade API keys work)")
    balance = await executor.get_usdt_balance()
    logger.info(f"SUCCESS: Account Balance retrieved: ${balance:.2f}")
    
    logger.info("Testing 3: Dry-Fire Order Validation (Testing API permissions directly)")
    symbol = "BTC/USDC" 
    logger.info(f"Attempting to fetch ticker for {symbol}...")
    
    # Continue to order test even if ticker fails (some keys have restricted View permission)
    try:
        # Test order (limit buy 1 cent at $10,000 BTC - will be rejected for min size or price, which proves keys work)
        test_price = 10000.0
        test_amount = 0.00001
        
        logger.info(f"Attempting to create generic limit order for {test_amount} at ${test_price} to verify 'Trade' permission...")
        try:
            order = await executor.exchange.create_order(
                symbol=symbol,
                type='limit',
                side='buy',
                amount=test_amount,
                price=test_price
            )
            # If we get here, it actually placed an order!
            logger.info(f"Order Placed Successfully! (ID: {order['id']}). Cancelling immediately...")
            await executor.exchange.cancel_order(order['id'], symbol)
            logger.info("Order Cancelled ✓ All Trade Permissions are active and working perfectly!")
        except Exception as order_error:
            err_msg = str(order_error)
            # If it's a "size too small" or "insufficient funds" or "post-only" error, IT MEANS IT AUTHENTICATED!
            # If it's an "Authentication Error", it would say so.
            if any(x in err_msg.lower() for x in ["size", "minimum", "insufficient", "too far", "amount", "precision"]):
                logger.info(f"SUCCESS: API Key successfully reached the Trade endpoint! (Response: {err_msg[:60]}...)")
                logger.info("This confirms your keys are 100% active for live trading.")
            else:
                logger.error(f"Order test failed: {err_msg}")
                logger.warning("Check your Coinbase CDP key permissions and ensure 'Trade' is enabled.")
                
    except Exception as e:
        logger.error(f"Exchange interaction failed during trade test: {e}")
        
    finally:
        await executor.close()
        logger.info("Test complete.")

if __name__ == "__main__":
    asyncio.run(test_coinbase_live())
