import ccxt
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
logger = logging.getLogger("PreFlight")

def main():
    logger.info("Running pre-flight region and network check...")
    
    # Initialize the exchange strictly to check connectivity and region IP status
    # We do not need API keys just to load public markets.
    try:
        exchange = ccxt.binanceusdm({
            'enableRateLimit': True,
            'timeout': 15000,
        })
        
        logger.info("Attempting to load Binance USDM markets to verify region...")
        exchange.load_markets()
        
        logger.info("✅ SUCCESS: Successfully connected to Binance USDM.")
        logger.info("✅ SUCCESS: The current server region IP is ALLOWED by Binance.")
        sys.exit(0)
        
    except Exception as e:
        error_str = str(e).lower()
        if "451" in error_str or "restricted location" in error_str or "unavailable from a restricted location" in error_str:
            logger.error("❌ CRITICAL ERROR: The server is located in a restricted region (e.g., USA).")
            logger.error("❌ Binance responded with HTTP 451: Service unavailable from a restricted location.")
            logger.error("❌ FIX: Go to your Railway Dashboard -> Service -> Settings -> Region, and change it to Europe (Amsterdam: eu-west-1).")
            # Exit with 1 to crash the deploy so it doesn't run silently and fail later.
            sys.exit(1)
        else:
            logger.error(f"❌ CRITICAL ERROR: Failed to connect to Binance. Details: {str(e)}")
            sys.exit(1)

if __name__ == "__main__":
    main()
