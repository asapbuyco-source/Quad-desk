
/**
 * Maps internal system symbols (Binance format) to Coinbase Pro format.
 * Example: BTCUSDT -> BTC-USD
 */
export const toCoinbaseSymbol = (symbol: string): string => {
    // Handle standard cases
    if (symbol.endsWith('USDT')) {
        return `${symbol.replace('USDT', '')}-USD`; // Coinbase uses USD pairs mostly
    }
    if (symbol.endsWith('USD')) {
        return `${symbol.replace('USD', '')}-USD`;
    }
    
    // Fallback/Direct mapping
    return symbol;
};

/**
 * Maps Coinbase intervals to milliseconds for candle aggregation.
 */
export const getIntervalMs = (interval: string): number => {
    switch (interval) {
        case '1m': return 60 * 1000;
        case '5m': return 5 * 60 * 1000;
        case '15m': return 15 * 60 * 1000;
        case '1h': return 60 * 60 * 1000;
        case '4h': return 4 * 60 * 60 * 1000;
        case '1d': return 24 * 60 * 60 * 1000;
        default: return 60 * 1000;
    }
};
