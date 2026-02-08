import { CandleData } from '../types';

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
 * Generates synthetic candlestick data for simulation or fallback scenarios.
 */
export const generateSyntheticData = (startPrice = 42000, count = 300): CandleData[] => {
    let price = startPrice;
    const data: CandleData[] = [];
    const now = Math.floor(Date.now() / 1000);
    
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

        data.push({
            time: time,
            open: price,
            high: finalHigh,
            low: finalLow,
            close: close,
            volume: 500 + Math.abs(move) * 10,
            zScoreUpper1: close * 1.01,
            zScoreLower1: close * 0.99,
            zScoreUpper2: close * 1.02,
            zScoreLower2: close * 0.98,
        });
        price = close;
    }
    return calculateADX(data);
};
