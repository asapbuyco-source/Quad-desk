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
    
    try:
        ticker = await executor.exchange.fetch_ticker(symbol)
        price = ticker['last']
        logger.info(f"Current {symbol} price: ${price:.2f}")
        
        # Test order (limit buy 1 cent at $10.00 BTC - will be rejected for min size or placed/cancelled immediately)
        test_price = 10.0
        test_amount = 0.00001
        
        logger.info(f"Attempting to create generic limit order for {test_amount} at ${test_price} to test permissions...")
        try:
            order = await executor.exchange.create_order(
                symbol=symbol,
                type='limit',
                side='buy',
                amount=test_amount,
                price=test_price
            )
            logger.info(f"Order Placed Successfully! (ID: {order['id']}). Cancelling immediately...")
            await executor.exchange.cancel_order(order['id'], symbol)
            logger.info("Order Cancelled ✓ All Trade Permissions are active and working perfectly!")
        except Exception as order_error:
            err_msg = str(order_error)
            if "size is too small" in err_msg.lower() or "minimum" in err_msg.lower():
                logger.info("API Key successfully authenticated to the trade endpoint! (Rejected purely due to test-size limit, which proves keys work).")
            elif "too far from" in err_msg.lower():
                logger.info("API Key successfully authenticated to the trade endpoint! (Rejected purely due to test-price being too low, which proves keys work).")
            else:
                logger.error(f"Order test failed: {err_msg}")
                logger.error("You may need to recreate your Coinbase API key and ensure 'Trade' permissions are checked.")
                
    except Exception as e:
        logger.error(f"Exchange interaction failed: {e}")
        
    finally:
        await executor.close()
        logger.info("Test complete.")

if __name__ == "__main__":
    asyncio.run(test_coinbase_live())
