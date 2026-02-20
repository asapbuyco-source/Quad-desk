import { CandleData, MarketRegimeType } from '../types';

export const generateMockCandles = (count: number, startPrice: number = 65000, intervalSeconds: number = 60): CandleData[] => {
    let currentPrice = startPrice;
    const now = Math.floor(Date.now() / 1000);
    let currentTime = now - (count * intervalSeconds);
    const candles: CandleData[] = [];
    const trend = (Math.random() - 0.5) * 0.0001;

    for (let i = 0; i < count; i++) {
        const time = currentTime + (i * intervalSeconds);
        const volatility = currentPrice * 0.0015;
        const change = ((Math.random() - 0.5) * volatility) + (currentPrice * trend);
        const open = currentPrice;
        const close = currentPrice + change;
        const high = Math.max(open, close) + (Math.random() * volatility * 0.5);
        const low = Math.min(open, close) - (Math.random() * volatility * 0.5);
        const volume = Math.random() * 50 + 20;
        const mean = close;
        const std = close * 0.005;

        candles.push({
            time,
            open, high, low, close, volume,
            zScoreUpper1: mean + std,
            zScoreLower1: mean - std,
            zScoreUpper2: mean + (std * 2),
            zScoreLower2: mean - (std * 2),
            adx: Math.random() * 40 + 10,
            delta: (Math.random() - 0.5) * volume * 0.4,
            cvd: 0
        });
        currentPrice = close;
    }

    let cvd = 0;
    return candles.map(c => {
        cvd += c.delta || 0;
        return { ...c, cvd };
    });
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
    if (prices.length < period + 1) return 50;
    const epsilon = 0.0000001; // Precision safety
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

    if (avgLoss <= epsilon) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

export const calculateATR = (candles: CandleData[], period = 14): number => {
    if (candles.length < period + 1) return 0;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const curr = candles[i], prev = candles[i - 1];
        trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    }
    if (trs.length < period) return 0;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
    return atr;
};

interface RegimeAnalysisResult {
    type: MarketRegimeType;
    atr: number;
    rangeSize: number;
    trendDirection: "BULL" | "BEAR" | "NEUTRAL";
    volatilityPercentile: number;
}

export const analyzeRegime = (candles: CandleData[]): RegimeAnalysisResult => {
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
        } else if (rangeSize > prevRangeSize * 1.2) {
            type = 'EXPANDING';
        }
    } else if (rangeSize < prevRangeSize * 0.8) {
        type = 'COMPRESSING';
    } else if (volatilityRatio < 0.85 && Math.abs(price - sma20) < currentATR) {
        // Low volatility + price hugging the SMA = classical mean-reverting market
        type = 'MEAN_REVERTING';
    }

    if ((candles[candles.length - 1].adx || 0) > 25) {
        type = 'TRENDING';
        trendDirection = isBull ? 'BULL' : 'BEAR';
    }
    return { type, atr: currentATR, rangeSize, trendDirection, volatilityPercentile };
};

/**
 * calculateZScoreBands
 *
 * Computes rolling VWAP-anchored standard deviation bands over `period` candles.
 * Typical price = (H + L + C) / 3, weighted by volume.
 *
 * Bands:
 *   Upper/Lower 1 = VWAP ± 1σ  (orange/blue dashed on chart)
 *   Upper/Lower 2 = VWAP ± 2σ  (red/green solid on chart — key reversal zones)
 *
 * @param data   Array of CandleData (must include high, low, close, volume)
 * @param period Rolling window size (default 20)
 */
export const calculateZScoreBands = (data: CandleData[], period = 20): CandleData[] => {
    if (data.length < period) return data;

    return data.map((candle, i) => {
        if (i < period - 1) {
            // Not enough history yet — keep zeroes so the chart filters them out
            return candle;
        }

        const window = data.slice(i - period + 1, i + 1);

        // Typical price per bar: (H + L + C) / 3
        const typicals = window.map(c => (c.high + c.low + c.close) / 3);

        // Volume-weighted average price (VWAP) over the window
        let vwapNum = 0;
        let vwapDen = 0;
        for (let j = 0; j < window.length; j++) {
            const vol = window[j].volume || 1; // Guard against 0-volume bars
            vwapNum += typicals[j] * vol;
            vwapDen += vol;
        }
        const vwap = vwapDen > 0 ? vwapNum / vwapDen : typicals[typicals.length - 1];

        // Population standard deviation of typical prices in the window
        const mean = typicals.reduce((a, b) => a + b, 0) / typicals.length;
        const variance = typicals.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / typicals.length;
        const std = Math.sqrt(variance);

        return {
            ...candle,
            zScoreUpper1: vwap + std,
            zScoreLower1: vwap - std,
            zScoreUpper2: vwap + 2 * std,
            zScoreLower2: vwap - 2 * std,
        };
    });
};