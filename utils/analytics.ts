import { CandleData, MarketRegimeType, SweepEvent, BreakOfStructure, FairValueGap } from '../types';

export const generateMockCandles = (count: number, startPrice: number = 65000, intervalSeconds: number = 60): CandleData[] => {
    // Legacy mock function - kept for fallback/testing
    let currentPrice = startPrice;
    const now = Math.floor(Date.now() / 1000);
    let currentTime = now - (count * intervalSeconds);
    const candles: CandleData[] = [];
    
    for (let i = 0; i < count; i++) {
        const time = currentTime + (i * intervalSeconds);
        const change = (Math.random() - 0.5) * currentPrice * 0.002;
        const open = currentPrice;
        const close = currentPrice + change;
        const high = Math.max(open, close) + Math.random() * 10;
        const low = Math.min(open, close) - Math.random() * 10;
        
        candles.push({
            time, open, high, low, close, volume: 100 + Math.random() * 500,
            zScoreUpper1: 0, zScoreLower1: 0, zScoreUpper2: 0, zScoreLower2: 0,
            adx: 25, delta: 0, cvd: 0
        });
        currentPrice = close;
    }
    return candles;
};

// --- Mathematical Indicators ---

export const calculateBollingerBands = (data: CandleData[], period = 20, multiplier1 = 1.0, multiplier2 = 2.0): CandleData[] => {
    if (data.length < period) return data;

    const result = [...data];
    
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            // Not enough data yet
            result[i].zScoreUpper1 = data[i].close;
            result[i].zScoreLower1 = data[i].close;
            result[i].zScoreUpper2 = data[i].close;
            result[i].zScoreLower2 = data[i].close;
            continue;
        }

        const slice = data.slice(i - period + 1, i + 1);
        const closes = slice.map(c => c.close);
        const mean = closes.reduce((acc, val) => acc + val, 0) / period;
        
        const squaredDiffs = closes.map(c => Math.pow(c - mean, 2));
        const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / period;
        const stdDev = Math.sqrt(variance);

        result[i].zScoreUpper1 = mean + (stdDev * multiplier1);
        result[i].zScoreLower1 = mean - (stdDev * multiplier1);
        result[i].zScoreUpper2 = mean + (stdDev * multiplier2);
        result[i].zScoreLower2 = mean - (stdDev * multiplier2);
    }
    return result;
};

