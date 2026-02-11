import { CandleData, RegimeType } from '../types';

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
    const mean = prices.reduce((a, b) => a + b) / prices.length;
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
 * Generates synthetic candlestick data for simulation or fallback scenarios.
 * Now includes CVD (Cumulative Volume Delta) simulation.
 */
export const generateSyntheticData = (startPrice = 42000, count = 300): CandleData[] => {
    let price = startPrice;
    let runningCVD = 0;
    const data: CandleData[] = [];
    const now = Math.floor(Date.now() / 1000);
    
    // Initial pass to generate candles
    for(let i = 0; i < count; i++) {
        let trend = 0;
        // Inject some deterministic patterns for consistency
        if(i > 50 && i < 100) trend = startPrice * 0.0015; 
        if(i > 100 && i < 150) trend = -(startPrice * 0.002); 
        if(i > 150) trend = startPrice * 0.0005; 
        
        const vol = Math.random() * (startPrice * 0.002);
        const move = trend + (Math.random() - 0.5) * vol;
        const close = price + move;
        const high = Math.max(price, close) + Math.random() * (vol * 0.5);
        const low = Math.min(price, close) - Math.random() * (vol * 0.5);
        
        // Ensure high/low encapsulate open/close
        const finalHigh = Math.max(high, price, close);
        const finalLow = Math.min(low, price, close);
        
        // Reverse time calculation so index 0 is oldest
        const time = now - ((count - i) * 60);

        // Simulate Delta based on price move direction mostly, with some noise for divergence
        const totalVolume = 500 + Math.abs(move) * 10;
        const isUp = close > price;
        // Directional bias for delta
        let deltaBias = isUp ? 0.6 : 0.4;
        
        // Create Divergence occasionally
        if (i > 250 && i < 280) { // Fake absorption at end
             deltaBias = isUp ? 0.3 : 0.7; // Price moves opposite to volume pressure
        }

        const takerBuyVol = totalVolume * (deltaBias + (Math.random() * 0.1 - 0.05));
        const delta = (2 * takerBuyVol) - totalVolume; // Approximation
        runningCVD += delta;

        data.push({
            time: time,
            open: price,
            high: finalHigh,
            low: finalLow,
            close: close,
            volume: totalVolume,
            delta: delta,
            cvd: runningCVD,
            // Temporary bands, will recalculate properly
            zScoreUpper1: 0,
            zScoreLower1: 0,
            zScoreUpper2: 0,
            zScoreLower2: 0,
        });
        price = close;
    }

    // Pass to calculate ADX
    const withADX = calculateADX(data);

    // Final Pass: Apply proper Z-Score Bands based on window
    return withADX.map((c, i, arr) => {
        const window = arr.slice(Math.max(0, i - 20), i + 1).map(c => c.close);
        const bands = calculateZScoreBands(window);
        return {
            ...c,
            zScoreUpper1: bands.upper1,
            zScoreLower1: bands.lower1,
            zScoreUpper2: bands.upper2,
            zScoreLower2: bands.lower2,
        };
    });
};