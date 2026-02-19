
/**
 * Maps internal system symbols (Binance format) to Kraken format.
 * Kraken often uses XBT for Bitcoin and slashes for pairs in WebSockets.
 * 
 * Internal: BTCUSDT
 * Kraken WS: XBT/USDT
 * Kraken REST: XBTUSDT
 */
export const toKrakenSymbol = (symbol: string, forRest: boolean = false): string => {
    let base = "";
    let quote = "";

    // 1. Identify Base Asset
    if (symbol.startsWith("BTC")) base = "XBT";
    else if (symbol.startsWith("ETH")) base = "ETH";
    else if (symbol.startsWith("SOL")) base = "SOL";
    else base = symbol.substring(0, 3); // Fallback

    // 2. Identify Quote Asset
    if (symbol.endsWith("USDT")) quote = "USDT";
    else if (symbol.endsWith("USD")) quote = "USD";
    else quote = "USD"; // Fallback

    // 3. Format
    if (forRest) {
        return `${base}${quote}`; // e.g., XBTUSDT
    }
    return `${base}/${quote}`; // e.g., XBT/USDT
};

/**
 * Maps interval strings to Kraken minute integers.
 */
export const getKrakenInterval = (interval: string): number => {
    switch (interval) {
        case '1m': return 1;
        case '5m': return 5;
        case '15m': return 15;
        case '1h': return 60;
        case '4h': return 240;
        case '1d': return 1440;
        default: return 1;
    }
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