export const calculateADX = (data: CandleData[], period = 14): CandleData[] => {
    const length = data.length;
    if (length < period * 2) return data;

    const trs = new Float64Array(length);
    const plusDMs = new Float64Array(length);
    const minusDMs = new Float64Array(length);
    const adxValues = new Float64Array(length);

    for (let i = 1; i < length; i++) {
        const curr = data[i];
        const prev = data[i - 1];
        const high = curr.high;
        const low = curr.low;
        const prevClose = prev.close;

        trs[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        const upMove = high - prev.high;
        const downMove = prev.low - low;

        if (upMove > downMove && upMove > 0) plusDMs[i] = upMove;
        if (downMove > upMove && downMove > 0) minusDMs[i] = downMove;
    }

    let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
    for (let i = 1; i <= period; i++) {
        smoothTR += trs[i];
        smoothPlusDM += plusDMs[i];
        smoothMinusDM += minusDMs[i];
    }

    const dxValues = new Float64Array(length);
    for (let i = period; i < length; i++) {
        if (i > period) {
            smoothTR = smoothTR - (smoothTR / period) + trs[i];
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMs[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMs[i];
        }
        const effectiveTR = Math.max(smoothTR, 0.0001);
        const plusDI = (smoothPlusDM / effectiveTR) * 100;
        const minusDI = (smoothMinusDM / effectiveTR) * 100;
        const sum = plusDI + minusDI;
        dxValues[i] = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
    }

    let smoothDX = 0;
    for (let i = period; i < period * 2; i++) smoothDX += dxValues[i];
    smoothDX /= period;
    adxValues[period * 2 - 1] = smoothDX; 

    for (let i = period * 2; i < length; i++) {
        smoothDX = ((smoothDX * (period - 1)) + dxValues[i]) / period;
        adxValues[i] = smoothDX;
    }

    return data.map((c, i) => ({ ...c, adx: adxValues[i] }));
};

export const calculateRSI = (prices: number[], period = 14): number => {
    if (prices.length < period + 1) return 50; // Fallback
    
    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change; else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const g = change > 0 ? change : 0;
        const l = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

export const calculateATR = (candles: CandleData[], period = 14): number => {
    if (candles.length < period + 1) return 0;
    const trs: number[] = [];
    for(let i = 1; i < candles.length; i++) {
        const curr = candles[i], prev = candles[i-1];
        trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    }
    if (trs.length < period) return 0;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
    return atr;
};

// --- Liquidity Logic ---

export const analyzeLiquidity = (candles: CandleData[]) => {
    const sweeps: SweepEvent[] = [];
    const bos: BreakOfStructure[] = [];
    const fvg: FairValueGap[] = [];
    
    if (candles.length < 50) return { sweeps, bos, fvg };

    // 1. Detect Local Pivots (Highs/Lows) with lookback 5
    const lookback = 5;
    const pivots: { index: number, price: number, type: 'HIGH' | 'LOW' }[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
        const current = candles[i];
        let isHigh = true;
        let isLow = true;

        for (let j = 1; j <= lookback; j++) {
            if (candles[i-j].high > current.high || candles[i+j].high > current.high) isHigh = false;
            if (candles[i-j].low < current.low || candles[i+j].low < current.low) isLow = false;
        }

        if (isHigh) pivots.push({ index: i, price: current.high, type: 'HIGH' });
        if (isLow) pivots.push({ index: i, price: current.low, type: 'LOW' });
    }

    // 2. Detect Sweeps and BOS based on Pivots
    // Scan recent candles (last 20) against prior pivots
    const recentStart = candles.length - 20;
    for (let i = recentStart; i < candles.length; i++) {
        const c = candles[i];
        
        // Check against past pivots
        pivots.forEach(p => {
            if (p.index >= i) return; // Ignore future/current pivots

            // Sweep High Logic: Price breaks High but closes below it
            if (p.type === 'HIGH') {
                if (c.high > p.price && c.close < p.price) {
                    sweeps.push({ 
                        id: `sw-h-${i}`, price: p.price, side: 'BUY', timestamp: i, candleTime: c.time 
                    });
                }
                // BOS Bullish Logic: Price breaks High and closes above it
                else if (c.close > p.price && c.open < p.price) { // simplified crossover check
                     bos.push({ 
                         id: `bos-h-${i}`, price: p.price, direction: 'BULLISH', timestamp: i, candleTime: c.time 
                     });
                }
            }

            // Sweep Low Logic: Price breaks Low but closes above it
            if (p.type === 'LOW') {
                if (c.low < p.price && c.close > p.price) {
                    sweeps.push({ 
                        id: `sw-l-${i}`, price: p.price, side: 'SELL', timestamp: i, candleTime: c.time 
                    });
                }
                // BOS Bearish
                else if (c.close < p.price && c.open > p.price) {
                    bos.push({ 
                        id: `bos-l-${i}`, price: p.price, direction: 'BEARISH', timestamp: i, candleTime: c.time 
                    });
                }
            }
        });
    }

    // 3. Detect FVGs (Last 50 candles)
    for (let i = candles.length - 50; i < candles.length - 1; i++) {
        if (i < 2) continue;
        const prev = candles[i-1];
        const next = candles[i+1];
        const curr = candles[i];

        // Bullish FVG: prev.high < next.low
        if (prev.high < next.low) {
            fvg.push({
                id: `fvg-bull-${i}`, startPrice: prev.high, endPrice: next.low, direction: 'BULLISH', 
                resolved: curr.low <= prev.high, timestamp: i, candleTime: curr.time
            });
        }
        // Bearish FVG: prev.low > next.high
        if (prev.low > next.high) {
            fvg.push({
                id: `fvg-bear-${i}`, startPrice: prev.low, endPrice: next.high, direction: 'BEARISH', 
                resolved: curr.high >= prev.low, timestamp: i, candleTime: curr.time
            });
        }
    }

    // Filter duplicates and return distinct events (latest first)
    return {
        sweeps: sweeps.reverse().slice(0, 10),
        bos: bos.reverse().slice(0, 10),
        fvg: fvg.reverse().slice(0, 10)
    };
};

export const analyzeRegime = (candles: CandleData[]) => {
    if (candles.length < 50) return { type: 'UNCERTAIN', atr: 0, rangeSize: 0, trendDirection: 'NEUTRAL', volatilityPercentile: 0 };
    const currentATR = calculateATR(candles, 14);
    const longTermATR = calculateATR(candles, 50);
    const volatilityRatio = longTermATR > 0 ? currentATR / longTermATR : 1;
    const volatilityPercentile = Math.min(100, Math.max(0, volatilityRatio * 50));
    const sma20 = candles.slice(-20).reduce((acc, c) => acc + c.close, 0) / 20;
    const price = candles[candles.length - 1].close;
    const isBull = price > sma20;
    const recent = candles.slice(-14);
    const rangeSize = Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low));
    const prevRange = candles.slice(-28, -14);
    const prevRangeSize = Math.max(...prevRange.map(c => c.high)) - Math.min(...prevRange.map(c => c.low));

    let type: MarketRegimeType = 'RANGING';
    let trendDirection: "BULL" | "BEAR" | "NEUTRAL" = 'NEUTRAL';

    if (volatilityRatio > 1.1) {
        if (Math.abs(price - sma20) > currentATR * 2) {
            type = 'TRENDING';
            trendDirection = isBull ? 'BULL' : 'BEAR';
        } else if (rangeSize > prevRangeSize * 1.2) type = 'EXPANDING';
    } else if (rangeSize < prevRangeSize * 0.8) type = 'COMPRESSING';

    if ((candles[candles.length-1].adx || 0) > 25) {
        type = 'TRENDING';
        trendDirection = isBull ? 'BULL' : 'BEAR';
    }
    return { type, atr: currentATR, rangeSize, trendDirection, volatilityPercentile };
};