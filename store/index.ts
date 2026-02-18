
import { create } from 'zustand';
import type { 
    CandleData, 
    MarketMetrics, 
    OrderBookLevel, 
    RecentTrade, 
    TradeSignal, 
    PriceLevel, 
    AiScanResult,
    ToastMessage,
    Position,
    DailyStats,
    BiasMatrixState,
    LiquidityState,
    RegimeState,
    AiTacticalState,
    ExpectedValueData,
    TimeframeData,
    HeatmapItem
} from '../types';
import { 
    auth, 
    googleProvider, 
    db 
} from '../lib/firebase';
import * as firebaseAuth from 'firebase/auth';
import * as firebaseFirestore from 'firebase/firestore';

// Destructure from namespace imports
const { 
    signInWithPopup, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    signOut, 
    updateProfile 
} = firebaseAuth;

const { 
    doc, 
    getDoc, 
    setDoc 
} = firebaseFirestore;

// Use explicit types from the namespace if generic import fails
type User = firebaseAuth.User;

import { 
    calculateZScoreBands, 
    analyzeRegime,
    calculateRSI,
    calculateSkewness,
    calculateKurtosis
} from '../utils/analytics';
import { MOCK_METRICS, API_BASE_URL } from '../constants';

interface StoreState {
    ui: {
        hasEntered: boolean;
        activeTab: string;
        isProfileOpen: boolean;
    };
    config: {
        isBacktest: boolean;
        activeSymbol: string;
        playbackSpeed: number;
        backtestDate: string;
        interval: string;
        aiModel: string;
        telegramBotToken: string;
        telegramChatId: string;
    };
    auth: {
        user: User | null;
        registrationOpen: boolean;
    };
    market: {
        metrics: MarketMetrics;
        candles: CandleData[];
        recentTrades: RecentTrade[];
        asks: OrderBookLevel[];
        bids: OrderBookLevel[];
        signals: TradeSignal[];
        levels: PriceLevel[];
        expectedValue: ExpectedValueData | null;
        bands: any | null;
    };
    ai: {
        scanResult: AiScanResult | undefined;
        isScanning: boolean;
        cooldownRemaining: number;
        lastScanTime: number;
        orderFlowAnalysis: {
            verdict: string;
            confidence: number;
            explanation: string;
            flowType: string;
            timestamp: number;
            isLoading: boolean;
        };
    };
    trading: {
        activePosition: Position | null;
        accountSize: number;
        riskPercent: number;
        dailyStats: DailyStats;
    };
    biasMatrix: BiasMatrixState;
    liquidity: LiquidityState;
    regime: RegimeState;
    aiTactical: AiTacticalState;
    notifications: ToastMessage[];
    alertLogs: any[];
    
    // New State Fields
    cvdRunning: number;
    dailyPnL: number;
    recentTradesBuffer: Array<{ price: number; volume: number; side: 'BUY' | 'SELL'; timestamp: number }>;

    // Actions
    setHasEntered: (val: boolean) => void;
    setActiveTab: (tab: string) => void;
    setProfileOpen: (val: boolean) => void;
    
    toggleBacktest: () => void;
    setSymbol: (symbol: string) => void;
    setPlaybackSpeed: (speed: number) => void;
    setBacktestDate: (date: string) => void;
    setInterval: (interval: string) => void;
    setAiModel: (model: string) => void;
    
    setUser: (user: User | null) => void;
    initSystemConfig: () => Promise<void>;
    loadUserPreferences: () => Promise<void>;
    signInGoogle: () => Promise<void>;
    registerEmail: (e: string, p: string, n: string) => Promise<void>;
    loginEmail: (e: string, p: string) => Promise<void>;
    toggleRegistration: (val: boolean) => void;
    updateUserProfile: (data: any) => Promise<void>;
    logout: () => Promise<void>;
    
    setMarketHistory: (data: { candles: CandleData[], initialCVD: number }) => void;
    setMarketBands: (bands: any) => void;
    processWsTick: (kline: any) => void;
    processTradeTick: (trade: RecentTrade) => void;
    processDepthUpdate: (data: { asks: OrderBookLevel[], bids: OrderBookLevel[], metrics: Partial<MarketMetrics> }) => void;
    
    updateAiCooldown: (val: number) => void;
    startAiScan: () => void;
    completeAiScan: (result: AiScanResult) => void;
    fetchOrderFlowAnalysis: (context: any) => Promise<void>;
    
