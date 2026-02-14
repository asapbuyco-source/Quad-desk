
import { CandleData, RegimeType, MarketRegimeType } from '../types';

/**
 * Calculates the Average Directional Index (ADX) using Wilder's Smoothing technique.
 * Time Complexity: O(N) - Single pass calculation
 */
export const calculateADX = (data: CandleData[], period = 14): CandleData[] => {
    const length = data.length;
    if (length < period * 2) return data;

    // Pre-allocate arrays for performance
    const trs = new Float64Array(length);
    const plusDMs = new Float64Array(length);
    const minusDMs = new Float64Array(length);
    const adxValues = new Float64Array(length);

    // 1. Calculate TR, +DM, -DM (Single Pass)
    for (let i = 1; i < length; i++) {
        const curr = data[i];
        const prev = data[i - 1];

        const high = curr.high;
        const low = curr.low;
        const prevClose = prev.close;

        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs[i] = tr;

        const upMove = high - prev.high;
        const downMove = prev.low - low;

        if (upMove > downMove && upMove > 0) {
            plusDMs[i] = upMove;
        }
        if (downMove > upMove && downMove > 0) {
            minusDMs[i] = downMove;
        }
    }

    // 2. Wilder's Smoothing & DX Calculation
    let smoothTR = 0;
    let smoothPlusDM = 0;
    let smoothMinusDM = 0;

    // Initial SMA for first 'period'
    for (let i = 1; i <= period; i++) {
        smoothTR += trs[i];
        smoothPlusDM += plusDMs[i];
        smoothMinusDM += minusDMs[i];
    }

    // Process the rest
    const dxValues = new Float64Array(length);
    for (let i = period; i < length; i++) {
        if (i > period) {
            smoothTR = smoothTR - (smoothTR / period) + trs[i];
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMs[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMs[i];
        }

        // GUARD: Prevent division by zero if volatility is extremely low
        const effectiveTR = Math.max(smoothTR, 0.0001);

        const plusDI = (smoothPlusDM / effectiveTR) * 100;
        const minusDI = (smoothMinusDM / effectiveTR) * 100;
        const sum = plusDI + minusDI;
        
        dxValues[i] = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
    }

    // 3. Calculate ADX
    let smoothDX = 0;
    // First ADX is average of N DXs
    for (let i = period; i < period * 2; i++) {
        smoothDX += dxValues[i];
    }
    smoothDX /= period;

    const adxStart = period * 2;
    // Fill previous values to avoid holes if needed, or leave 0
    adxValues[adxStart - 1] = smoothDX; 

    for (let i = adxStart; i < length; i++) {
        smoothDX = ((smoothDX * (period - 1)) + dxValues[i]) / period;
        adxValues[i] = smoothDX;
    }

    // Merge back into objects
    return data.map((c, i) => ({
        ...c,
        adx: adxValues[i]
    }));
};

/**
 * Calculates Relative Strength Index (RSI) using Wilder's Smoothing.
 * Used as a proxy for Retail Sentiment.
 */
export const calculateRSI = (prices: number[], period = 14): number => {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // 1. Initial SMA
    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // 2. Smoothed averages
    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        let g = 0; 
        let l = 0;
        
        if (change > 0) g = change;
        else l = -change;
        
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
    }

    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

/**
 * Detects the current market regime based on ADX, Volume, and Z-Score behavior.
 */
export const detectMarketRegime = (data: CandleData[]): RegimeType => {
    if (data.length < 20) return 'MEAN_REVERTING';

    const last = data[data.length - 1];
    const adx = last.adx || 0;
    const currentVol = last.volume;

    // Calculate Average Volume (last 20)
    let volSum = 0;
    for(let i = data.length - 20; i < data.length; i++) {
        volSum += data[i].volume;
    }
    const avgVol = volSum / 20;

    // 1. Check for High Volatility (Volume Explosion)
    // If volume is > 1.8x average, we are in a shock/volatile event
    if (currentVol > avgVol * 1.8) {
        return 'HIGH_VOLATILITY';
    }

    // 2. Check for Trending
    // Standard ADX threshold for trend is 25
    if (adx > 25) {
        return 'TRENDING';
    }

    // 3. Default to Mean Reverting (Ranging)
    return 'MEAN_REVERTING';
};

/**
 * Calculates skewness of return distribution
 */
export const calculateSkewness = (returns: number[]): number => {
    const n = returns.length;
    if (n < 3) return 0;
    
    // Calculate mean
    const mean = returns.reduce((sum, r) => sum + r, 0) / n;
    
    // Calculate variance
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    // Calculate skewness
    const skewness = returns.reduce((sum, r) => {
        return sum + Math.pow((r - mean) / stdDev, 3);
    }, 0) / n;
    
    return skewness;
};

/**
 * Calculates excess kurtosis
 */
export const calculateKurtosis = (returns: number[]): number => {
    const n = returns.length;
    if (n < 4) return 0;
    
    const mean = returns.reduce((sum, r) => sum + r, 0) / n;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    const kurtosis = returns.reduce((sum, r) => {
        return sum + Math.pow((r - mean) / stdDev, 4);
    }, 0) / n;
    
    // Return excess kurtosis (subtract 3 for normal distribution)
    return kurtosis - 3;
};

/**
 * Calculate Z-Score bands from price array
 */
export const calculateZScoreBands = (prices: number[]) => {
    if (prices.length === 0) return { upper1: 0, lower1: 0, upper2: 0, lower2: 0 };
    
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    
    return {
        upper1: mean + (1.0 * stdDev),
        lower1: mean - (1.0 * stdDev),
        upper2: mean + (2.0 * stdDev),
        lower2: mean - (2.0 * stdDev),
    };
};

/**
 * Calculates ATR manually for a subset of candles
 */
export const calculateATR = (candles: CandleData[], period = 14): number => {
    if (candles.length < period + 1) return 0;
    
    let sumTR = 0;
    // Calculate initial TRs
    for(let i = candles.length - period; i < candles.length; i++) {
        const curr = candles[i];
        const prev = candles[i-1];
        const tr = Math.max(
            curr.high - curr.low,
            Math.abs(curr.high - prev.close),
            Math.abs(curr.low - prev.close)
        );
        sumTR += tr;
    }
    return sumTR / period;
};

interface RegimeAnalysisResult {
    type: MarketRegimeType;
    atr: number;
    rangeSize: number;
    trendDirection: "BULL" | "BEAR" | "NEUTRAL";
    volatilityPercentile: number;
}

export const analyzeRegime = (candles: CandleData[]): RegimeAnalysisResult => {
    if (candles.length < 50) return { 
        type: 'UNCERTAIN', atr: 0, rangeSize: 0, trendDirection: 'NEUTRAL', volatilityPercentile: 0 
    };

    const period = 14;
    const recent = candles.slice(-period);
    const currentATR = calculateATR(candles, period);
    
    // Calculate Long-term ATR Avg (last 50) to gauge relative volatility
    const longTermATR = calculateATR(candles, 50);
    const volatilityPercentile = Math.min(100, (currentATR / (longTermATR || 1)) * 50);

    // Identify Trend
    const sma20 = candles.slice(-20).reduce((acc, c) => acc + c.close, 0) / 20;
    const price = candles[candles.length - 1].close;
    const isBull = price > sma20;
    
    // Range Calculation
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const maxH = Math.max(...highs);
    const minL = Math.min(...lows);
    const rangeSize = maxH - minL;

    // Previous range (to detect expansion/compression)
    const prevHighs = candles.slice(-period * 2, -period).map(c => c.high);
    const prevLows = candles.slice(-period * 2, -period).map(c => c.low);
    const prevRangeSize = Math.max(...prevHighs) - Math.min(...prevLows);

    let type: MarketRegimeType = 'RANGING';
    let trendDirection: "BULL" | "BEAR" | "NEUTRAL" = 'NEUTRAL';

    // Logic Tree
    if (currentATR > longTermATR * 1.1) {
        // High Volatility State
        if (Math.abs(price - sma20) > currentATR * 2) {
            type = 'TRENDING';
            trendDirection = isBull ? 'BULL' : 'BEAR';
        } else if (rangeSize > prevRangeSize * 1.2) {
            type = 'EXPANDING';
        } else {
            type = 'RANGING'; // High vol chop
        }
    } else {
        // Low Volatility State
        if (rangeSize < prevRangeSize * 0.8) {
            type = 'COMPRESSING';
        } else {
            type = 'RANGING';
        }
    }

    // Refinement: If clear ADX trend
    if ((candles[candles.length-1].adx || 0) > 25) {
        type = 'TRENDING';
        trendDirection = isBull ? 'BULL' : 'BEAR';
    }

    return {
        type,
        atr: currentATR,
        rangeSize,
        trendDirection,
        volatilityPercentile
    };
};
