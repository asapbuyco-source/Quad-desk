
/**
 * Binance Symbol & Interval Utilities
 * 
 * Binance uses its own symbol format natively (e.g., BTCUSDT),
 * so no conversion is needed — these utilities handle validation
 * and interval mapping for both REST and WebSocket endpoints.
 */

/** 
 * Validates that a symbol is in Binance format (e.g., BTCUSDT).
 * Returns the symbol uppercased.
 */
export const toBinanceSymbol = (symbol: string): string => {
    return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
};

/**
 * Binance REST interval strings — identical to our internal format.
 * Validated list to prevent invalid API calls.
 */
const VALID_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);

export const toBinanceInterval = (interval: string): string => {
    return VALID_INTERVALS.has(interval) ? interval : '1m';
};

/**
 * Maps interval strings to their duration in milliseconds.
 * Used for time calculations and chart window sizing.
 */
export const getIntervalMs = (interval: string): number => {
    switch (interval) {
        case '1m': return 60 * 1000;
        case '3m': return 3 * 60 * 1000;
        case '5m': return 5 * 60 * 1000;
        case '15m': return 15 * 60 * 1000;
        case '30m': return 30 * 60 * 1000;
        case '1h': return 60 * 60 * 1000;
        case '2h': return 2 * 60 * 60 * 1000;
        case '4h': return 4 * 60 * 60 * 1000;
        case '6h': return 6 * 60 * 60 * 1000;
        case '8h': return 8 * 60 * 60 * 1000;
        case '12h': return 12 * 60 * 60 * 1000;
        case '1d': return 24 * 60 * 60 * 1000;
        case '3d': return 3 * 24 * 60 * 60 * 1000;
        case '1w': return 7 * 24 * 60 * 60 * 1000;
        default: return 60 * 1000;
    }
};

/**
 * Returns the Binance WebSocket multi-stream URL for a given symbol and interval.
 * Combines kline, trade, and depth streams.
 */
export const getBinanceWsUrl = (symbol: string, interval: string): string => {
    const s = toBinanceSymbol(symbol).toLowerCase();
    const i = toBinanceInterval(interval);
    const streams = [`${s}@kline_${i}`, `${s}@trade`, `${s}@depth20@100ms`].join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
};

/**
 * Returns the Binance.US WebSocket multi-stream URL.
 * Use this if your backend/proxy is in the US.
 * Client-side connections typically use the global stream above.
 */
export const getBinanceUSWsUrl = (symbol: string, interval: string): string => {
    const s = toBinanceSymbol(symbol).toLowerCase();
    const i = toBinanceInterval(interval);
    const streams = [`${s}@kline_${i}`, `${s}@trade`, `${s}@depth20@100ms`].join('/');
    return `wss://stream.binance.us:9443/stream?streams=${streams}`;
};