    openPosition: (params: any) => void;
    closePosition: (price: number) => void;
    setRiskPercent: (pct: number) => void;
    
    refreshBiasMatrix: () => Promise<void>;
    refreshLiquidityAnalysis: () => Promise<void>;
    refreshRegimeAnalysis: () => void;
    refreshTacticalAnalysis: () => void;
    refreshHeatmap: () => Promise<void>;
    
    addNotification: (toast: ToastMessage) => void;
    removeNotification: (id: string) => void;
    logAlert: (alert: any) => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => ({
    ui: {
        hasEntered: false,
        activeTab: 'dashboard',
        isProfileOpen: false,
    },
    config: {
        isBacktest: false,
        activeSymbol: typeof localStorage !== 'undefined' ? (localStorage.getItem('activeSymbol') || 'BTCUSDT') : 'BTCUSDT',
        playbackSpeed: 1,
        backtestDate: new Date().toISOString().split('T')[0],
        interval: '1m',
        aiModel: 'gemini-3-flash-preview',
        telegramBotToken: '',
        telegramChatId: ''
    },
    auth: {
        user: null,
        registrationOpen: true
    },
    market: {
        metrics: MOCK_METRICS,
        candles: [],
        recentTrades: [],
        asks: [],
        bids: [],
        signals: [],
        levels: [],
        expectedValue: null,
        bands: null
    },
    ai: {
        scanResult: undefined,
        isScanning: false,
        cooldownRemaining: 0,
        lastScanTime: 0,
        orderFlowAnalysis: {
            verdict: '',
            confidence: 0,
            explanation: '',
            flowType: '',
            timestamp: 0,
            isLoading: false
        }
    },
    trading: {
        activePosition: null,
        accountSize: 50000,
        riskPercent: 1,
        dailyStats: {
            totalR: 0,
            realizedPnL: 0,
            wins: 0,
            losses: 0,
            tradesToday: 0,
            maxDrawdownR: 0
        }
    },
    biasMatrix: {
        symbol: 'BTCUSDT',
        daily: null,
        h4: null,
        h1: null,
        m5: null,
        lastUpdated: 0,
        isLoading: false
    },
    liquidity: {
        sweeps: [],
        bos: [],
        fvg: [],
        lastUpdated: 0
    },
    regime: {
        symbol: 'BTCUSDT',
        regimeType: 'UNCERTAIN',
        trendDirection: 'NEUTRAL',
        atr: 0,
        rangeSize: 0,
        volatilityPercentile: 0,
        lastUpdated: 0
    },
    aiTactical: {
        symbol: 'BTCUSDT',
        probability: 0,
        scenario: 'NEUTRAL',
        entryLevel: 0,
        stopLevel: 0,
        exitLevel: 0,
        confidenceFactors: {
            biasAlignment: false,
            liquidityAgreement: false,
            regimeAgreement: false,
            aiScore: 0
        },
        lastUpdated: 0
    },
    notifications: [],
    // Issue #13: Initialize alerts from storage
    alertLogs: (() => {
        if (typeof localStorage === 'undefined') return [];
        try {
            const stored = localStorage.getItem('quant-desk-alerts');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    })(),
    cvdRunning: 0,
    dailyPnL: 0,
    recentTradesBuffer: [],

    // --- Actions ---

    setHasEntered: (val) => set(state => ({ ui: { ...state.ui, hasEntered: val } })),
    setActiveTab: (tab) => set(state => ({ ui: { ...state.ui, activeTab: tab } })),
    setProfileOpen: (val) => set(state => ({ ui: { ...state.ui, isProfileOpen: val } })),

    toggleBacktest: () => set(state => ({ config: { ...state.config, isBacktest: !state.config.isBacktest } })),
    
    setSymbol: (symbol) => {
        set(state => ({ 
            config: { ...state.config, activeSymbol: symbol },
            market: { ...state.market, candles: [], recentTrades: [], asks: [], bids: [] }, // Reset market data
            // Reset Analysis States to avoid stale data
            biasMatrix: { ...state.biasMatrix, symbol, daily: null, h4: null, h1: null, m5: null, isLoading: true },
            regime: { ...state.regime, symbol, regimeType: 'UNCERTAIN', atr: 0 },
            aiTactical: { ...state.aiTactical, symbol, probability: 0, scenario: 'NEUTRAL' },
            liquidity: { ...state.liquidity, sweeps: [], bos: [], fvg: [] }
        }));

        // Persist to LocalStorage
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('activeSymbol', symbol);
        }

        // Persist to Firestore if user is logged in
        const state = get();
        if (state.auth.user) {
            setDoc(doc(db, 'users', state.auth.user.uid), { 
                config: { activeSymbol: symbol } 
            }, { merge: true }).catch(err => console.error("Failed to save symbol preference", err));
        }
    },

    setPlaybackSpeed: (speed) => set(state => ({ config: { ...state.config, playbackSpeed: speed } })),
    setBacktestDate: (date) => set(state => ({ config: { ...state.config, backtestDate: date } })),
    setInterval: (interval) => set(state => ({ config: { ...state.config, interval } })),
    setAiModel: (model) => set(state => ({ config: { ...state.config, aiModel: model } })),

    setUser: (user) => set(state => ({ auth: { ...state.auth, user } })),
    
    initSystemConfig: async () => {
        try {
            const docRef = doc(db, 'system', 'config');
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                const data = snap.data();
                set(state => ({ 
                    auth: { ...state.auth, registrationOpen: data.registrationOpen ?? true },
                    config: { 
                        ...state.config, 
                        telegramBotToken: data.telegramBotToken || '',
                        telegramChatId: data.telegramChatId || ''
                    }
                }));
            }
        } catch(e) { console.error(e); }
    },

    loadUserPreferences: async () => {
        const state = get();
        if (!state.auth.user) return;
        
        try {
            const snap = await getDoc(doc(db, 'users', state.auth.user.uid));
            if (snap.exists()) {
                const data = snap.data();
                if (data.config?.activeSymbol) {
                    get().setSymbol(data.config.activeSymbol);
                }
            }
        } catch (e) {
            console.error("Error loading user preferences:", e);
        }
    },

    signInGoogle: async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (e: any) { throw new Error(e.message); }
    },

