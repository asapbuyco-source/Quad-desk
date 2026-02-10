import { create } from 'zustand';
import { MarketMetrics, CandleData, OrderBookLevel, TradeSignal, PriceLevel, RecentTrade, AiScanResult, ToastMessage } from '../types';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, MOCK_LEVELS } from '../constants';
import { calculateADX, detectMarketRegime } from '../utils/analytics';

interface AppState {
    ui: {
        hasEntered: boolean;
        activeTab: string;
    };
    config: {
        isBacktest: boolean;
        interval: string;
        activeSymbol: string;
        playbackSpeed: number;
        backtestDate: string;
        aiModel: string; // New: Selected AI Model
    };
    market: {
        metrics: MarketMetrics;
        candles: CandleData[];
        asks: OrderBookLevel[];
        bids: OrderBookLevel[];
        signals: TradeSignal[];
        levels: PriceLevel[];
        bands: any | null;
        runningCVD: number;
        recentTrades: RecentTrade[];
    };
    ai: {
        scanResult: AiScanResult | undefined;
        isScanning: boolean;
        lastScanTime: number;
        cooldownRemaining: number;
    };
    notifications: ToastMessage[];

    // UI Actions
    setHasEntered: (hasEntered: boolean) => void;
    setActiveTab: (tab: string) => void;
    
    // Config Actions
    toggleBacktest: () => void;
    setSymbol: (symbol: string) => void;
    setInterval: (interval: string) => void;
    setPlaybackSpeed: (speed: number) => void;
    setBacktestDate: (date: string) => void;
    setAiModel: (model: string) => void; // New Action
    
    // Market Actions
    setMarketHistory: (payload: { candles: CandleData[], initialCVD: number }) => void;
    setMarketBands: (bands: any) => void;
    processWsTick: (tick: any) => void;
    processTradeTick: (trade: RecentTrade) => void;
    processSimTick: (payload: { asks: OrderBookLevel[]; bids: OrderBookLevel[]; metrics: Partial<MarketMetrics>; trade?: RecentTrade }) => void;
    
    // AI Actions
    startAiScan: () => void;
    completeAiScan: (result: AiScanResult) => void;
    failAiScan: () => void;
    updateAiCooldown: (remaining: number) => void;
    
    // Notification Actions
    addNotification: (toast: ToastMessage) => void;
    removeNotification: (id: string) => void;
}

// Helper: CVD Analysis Logic
const calculateCVDAnalysis = (candles: CandleData[], currentCVD: number) => {
    if (candles.length < 10) return { trend: 'FLAT' as const, divergence: 'NONE' as const, interpretation: 'NEUTRAL' as const, value: currentCVD };

    const lookback = 10;
    const subset = candles.slice(-lookback);
    const first = subset[0];
    const last = subset[subset.length - 1];

    const priceChange = last.close - first.close;
    const cvdChange = (last.cvd || 0) - (first.cvd || 0);

    let interpretation: 'REAL STRENGTH' | 'REAL WEAKNESS' | 'ABSORPTION' | 'DISTRIBUTION' | 'NEUTRAL' = 'NEUTRAL';
    let divergence: 'NONE' | 'BULLISH_ABSORPTION' | 'BEARISH_DISTRIBUTION' = 'NONE';
    let trend: 'UP' | 'DOWN' | 'FLAT' = Math.abs(cvdChange) < 100 ? 'FLAT' : (cvdChange > 0 ? 'UP' : 'DOWN');

    if (priceChange > 0 && cvdChange > 0) interpretation = 'REAL STRENGTH';
    else if (priceChange < 0 && cvdChange < 0) interpretation = 'REAL WEAKNESS';
    else if (priceChange > 0 && cvdChange < 0) {
        interpretation = 'DISTRIBUTION';
        divergence = 'BEARISH_DISTRIBUTION';
    }
    else if (priceChange < 0 && cvdChange > 0) {
        interpretation = 'ABSORPTION';
        divergence = 'BULLISH_ABSORPTION';
    }

    return { trend, divergence, interpretation, value: currentCVD };
};

