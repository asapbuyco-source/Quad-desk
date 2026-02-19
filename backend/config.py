import os

class Config:
    # Binance US Base URLs (US Compliant)
    REST_URL = "https://api.binance.us/api/v3"
    WS_URL = "wss://stream.binance.us:9443/ws"
    
    # Trading Pairs to Track (Surveillance Universe)
    SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
    
    # Intervals required for various features:
    # 1m: Charts & High Frequency Analysis
    # 15m: AI Structural Analysis
    # 1h: Heatmap & Z-Score calculation
    INTERVALS = ["1m", "15m", "1h"]
    
    # Data Storage Limits
    HISTORY_LIMIT = 300  # Keep last 300 candles in memory
