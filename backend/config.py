import os

class Config:
    # Binance Base URLs (Default to US, override via Env for Global/EU regions)
    # Use "https://api.binance.com/api/v3" and "wss://stream.binance.com:9443/ws" for non-US
    REST_URL = os.getenv("BINANCE_REST_URL", "https://api.binance.us/api/v3")
    WS_URL = os.getenv("BINANCE_WS_URL", "wss://stream.binance.us:9443/ws")
    
    # Trading Pairs to Track (Surveillance Universe)
    SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
    
    # Intervals required for various features:
    # 1m: Charts & High Frequency Analysis
    # 15m: AI Structural Analysis
    # 1h: Heatmap & Z-Score calculation
    INTERVALS = ["1m", "15m", "1h"]
    
    # Data Storage Limits
    HISTORY_LIMIT = 300  # Keep last 300 candles in memory