export const useStore = create<AppState>((set) => ({
    ui: { hasEntered: false, activeTab: 'dashboard' },
    config: { 
        isBacktest: false, 
        interval: '1m', 
        activeSymbol: 'BTCUSDT', 
        playbackSpeed: 1, 
        backtestDate: new Date().toISOString().split('T')[0],
        aiModel: 'gemini-1.5-pro-latest' // Default to Pro
    },
    market: {
        metrics: { ...MOCK_METRICS, pair: "BTC/USDT", price: 0, dailyPnL: 1250.00, circuitBreakerTripped: false },
        candles: [],
        asks: MOCK_ASKS,
        bids: MOCK_BIDS,
        signals: [],
        levels: MOCK_LEVELS,
        bands: null,
        runningCVD: 0,
        recentTrades: []
    },
    ai: { scanResult: undefined, isScanning: false, lastScanTime: 0, cooldownRemaining: 0 },
    notifications: [],

    setHasEntered: (hasEntered) => set((state) => ({ ui: { ...state.ui, hasEntered } })),
    setActiveTab: (activeTab) => set((state) => ({ ui: { ...state.ui, activeTab } })),
    
    toggleBacktest: () => set((state) => ({ 
        config: { ...state.config, isBacktest: !state.config.isBacktest },
        market: { ...state.market, candles: [], signals: [], runningCVD: 0, recentTrades: [] }
    })),

    setSymbol: (activeSymbol) => set((state) => ({
        config: { ...state.config, activeSymbol },
        market: { 
            ...state.market, 
            candles: [], 
            bands: null,
            runningCVD: 0,
            recentTrades: [],
            metrics: { ...state.market.metrics, pair: activeSymbol.replace('USDT', '/USDT') }
        }
    })),

    setInterval: (interval) => set((state) => ({ config: { ...state.config, interval } })),
    setPlaybackSpeed: (playbackSpeed) => set((state) => ({ config: { ...state.config, playbackSpeed } })),
    setBacktestDate: (backtestDate) => set((state) => ({ config: { ...state.config, backtestDate } })),
    setAiModel: (aiModel) => set((state) => ({ config: { ...state.config, aiModel } })),

    setMarketHistory: ({ candles, initialCVD }) => set((state) => {
        const candlesWithAdx = calculateADX(candles);
        const initialCvdAnalysis = calculateCVDAnalysis(candlesWithAdx, initialCVD);
        const initialRegime = detectMarketRegime(candlesWithAdx);

        return { 
            market: { 
                ...state.market, 
                candles: candlesWithAdx, 
                runningCVD: initialCVD,
                metrics: {
                    ...state.market.metrics,
                    cvdContext: initialCvdAnalysis,
                    regime: initialRegime
                }
            } 
        };
    }),

    setMarketBands: (bands) => set((state) => ({ market: { ...state.market, bands } })),

    processWsTick: (k) => set((state) => {
        const newPrice = parseFloat(k.c);
        const newTime = k.t / 1000;
        const bands = state.market.bands;

        const totalVol = parseFloat(k.v);
        const takerBuyVol = parseFloat(k.V);
        const delta = (2 * takerBuyVol) - totalVol;
        
        let updatedCandles = [...state.market.candles];
        let newRunningCVD = state.market.runningCVD;
        
        if (updatedCandles.length > 0) {
            const lastCandle = updatedCandles[updatedCandles.length - 1];
            if (lastCandle.time === newTime) {
                const currentCVDValue = (updatedCandles.length > 1 ? updatedCandles[updatedCandles.length - 2].cvd || 0 : 0) + delta;
                updatedCandles[updatedCandles.length - 1] = {
                    ...lastCandle,
                    close: newPrice,
                    high: Math.max(lastCandle.high, newPrice),
                    low: Math.min(lastCandle.low, newPrice),
                    volume: totalVol,
                    delta: delta,
                    cvd: currentCVDValue
                };
                newRunningCVD = currentCVDValue; 
            } else {
                const prevCVD = updatedCandles[updatedCandles.length - 1].cvd || 0;
                const currentCVDValue = prevCVD + delta;
                updatedCandles.push({
                    time: newTime,
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: newPrice,
                    volume: totalVol,
                    delta: delta,
                    cvd: currentCVDValue,
                    zScoreUpper1: bands ? bands.upper_1 : newPrice * 1.002,
                    zScoreLower1: bands ? bands.lower_1 : newPrice * 0.998,
                    zScoreUpper2: bands ? bands.upper_2 : newPrice * 1.005,
                    zScoreLower2: bands ? bands.lower_2 : newPrice * 0.995,
                });
                newRunningCVD = currentCVDValue;
            }
        } else {
             updatedCandles.push({
                time: newTime,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: newPrice,
                volume: totalVol,
                delta: delta,
                cvd: delta,
                zScoreUpper1: newPrice * 1.002,
                zScoreLower1: newPrice * 0.998,
                zScoreUpper2: newPrice * 1.005,
                zScoreLower2: newPrice * 0.995,
            });
            newRunningCVD = delta;
        }

        const takerSellVol = totalVol - takerBuyVol;
        const ofi = takerBuyVol - takerSellVol;
        const candlesWithAdx = calculateADX(updatedCandles);
        const cvdContext = calculateCVDAnalysis(candlesWithAdx, newRunningCVD);
        const currentRegime = detectMarketRegime(candlesWithAdx);

        return {
            market: {
                ...state.market,
                candles: candlesWithAdx,
                runningCVD: newRunningCVD,
                metrics: {
                    ...state.market.metrics,
                    price: newPrice,
                    change: parseFloat(k.P) || 0,
                    ofi: ofi,
                    cvdContext: cvdContext,
                    regime: currentRegime
                }
            }
        };
    }),

    processTradeTick: (trade) => set((state) => {
        const updatedTrades = [trade, ...state.market.recentTrades].slice(0, 50);
        return { market: { ...state.market, recentTrades: updatedTrades } };
    }),

    processSimTick: ({ asks, bids, metrics, trade }) => set((state) => {
        let simTrades = state.market.recentTrades;
        if (trade) {
            simTrades = [trade, ...simTrades].slice(0, 50);
        }
        return {
            market: {
                ...state.market,
                asks,
                bids,
                recentTrades: simTrades,
                metrics: { ...state.market.metrics, ...metrics }
            }
        };
    }),

    startAiScan: () => set((state) => ({ ai: { ...state.ai, isScanning: true, lastScanTime: Date.now(), cooldownRemaining: 60 } })),
    
    completeAiScan: (result) => set((state) => {
        const newLevels: PriceLevel[] = [];
        result.support.forEach((p: number) => newLevels.push({ price: p, type: 'SUPPORT', label: 'AI SUP' }));
        result.resistance.forEach((p: number) => newLevels.push({ price: p, type: 'RESISTANCE', label: 'AI RES' }));
        newLevels.push({ price: result.decision_price, type: 'ENTRY', label: 'AI PIVOT' });
        if (result.stop_loss) newLevels.push({ price: result.stop_loss, type: 'STOP_LOSS', label: 'STOP' });
        if (result.take_profit) newLevels.push({ price: result.take_profit, type: 'TAKE_PROFIT', label: 'TARGET' });

        const updatedLevels = [
            ...state.market.levels.filter(l => !l.label.startsWith('AI') && l.label !== 'STOP' && l.label !== 'TARGET'),
            ...newLevels
        ];

        return { 
            market: { ...state.market, levels: updatedLevels },
            ai: { ...state.ai, isScanning: false, scanResult: result } 
        };
    }),

    failAiScan: () => set((state) => ({ ai: { ...state.ai, isScanning: false } })),
    
    updateAiCooldown: (cooldownRemaining) => set((state) => ({ ai: { ...state.ai, cooldownRemaining } })),
    
    addNotification: (toast) => set((state) => ({ notifications: [...state.notifications, toast] })),
    removeNotification: (id) => set((state) => ({ notifications: state.notifications.filter(n => n.id !== id) })),
}));