    registerEmail: async (e, p, n) => {
        const state = get();
        if (!state.auth.registrationOpen) throw new Error("Registration is closed by admin.");
        try {
            const res = await createUserWithEmailAndPassword(auth, e, p);
            await updateProfile(res.user, { displayName: n });
            set(s => ({ auth: { ...s.auth, user: res.user } }));
        } catch (err: any) { throw new Error(err.message); }
    },

    loginEmail: async (e, p) => {
        try {
            const res = await signInWithEmailAndPassword(auth, e, p);
            set(s => ({ auth: { ...s.auth, user: res.user } }));
        } catch (err: any) { throw new Error(err.message); }
    },

    toggleRegistration: (val) => {
        set(state => ({ auth: { ...state.auth, registrationOpen: val } }));
        // Persist to Firestore
        try {
            setDoc(doc(db, 'system', 'config'), { registrationOpen: val }, { merge: true });
        } catch(e) {}
    },

    updateUserProfile: async (data) => {
         set(state => ({ 
            config: { 
                ...state.config, 
                telegramBotToken: data.telegramBotToken, 
                telegramChatId: data.telegramChatId 
            }
        }));
    },

    logout: async () => {
        await signOut(auth);
        set(state => ({ auth: { ...state.auth, user: null } }));
    },

    setMarketHistory: ({ candles, initialCVD }) => set(state => {
        let runningCVD = initialCVD;

        const enrichedCandles = candles.map((candle, i) => {
            // 1. Calculate Estimated Delta & Accumulate CVD
            const estimatedDelta = candle.delta ?? (((candle.close - candle.open) / (candle.high - candle.low || 1)) * candle.volume);
            runningCVD += estimatedDelta;

            // 2. Z-Score Bands
            let bands;
            if (i < 19) {
                // Not enough data for bands yet, use % envelope as fallback
                bands = {
                    upper1: candle.close * 1.002,
                    lower1: candle.close * 0.998,
                    upper2: candle.close * 1.005,
                    lower2: candle.close * 0.995,
                };
            } else {
                // Get rolling window of 20 candles including current
                const window = candles.slice(i - 19, i + 1).map(c => c.close);
                bands = calculateZScoreBands(window);
            }
            
            return {
                ...candle,
                delta: estimatedDelta,
                cvd: runningCVD,
                zScoreUpper1: bands.upper1,
                zScoreLower1: bands.lower1,
                zScoreUpper2: bands.upper2,
                zScoreLower2: bands.lower2
            };
        });

        const metrics = { ...state.market.metrics };
        if (enrichedCandles.length > 0) {
            const last = enrichedCandles[enrichedCandles.length - 1];
            metrics.price = last.close;
            metrics.change = ((last.close - last.open) / last.open) * 100;
            // Issue #4: Initialize cumulative CVD properly
            metrics.institutionalCVD = runningCVD;
            
            // Calculate current Z-Score
            const prices = enrichedCandles.slice(-20).map(c => c.close);
            if (prices.length >= 20) {
                const mean = prices.reduce((a, b) => a + b, 0) / 20;
                const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / 20;
                const stdDev = Math.sqrt(variance);
                metrics.zScore = stdDev === 0 ? 0 : (last.close - mean) / stdDev;
            }
        }

        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem(`cvd_${state.config.activeSymbol}`, initialCVD.toString());
            } catch (e) { console.warn("Failed to persist CVD"); }
        }

