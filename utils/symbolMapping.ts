
/**
 * Maps internal system symbols to Binance US format.
 * 
 * Internal: BTCUSDT
 * Binance WS: btcusdt (lowercase)
 * Binance REST: BTCUSDT (uppercase)
 */
export const toBinanceSymbol = (symbol: string, forStream: boolean = false): string => {
    // Binance US uses standard pairs. 
    // WebSocket streams require lowercase (e.g., btcusdt)
    // REST API requires uppercase (e.g., BTCUSDT)
    if (forStream) {
        return symbol.toLowerCase();
    }
    return symbol.toUpperCase();
};

/**
 * Validates if a timeframe is supported by Binance US
 */
export const isValidBinanceInterval = (interval: string): boolean => {
    const valid = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
    return valid.includes(interval);
};

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