        return {
            cvdRunning: runningCVD, // Set current CVD state
            market: {
                ...state.market,
                candles: enrichedCandles,
                metrics
            }
        };
    }),

    setMarketBands: (bands) => set(state => {
        // Issue #8: Apply backend bands to data
        const candles = [...state.market.candles];
        if (candles.length > 0 && bands) {
            const latest = candles[candles.length - 1];
            candles[candles.length - 1] = {
                ...latest,
                zScoreUpper1: bands.upper_1,
                zScoreLower1: bands.lower_1,
                zScoreUpper2: bands.upper_2,
                zScoreLower2: bands.lower_2,
            };
        }
        return { 
            market: { 
                ...state.market, 
                bands, 
                candles // Update with backend data applied
            } 
        };
    }),

    processWsTick: (kline) => set(state => {
        const candle: CandleData = {
            time: kline.t / 1000,
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            zScoreUpper1: 0, zScoreLower1: 0, zScoreUpper2: 0, zScoreLower2: 0
        };

        const candles = [...state.market.candles];
        const lastCandle = candles[candles.length - 1];

        // Update existing or add new
        if (lastCandle && candle.time === lastCandle.time) {
            candles[candles.length - 1] = { ...lastCandle, ...candle };
        } else {
            candles.push(candle);
            if (candles.length > 1000) candles.shift();
        }

        // --- REAL-TIME CALCULATIONS ---
        const prices = candles.slice(-50).map(c => c.close); // Use last 50 for calculations
        const currentPrice = candle.close;
        const prevClose = candles[candles.length - 2]?.close || currentPrice;
        
        // 1. Z-Score Bands
        const bands = calculateZScoreBands(prices.slice(-20)); // Last 20 for Bands
        const updatedLast = candles[candles.length - 1];
        updatedLast.zScoreUpper1 = bands.upper1;
        updatedLast.zScoreLower1 = bands.lower1;
        updatedLast.zScoreUpper2 = bands.upper2;
        updatedLast.zScoreLower2 = bands.lower2;
        
        // 2. CVD Calculation (Cumulative)
        // Issue #4: Cumulative CVD logic
        // Estimate Delta for this specific candle
        const candleDelta = ((candle.close - candle.open) / (candle.high - candle.low || 1)) * candle.volume;
        
        // Use running CVD from state instead of just candle delta
        const cumulativeCvd = state.cvdRunning + candleDelta;
        
        updatedLast.delta = candleDelta;
        updatedLast.cvd = cumulativeCvd;
        candles[candles.length - 1] = updatedLast;

        // 3. Metrics
        const priceChange = ((currentPrice - prevClose) / prevClose) * 100;
        const mean = prices.slice(-20).reduce((a, b) => a + b, 0) / 20;
        
        // Issue #9: Direct StdDev calculation
        const variance = prices.slice(-20).reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / 20;
        const stdDev = Math.sqrt(variance);
        const zScore = stdDev === 0 ? 0 : (currentPrice - mean) / stdDev;

        // 4. Advanced Statistics (Log Returns)
        const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
        const skewness = calculateSkewness(returns); // Last 50 candles returns
        const kurtosis = calculateKurtosis(returns);

        // 5. Retail Sentiment Proxy (RSI)
        const rsi = calculateRSI(prices, 14); // 14 period RSI
        
        // 6. Bayesian Proxy (Trend Confidence)
        // Simple logic: If Price > SMA20 AND RSI is neutral/bullish, confidence is higher.
        const sma20 = mean; // Already calculated
        const trendScore = currentPrice > sma20 ? 0.6 : 0.4;
        const rsiMod = rsi > 70 ? -0.1 : (rsi < 30 ? 0.1 : 0); // Mean reversion drag
        const bayesian = Math.min(0.99, Math.max(0.01, trendScore + rsiMod));

        // 7. Context Interpretation (Using Normalized Pressure)
        const avgVol = candles.slice(-20).reduce((a,c) => a + c.volume, 0) / 20;
        // Normalize Delta to -100 to 100 relative to avg volume * 2 (aggressiveness factor)
        const pressureScore = Math.max(-100, Math.min(100, (candleDelta / (avgVol * 2 || 1)) * 100));

        // Derive Context (Absorption vs Distribution)
        let contextInterpretation: 'REAL STRENGTH' | 'REAL WEAKNESS' | 'ABSORPTION' | 'DISTRIBUTION' | 'NEUTRAL' = 'NEUTRAL';
        let divergence: 'NONE' | 'BULLISH_ABSORPTION' | 'BEARISH_DISTRIBUTION' = 'NONE';
        const trend = pressureScore > 20 ? 'UP' : pressureScore < -20 ? 'DOWN' : 'FLAT';

        if (priceChange > 0 && pressureScore > 20) contextInterpretation = 'REAL STRENGTH';
        else if (priceChange < 0 && pressureScore < -20) contextInterpretation = 'REAL WEAKNESS';
        else if (priceChange <= 0 && pressureScore > 30) {
            contextInterpretation = 'ABSORPTION';
            divergence = 'BULLISH_ABSORPTION';
        }
        else if (priceChange >= 0 && pressureScore < -30) {
            contextInterpretation = 'DISTRIBUTION';
            divergence = 'BEARISH_DISTRIBUTION';
        }

        // Expected Value (EV) Calculation
        let expectedValue: ExpectedValueData | null = state.market.expectedValue;
        if (state.ai.scanResult && state.ai.scanResult.verdict === 'ENTRY') {
            const scan = state.ai.scanResult;
            const entry = scan.entry_price || scan.decision_price;
            const stop = scan.stop_loss || (entry * 0.99);
            const target = scan.take_profit || (entry * 1.02);
            
            const risk = Math.abs(entry - stop);
            const reward = Math.abs(target - entry);
            const rrRatio = risk === 0 ? 0 : reward / risk;
            
            const winRate = Math.max(0.4, scan.confidence || 0.5);
            const ev = (winRate * reward) - ((1 - winRate) * risk);
            
            expectedValue = {
                ev,
                rrRatio,
                winProbability: winRate,
                winAmount: reward,
                lossAmount: risk
            };
        }

        // Issue #2: Update Active Position P&L
        let activePosition = state.trading.activePosition;
        if (activePosition) {
            const pos = activePosition;
            const priceDiff = pos.direction === 'LONG' 
                ? currentPrice - pos.entry 
                : pos.entry - currentPrice;
            
            const unrealizedPnL = priceDiff * pos.size;
            const floatingR = pos.riskAmount !== 0 ? unrealizedPnL / pos.riskAmount : 0;
            
            activePosition = {
                ...pos,
                unrealizedPnL,
                floatingR
            };
        }

        return {
            cvdRunning: cumulativeCvd, // Update running CVD
            trading: {
                ...state.trading,
                activePosition
            },
            market: {
                ...state.market,
                candles,
                metrics: {
                    ...state.market.metrics,
                    price: currentPrice,
                    change: parseFloat(priceChange.toFixed(2)),
                    zScore: parseFloat(zScore.toFixed(2)),
                    retailSentiment: parseFloat(rsi.toFixed(0)), // RSI mapped to 0-100 Sentiment
                    skewness: parseFloat(skewness.toFixed(2)),
                    kurtosis: parseFloat(kurtosis.toFixed(2)),
                    bayesianPosterior: parseFloat(bayesian.toFixed(2)),
                    institutionalCVD: parseFloat(cumulativeCvd.toFixed(0)), // TRUE CUMULATIVE for display
                    cvdContext: {
                        value: parseFloat(pressureScore.toFixed(0)), // NORMALIZED PRESSURE for gauge
                        trend,
                        divergence,
                        interpretation: contextInterpretation
                    }
                },
                expectedValue
            }
        };
    }),

    processTradeTick: (trade) => set(state => {
        const updatedTrades = [trade, ...state.market.recentTrades].slice(0, 50);
        
        // Issue #5: Calculate Toxicity (VPIN Proxy)
        const now = Date.now();
        // Add current trade to buffer - Map 'size' from RecentTrade to 'volume' for buffer
        const newTradeForBuffer = {
            price: trade.price,
            volume: trade.size, // MAP SIZE TO VOLUME TO FIX TYPE ERROR
            side: trade.side,
            timestamp: now
        };

        const buffer = [...state.recentTradesBuffer, newTradeForBuffer]
            .filter(t => now - t.timestamp < 60000); // Keep last 60s
            
        const totalVol = buffer.reduce((sum, t) => sum + t.volume, 0);
        const sellVol = buffer.filter(t => t.side === 'SELL').reduce((sum, t) => sum + t.volume, 0);
        
        const toxicity = totalVol > 0 ? (sellVol / totalVol) * 100 : 0;

        return { 
            recentTradesBuffer: buffer,
            market: { 
                ...state.market, 
                recentTrades: updatedTrades,
                metrics: {
                    ...state.market.metrics,
                    toxicity: parseFloat(toxicity.toFixed(1))
                }
            } 
        };
    }),

    processDepthUpdate: ({ asks, bids, metrics }) => set(state => {
        let ofi = state.market.metrics.ofi;
        
        if (asks.length > 0 && bids.length > 0) {
            const bestBidSize = bids[0].size; // Top of Bid Book
            const bestAskSize = asks[0].size; // Top of Ask Book
            const totalLiquidity = bestBidSize + bestAskSize;
            
            if (totalLiquidity > 0) {
                // Normalized imbalance
                ofi = ((bestBidSize - bestAskSize) / totalLiquidity) * 100;
            }
        }

        const updatedMetrics = { 
            ...state.market.metrics, 
            ...metrics,
            ofi // Inject calculated OFI
        };
        
        return {
            market: {
                ...state.market,
                asks,
                bids,
                metrics: updatedMetrics
            }
        };
    }),

    updateAiCooldown: (val) => set(state => ({ ai: { ...state.ai, cooldownRemaining: val } })),
    startAiScan: () => set(state => ({ ai: { ...state.ai, isScanning: true } })),
    completeAiScan: (result) => set(state => {
        const updatedLevels = [...state.market.levels];
        result.support.forEach(p => updatedLevels.push({ price: p, type: 'SUPPORT', label: 'AI SUP' }));
        result.resistance.forEach(p => updatedLevels.push({ price: p, type: 'RESISTANCE', label: 'AI RES' }));
        
        return {
            ai: { ...state.ai, scanResult: result, isScanning: false, lastScanTime: Date.now() },
            market: { ...state.market, levels: updatedLevels }
        };
    }),

    fetchOrderFlowAnalysis: async (context) => {
        set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: true } } }));
        
        try {
            const res = await fetch(`${API_BASE_URL}/analyze/flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(context)
            });
            
            if (!res.ok) throw new Error("Analysis Failed");
            
            const data = await res.json();
            
            set(state => ({
                ai: {
                    ...state.ai,
                    orderFlowAnalysis: {
                        verdict: data.verdict || 'NEUTRAL',
                        confidence: data.confidence || 0,
                        explanation: data.explanation || "Analysis unavailable",
                        flowType: data.flow_type || "UNKNOWN",
                        timestamp: Date.now(),
                        isLoading: false
                    }
                }
            }));
        } catch (e) {
             set(state => ({
                ai: {
                    ...state.ai,
                    orderFlowAnalysis: {
                        ...state.ai.orderFlowAnalysis,
                        isLoading: false,
                        explanation: "Connection to Neural Engine failed."
                    }
                }
            }));
        }
    },

    openPosition: ({ entry, stop, target, direction }) => set(state => {
        const size = (state.trading.accountSize * (state.trading.riskPercent / 100)) / Math.abs(entry - stop);
        return {
            trading: {
                ...state.trading,
                activePosition: {
                    id: Date.now().toString(),
                    symbol: state.config.activeSymbol,
                    direction,
                    entry,
                    stop,
                    target,
                    size,
                    riskAmount: state.trading.accountSize * (state.trading.riskPercent / 100),
                    isOpen: true,
                    openTime: Date.now(),
                    floatingR: 0,
                    unrealizedPnL: 0
                }
            }
        };
    }),

    closePosition: (price) => set(state => {
        if (!state.trading.activePosition) return {};
        const pos = state.trading.activePosition;
        let pnl = 0;
        if (pos.direction === 'LONG') pnl = (price - pos.entry) * pos.size;
        else pnl = (pos.entry - price) * pos.size;
        
        const rResult = pnl / pos.riskAmount;
        
        // Issue #10: Circuit Breaker Logic
        const newDailyPnL = state.dailyPnL + rResult;
        const circuitBreakerTripped = newDailyPnL <= -6; // -6R daily limit

        if (circuitBreakerTripped) {
            // Can add alert notification here
            console.warn("CIRCUIT BREAKER TRIPPED");
        }

        return {
            dailyPnL: newDailyPnL,
            trading: {
                ...state.trading,
                activePosition: null,
                accountSize: state.trading.accountSize + pnl,
                dailyStats: {
                    ...state.trading.dailyStats,
                    totalR: state.trading.dailyStats.totalR + rResult,
                    realizedPnL: state.trading.dailyStats.realizedPnL + pnl,
                    wins: pnl > 0 ? state.trading.dailyStats.wins + 1 : state.trading.dailyStats.wins,
                    losses: pnl <= 0 ? state.trading.dailyStats.losses + 1 : state.trading.dailyStats.losses,
                    tradesToday: state.trading.dailyStats.tradesToday + 1
                }
            },
            market: {
                ...state.market,
                metrics: {
                    ...state.market.metrics,
                    circuitBreakerTripped
                }
            }
        };
    }),

    setRiskPercent: (pct) => set(state => ({ trading: { ...state.trading, riskPercent: pct } })),

    refreshBiasMatrix: async () => {
        const state = get();
        if (state.biasMatrix.isLoading) return;
        set(s => ({ biasMatrix: { ...s.biasMatrix, isLoading: true } }));
        
        const { activeSymbol } = state.config;

        const fetchTF = async (interval: string): Promise<TimeframeData | null> => {
            try {
                const res = await fetch(`${API_BASE_URL}/history?symbol=${activeSymbol}&interval=${interval}&limit=25`);
                if(!res.ok) return null;
                const data = await res.json();
                
                if(Array.isArray(data) && data.length > 20) {
                    const closes = data.map((c: any) => parseFloat(c[4]));
                    const current = closes[closes.length - 1];
                    const sma20 = closes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
                    
                    return {
                        bias: current > sma20 ? 'BULL' : 'BEAR',
                        sparkline: closes,
                        lastUpdated: Date.now()
                    };
                }
                return null;
            } catch(e) { 
                console.warn(`Failed to fetch ${interval} bias`, e);
                return null; 
            }
        };

        const [daily, h4, h1, m5] = await Promise.all([
            fetchTF('1d'), 
            fetchTF('4h'), 
            fetchTF('1h'), 
            fetchTF('5m')
        ]);
        
        set(s => ({
            biasMatrix: {
                symbol: activeSymbol,
                daily: daily || s.biasMatrix.daily,
                h4: h4 || s.biasMatrix.h4,
                h1: h1 || s.biasMatrix.h1,
                m5: m5 || s.biasMatrix.m5,
                isLoading: false,
                lastUpdated: Date.now()
            }
        }));
    },

    refreshLiquidityAnalysis: async () => {
        const state = get();
        const candles = state.market.candles;
        const currentPrice = state.market.metrics.price;
        
        if (candles.length < 25 || !currentPrice) return;
        
        const lookback = 50;
        const recentCandles = candles.slice(-lookback);
        const sweeps: any[] = [];
        
        for(let i = 2; i < recentCandles.length - 2; i++) {
            const curr = recentCandles[i];
            const isHigh = curr.high > recentCandles[i-1].high && curr.high > recentCandles[i-2].high &&
                           curr.high > recentCandles[i+1].high && curr.high > recentCandles[i+2].high;
            
            const isLow = curr.low < recentCandles[i-1].low && curr.low < recentCandles[i-2].low &&
                          curr.low < recentCandles[i+1].low && curr.low < recentCandles[i+2].low;
            
            if (isHigh) {
                const subsequent = recentCandles.slice(i + 1);
                const sweeper = subsequent.find(c => c.high > curr.high && c.close < curr.high);
                
                if (sweeper) {
                    if (!state.liquidity.sweeps.find(s => s.timestamp === sweeper.time)) {
                        sweeps.push({
                            id: `sw-${sweeper.time}`,
                            price: curr.high,
                            side: 'BUY',
                            timestamp: Date.now(),
                            candleTime: sweeper.time
                        });
                    }
                }
            }

            if (isLow) {
                const subsequent = recentCandles.slice(i + 1);
                const sweeper = subsequent.find(c => c.low < curr.low && c.close > curr.low);
                
                if (sweeper) {
                    if (!state.liquidity.sweeps.find(s => s.timestamp === sweeper.time)) {
                        sweeps.push({
                            id: `sw-${sweeper.time}`,
                            price: curr.low,
                            side: 'SELL',
                            timestamp: Date.now(),
                            candleTime: sweeper.time
                        });
                    }
                }
            }
        }

        if (sweeps.length > 0) {
            set(s => ({
                liquidity: {
                    ...s.liquidity,
                    sweeps: [...sweeps, ...s.liquidity.sweeps].slice(0, 20), // Keep last 20
                    lastUpdated: Date.now()
                }
            }));
        }
    },

    refreshRegimeAnalysis: () => set(state => {
        const candles = state.market.candles;
        if (candles.length < 50) return {};
        
        const analysis = analyzeRegime(candles);
        return {
            regime: {
                ...state.regime,
                regimeType: analysis.type,
                trendDirection: analysis.trendDirection,
                atr: analysis.atr,
                rangeSize: analysis.rangeSize,
                volatilityPercentile: analysis.volatilityPercentile,
                lastUpdated: Date.now()
            }
        };
    }),

    refreshTacticalAnalysis: () => set(state => {
        const biasScore = state.biasMatrix.daily?.bias === 'BULL' ? 1 : -1;
        const regimeScore = state.regime.regimeType === 'TRENDING' && state.regime.trendDirection === 'BULL' ? 1 : -1;
        const liquidityScore = state.liquidity.sweeps.length > 0 && state.liquidity.sweeps[0].side === 'SELL' ? 1 : 0; 
        
        const totalScore = biasScore + regimeScore + liquidityScore;
        const probability = Math.min(95, Math.max(10, 50 + (totalScore * 15)));
        const scenario = totalScore > 0 ? 'BULLISH' : totalScore < 0 ? 'BEARISH' : 'NEUTRAL';
        
        const price = state.market.metrics.price;
        const entry = price;
        const stop = scenario === 'BULLISH' ? price * 0.99 : price * 1.01;
        const target = scenario === 'BULLISH' ? price * 1.02 : price * 0.98;

        return {
            aiTactical: {
                ...state.aiTactical,
                probability,
                scenario,
                entryLevel: entry,
                stopLevel: stop,
                exitLevel: target,
                confidenceFactors: {
                    biasAlignment: biasScore > 0,
                    regimeAgreement: regimeScore > 0,
                    liquidityAgreement: liquidityScore > 0,
                    aiScore: state.ai.scanResult?.confidence || 0
                },
                lastUpdated: Date.now()
            }
        };
    }),

    // Issue #6: Heatmap Population
    refreshHeatmap: async () => {
        try {
            const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
            const heatmapData: HeatmapItem[] = [];
            
            // Parallel fetch for heatmap data
            await Promise.all(symbols.map(async (symbol) => {
                try {
                    const res = await fetch(`${API_BASE_URL}/bands?symbol=${symbol}`);
                    if (res.ok) {
                        const data = await res.json();
                        // Estimate z-score from current price vs bands (rough approx since we only have bands)
                        // Ideally endpoint returns current price/zscore. Assuming backend returns just bands for now.
                        // We need price. Let's fetch history tick for price.
                        const histRes = await fetch(`${API_BASE_URL}/history?symbol=${symbol}&limit=1`);
                        const histData = await histRes.json();
                        if (histData && histData.length > 0) {
                            const price = histData[histData.length-1][4]; // Close
                            const mean = data.sma;
                            const std = data.std;
                            const zScore = std ? (price - mean) / std : 0;
                            
                            heatmapData.push({
                                pair: symbol.replace('USDT', ''),
                                zScore: zScore,
                                price: price
                            });
                        }
                    }
                } catch(e) {}
            }));
            
            if (heatmapData.length > 0) {
                set(state => ({
                    market: {
                        ...state.market,
                        metrics: {
                            ...state.market.metrics,
                            heatmap: heatmapData
                        }
                    }
                }));
            }
        } catch (error) {
            console.error('Heatmap refresh error:', error);
        }
    },

    addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
    removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),

    logAlert: async (alert) => {
        const newAlert = { ...alert, id: Date.now().toString() };
        const updatedLogs = [newAlert, ...get().alertLogs].slice(0, 50);
        set({ alertLogs: updatedLogs });
        // Issue #13: Persistence
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('quant-desk-alerts', JSON.stringify(updatedLogs));
        }
    }
}));
