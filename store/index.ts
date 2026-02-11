
import { create } from 'zustand';
import { MarketMetrics, CandleData, OrderBookLevel, TradeSignal, PriceLevel, RecentTrade, AiScanResult, ToastMessage, ExpectedValueData, Position, ClosedTrade, DailyStats } from '../types';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, MOCK_LEVELS } from '../constants';
import { calculateADX, detectMarketRegime, calculateSkewness, calculateKurtosis, calculateZScoreBands } from '../utils/analytics';
import type { User } from 'firebase/auth';
import { signInWithPopup, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, googleProvider, db } from '../lib/firebase';

// Debounced Calculation Scheduler
let analyticsTimeout: ReturnType<typeof setTimeout> | null = null;
const ANALYTICS_DEBOUNCE_MS = 1000; // 1 second

// --- VPIN Logic ---
interface VPINBucket {
    buyVolume: number;
    sellVolume: number;
    timestamp: number;
}

/**
 * Calculates VPIN (toxicity) from recent trades
 * VPIN measures order flow toxicity - high values indicate informed trading
 */
const calculateVPIN = (trades: RecentTrade[], bucketSize: number = 50, numBuckets: number = 50): number => {
    if (trades.length < 10) return 0;
    
    const buckets: VPINBucket[] = [];
    let currentBucket: VPINBucket = { buyVolume: 0, sellVolume: 0, timestamp: Date.now() };
    let bucketVolume = 0;
    
    // 1. Divide trades into equal-volume buckets
    for (const trade of trades) {
        const volume = trade.size;
        
        if (trade.side === 'BUY') {
            currentBucket.buyVolume += volume;
        } else {
            currentBucket.sellVolume += volume;
        }
        
        bucketVolume += volume;
        
        // Bucket is full
        if (bucketVolume >= bucketSize) {
            buckets.push({ ...currentBucket });
            currentBucket = { buyVolume: 0, sellVolume: 0, timestamp: Date.now() };
            bucketVolume = 0;
        }
        
        if (buckets.length >= numBuckets) break;
    }
    
    if (buckets.length === 0) return 0;
    
    // 2. Calculate VPIN
    const totalImbalance = buckets.reduce((sum, bucket) => {
        const totalVol = bucket.buyVolume + bucket.sellVolume;
        const imbalance = Math.abs(bucket.buyVolume - bucket.sellVolume);
        return sum + (totalVol > 0 ? imbalance / totalVol : 0);
    }, 0);
    
    const vpin = totalImbalance / buckets.length;
    
    // 3. Scale to 0-100 (VPIN typically ranges 0-0.5, but can spike higher)
    const toxicity = Math.min(100, vpin * 200);
    
    return Math.round(toxicity);
};

// --- Bayesian Logic ---

const calculateBayesianPosterior = (
    prior: number,
    likelihood: number,
    evidenceProbability: number
): number => {
    if (evidenceProbability === 0) return prior;
    return (likelihood * prior) / evidenceProbability;
};

const updateTrendContinuationBelief = (
    currentPrice: number,
    previousPrice: number,
    ofi: number,
    priorBelief: number = 0.5
): number => {
    const isUptrend = currentPrice > previousPrice;
    
    // P(E|H) - Likelihood: Probability of seeing this OFI if trend continues
    let likelihood: number;
    if (isUptrend) {
        likelihood = ofi > 100 ? 0.8 : ofi > 0 ? 0.6 : 0.3;
    } else {
        likelihood = ofi < -100 ? 0.8 : ofi < 0 ? 0.6 : 0.3;
    }
    
    // P(E) - Evidence
    const evidenceProbability = 
        (likelihood * priorBelief) + 
        ((1 - likelihood) * (1 - priorBelief));
    
    return calculateBayesianPosterior(priorBelief, likelihood, evidenceProbability);
};

// --- Expected Value Logic ---

const calculateExpectedValue = (
    winProbability: number,
    winAmount: number,
    lossProbability: number,
    lossAmount: number
): { ev: number; rrRatio: number } => {
    const ev = (winProbability * winAmount) - (lossProbability * lossAmount);
    const rrRatio = lossAmount > 0 ? winAmount / lossAmount : 0;
    
    return { ev, rrRatio };
};


interface AppState {
    ui: {
        hasEntered: boolean;
        activeTab: string;
    };
    auth: {
        user: User | null;
        isAuthLoading: boolean;
        isAuthModalOpen: boolean;
        registrationOpen: boolean;
    };
    config: {
        isBacktest: boolean;
        interval: string;
        activeSymbol: string;
        playbackSpeed: number;
        backtestDate: string;
        aiModel: string;
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
        expectedValue: ExpectedValueData | null;
    };
    ai: {
        scanResult: AiScanResult | undefined;
        isScanning: boolean;
        lastScanTime: number;
        cooldownRemaining: number;
    };
    analytics: {
        lastCalculation: number;
        isCalculating: boolean;
    };
    // Position & Risk State
    trading: {
        activePosition: Position | null;
        tradeHistory: ClosedTrade[];
        accountSize: number;
        riskPercent: number;
        dailyStats: DailyStats;
    };
    notifications: ToastMessage[];

    // UI Actions
    setHasEntered: (hasEntered: boolean) => void;
    setActiveTab: (tab: string) => void;
    
    // Auth Actions
    setUser: (user: User | null) => void;
    setAuthLoading: (isLoading: boolean) => void;
    signInGoogle: () => Promise<void>;
    registerEmail: (email: string, pass: string, name: string) => Promise<void>;
    loginEmail: (email: string, pass: string) => Promise<void>;
    logout: () => Promise<void>;
    
    // Admin Actions
    initSystemConfig: () => void;
    toggleRegistration: (isOpen: boolean) => Promise<void>;

    // Config Actions
    toggleBacktest: () => void;
    setSymbol: (symbol: string) => void;
    setInterval: (interval: string) => void;
    setPlaybackSpeed: (speed: number) => void;
    setBacktestDate: (date: string) => void;
    setAiModel: (model: string) => void;
    
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
    
    // Trading Actions
    openPosition: (params: { entry: number; stop: number; target: number; direction: 'LONG' | 'SHORT' }) => void;
    closePosition: (exitPrice: number) => void;
    setAccountSize: (size: number) => void;
    setRiskPercent: (percent: number) => void;
    resetDailyStats: () => void;

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

const DEFAULT_DAILY_STATS: DailyStats = {
    totalR: 0,
    realizedPnL: 0,
    wins: 0,
    losses: 0,
    tradesToday: 0,
    maxDrawdownR: 0
};

export const useStore = create<AppState>((set, get) => ({
    ui: { hasEntered: false, activeTab: 'dashboard' },
    auth: { user: null, isAuthLoading: true, isAuthModalOpen: false, registrationOpen: true },
    config: { 
        isBacktest: false, 
        interval: '1m', 
        activeSymbol: 'BTCUSDT', 
        playbackSpeed: 1, 
        backtestDate: new Date().toISOString().split('T')[0],
        aiModel: 'gemini-3-pro-preview'
    },
    market: {
        metrics: { ...MOCK_METRICS, pair: "BTC/USDT", price: 0, dailyPnL: 0, circuitBreakerTripped: false },
        candles: [],
        asks: MOCK_ASKS,
        bids: MOCK_BIDS,
        signals: [],
        levels: MOCK_LEVELS,
        bands: null,
        runningCVD: 0,
        recentTrades: [],
        expectedValue: null
    },
    ai: { scanResult: undefined, isScanning: false, lastScanTime: 0, cooldownRemaining: 0 },
    analytics: { lastCalculation: 0, isCalculating: false },
    // Trading State Initial Values
    trading: {
        activePosition: null,
        tradeHistory: [],
        accountSize: 100000, // 100k Default
        riskPercent: 1.0, // 1% Risk
        dailyStats: DEFAULT_DAILY_STATS
    },
    notifications: [],

    setHasEntered: (hasEntered) => set((state) => ({ ui: { ...state.ui, hasEntered } })),
    setActiveTab: (activeTab) => set((state) => ({ ui: { ...state.ui, activeTab } })),
    
    // Auth Actions
    setUser: (user) => set((state) => ({ auth: { ...state.auth, user, isAuthLoading: false } })),
    setAuthLoading: (isLoading) => set((state) => ({ auth: { ...state.auth, isAuthLoading: isLoading } })),
    
    initSystemConfig: () => {
        const docRef = doc(db, "system", "config");
        onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                set((state) => ({ auth: { ...state.auth, registrationOpen: data.registrationOpen !== false } }));
            } else {
                setDoc(docRef, { registrationOpen: true }, { merge: true }).catch(err => console.warn("Failed to init config", err));
            }
        }, (error) => {
            console.warn("System config sync failed (Offline/Permission):", error.message);
        });
    },

    toggleRegistration: async (isOpen: boolean) => {
        try {
             await setDoc(doc(db, "system", "config"), { registrationOpen: isOpen }, { merge: true });
             get().addNotification({
                id: Date.now().toString(),
                type: 'success',
                title: 'System Updated',
                message: `New user registration is now ${isOpen ? 'OPEN' : 'CLOSED'}.`
            });
        } catch (error: any) {
            console.error("Failed to update config", error);
        }
    },

    signInGoogle: async () => {
        if (!get().auth.registrationOpen) {
            // Note: Google sign in usually creates an account if one doesn't exist.
        }
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error: any) {
            get().addNotification({
                id: Date.now().toString(),
                type: 'error',
                title: 'Authentication Failed',
                message: error.message
            });
        }
    },

    registerEmail: async (email, pass, name) => {
        const { registrationOpen } = get().auth;
        const isAdmin = email.toLowerCase() === 'abrackly@gmail.com';

        if (!registrationOpen && !isAdmin) {
             get().addNotification({
                id: Date.now().toString(),
                type: 'error',
                title: 'Access Denied',
                message: 'New registrations are currently halted by the administrator.'
            });
            throw new Error("Registration is closed.");
        }

        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
            await updateProfile(userCredential.user, { displayName: name });
        } catch (error: any) {
             throw error;
        }
    },

    loginEmail: async (email, pass) => {
        try {
            await signInWithEmailAndPassword(auth, email, pass);
        } catch (error: any) {
            throw error;
        }
    },

    logout: async () => {
        try {
            await signOut(auth);
            get().addNotification({
                id: Date.now().toString(),
                type: 'info',
                title: 'Session Ended',
                message: 'You have been logged out securely.'
            });
        } catch (error: any) {
            console.error(error);
        }
    },

    toggleBacktest: () => set((state) => ({ 
        config: { ...state.config, isBacktest: !state.config.isBacktest },
        market: { ...state.market, candles: [], signals: [], runningCVD: 0, recentTrades: [] },
        trading: { ...state.trading, activePosition: null, tradeHistory: [], dailyStats: DEFAULT_DAILY_STATS }
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

    // --- Core Logic: Market Updates & Position Management ---
    processWsTick: (k) => set((state) => {
        // PHASE 1: Immediate price update (Hot Path)
        const newPrice = parseFloat(k.c);
        const newTime = k.t / 1000;
        const totalVol = parseFloat(k.v);
        const takerBuyVol = parseFloat(k.V);
        const delta = (2 * takerBuyVol) - totalVol;
        
        const takerSellVol = totalVol - takerBuyVol;
        const ofi = takerBuyVol - takerSellVol;

        let updatedCandles = [...state.market.candles];
        let newRunningCVD = state.market.runningCVD;
        
        // --- Position & Risk Logic (Embedded for Zero Latency) ---
        let activePosition = state.trading.activePosition;
        
        if (activePosition && activePosition.isOpen) {
            const isLong = activePosition.direction === 'LONG';
            const riskDistance = Math.abs(activePosition.entry - activePosition.stop);
            
            // Calculate Floating PnL
            let priceDist = 0;
            if (isLong) {
                priceDist = newPrice - activePosition.entry;
            } else {
                priceDist = activePosition.entry - newPrice;
            }
            
            // Calculate R-Multiple
            const currentR = riskDistance > 0 ? priceDist / riskDistance : 0;
            const currentPnL = activePosition.size * priceDist;

            activePosition = {
                ...activePosition,
                floatingR: currentR,
                unrealizedPnL: currentPnL
            };
        }
        
        // --- Candle Logic ---
        let bands = { upper1: 0, lower1: 0, upper2: 0, lower2: 0 };
        const windowSize = 20;
        if (updatedCandles.length >= windowSize) {
             const prices = updatedCandles.slice(-windowSize).map(c => c.close);
             bands = calculateZScoreBands(prices);
        } else {
             bands = {
                 upper1: newPrice * 1.01, lower1: newPrice * 0.99,
                 upper2: newPrice * 1.02, lower2: newPrice * 0.98
             };
        }

        if (updatedCandles.length > 0) {
            const lastCandle = updatedCandles[updatedCandles.length - 1];
            
            if (lastCandle.time === newTime) {
                const currentCVD = (updatedCandles.length > 1 ? updatedCandles[updatedCandles.length - 2].cvd || 0 : 0) + delta;
                updatedCandles[updatedCandles.length - 1] = {
                    ...lastCandle,
                    close: newPrice,
                    high: Math.max(lastCandle.high, newPrice),
                    low: Math.min(lastCandle.low, newPrice),
                    volume: totalVol,
                    delta: delta,
                    cvd: currentCVD,
                    zScoreUpper1: bands.upper1,
                    zScoreLower1: bands.lower1,
                    zScoreUpper2: bands.upper2,
                    zScoreLower2: bands.lower2
                };
                newRunningCVD = currentCVD; 
            } else {
                const prevCVD = lastCandle.cvd || 0;
                const currentCVD = prevCVD + delta;
                updatedCandles.push({
                    time: newTime,
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: newPrice,
                    volume: totalVol,
                    delta: delta,
                    cvd: currentCVD,
                    adx: lastCandle.adx, 
                    zScoreUpper1: bands.upper1,
                    zScoreLower1: bands.lower1,
                    zScoreUpper2: bands.upper2,
                    zScoreLower2: bands.lower2,
                });
                newRunningCVD = currentCVD;
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
                zScoreUpper1: bands.upper1,
                zScoreLower1: bands.lower1,
                zScoreUpper2: bands.upper2,
                zScoreLower2: bands.lower2,
            });
            newRunningCVD = delta;
        }

        const newToxicity = calculateVPIN(state.market.recentTrades, 50, 50);

        if (analyticsTimeout) clearTimeout(analyticsTimeout);

        analyticsTimeout = setTimeout(() => {
            const currentState = get();
            if (currentState.analytics.isCalculating) return;

            set((s) => ({ analytics: { ...s.analytics, isCalculating: true } }));
            
            performance.mark('analytics-start');
            const candles = currentState.market.candles;
            const candlesWithAdx = calculateADX(candles);
            const cvdContext = calculateCVDAnalysis(candlesWithAdx, currentState.market.runningCVD);
            const currentRegime = detectMarketRegime(candlesWithAdx);
            
            let newPosterior = currentState.market.metrics.bayesianPosterior || 0.5;
            let skewness = 0;
            let kurtosis = 0;

            if (candles.length >= 30) {
                 const returns = candles.slice(-30).map((candle, i, arr) => {
                    if (i === 0) return 0;
                    return (candle.close - arr[i - 1].close) / arr[i - 1].close;
                 }).filter(r => !isNaN(r));
                 skewness = calculateSkewness(returns);
                 kurtosis = calculateKurtosis(returns);

                 if (candles.length >= 2) {
                     const current = candles[candles.length - 1];
                     const previous = candles[candles.length - 2];
                     const ofiVal = currentState.market.metrics.ofi;
                     newPosterior = updateTrendContinuationBelief(
                         current.close, 
                         previous.close, 
                         ofiVal, 
                         newPosterior
                     );
                 }
            }

            performance.mark('analytics-end');
            
            set((s) => ({
                market: {
                    ...s.market,
                    candles: candlesWithAdx,
                    metrics: {
                        ...s.market.metrics,
                        cvdContext,
                        regime: currentRegime,
                        bayesianPosterior: newPosterior,
                        skewness: skewness,
                        kurtosis: kurtosis
                    }
                },
                analytics: {
                    lastCalculation: Date.now(),
                    isCalculating: false
                }
            }));
            
            analyticsTimeout = null;
        }, ANALYTICS_DEBOUNCE_MS);

        return {
            market: {
                ...state.market,
                candles: updatedCandles,
                runningCVD: newRunningCVD,
                metrics: {
                    ...state.market.metrics,
                    price: newPrice,
                    change: parseFloat(k.P) || 0,
                    ofi: ofi,
                    toxicity: newToxicity,
                    dailyPnL: state.trading.dailyStats.realizedPnL + (activePosition?.unrealizedPnL || 0)
                }
            },
            trading: {
                ...state.trading,
                activePosition
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
        
        let expectedValueData = null;
        if (result.entry_price && result.stop_loss && result.take_profit) {
            const entry = result.entry_price;
            const target = result.take_profit;
            const stop = result.stop_loss;
            
            const winSize = Math.abs(target - entry);
            const lossSize = Math.abs(entry - stop);
            
            const winProb = result.confidence || 0.5;
            const lossProb = 1 - winProb;
            
            const { ev, rrRatio } = calculateExpectedValue(winProb, winSize, lossProb, lossSize);
            
            expectedValueData = {
                ev,
                rrRatio,
                winProbability: winProb,
                winAmount: winSize,
                lossAmount: lossSize
            };
        }

        return { 
            market: { 
                ...state.market, 
                levels: updatedLevels, 
                expectedValue: expectedValueData
            },
            ai: { ...state.ai, isScanning: false, scanResult: result } 
        };
    }),

    failAiScan: () => set((state) => ({ ai: { ...state.ai, isScanning: false } })),
    
    updateAiCooldown: (remaining) => set((state) => ({ ai: { ...state.ai, cooldownRemaining: remaining } })),
    
    // --- Trading Action Implementations ---

    openPosition: ({ entry, stop, target, direction }) => set((state) => {
        if (state.trading.activePosition) return {};

        const { accountSize, riskPercent } = state.trading;
        const riskAmount = accountSize * (riskPercent / 100);
        const priceDiff = Math.abs(entry - stop);
        
        // Prevent division by zero
        if (priceDiff === 0) return {};

        const size = riskAmount / priceDiff;

        const newPosition: Position = {
            id: Date.now().toString(),
            symbol: state.config.activeSymbol,
            direction,
            entry,
            stop,
            target,
            size,
            riskAmount,
            isOpen: true,
            openTime: Date.now(),
            floatingR: 0,
            unrealizedPnL: 0
        };

        return {
            trading: {
                ...state.trading,
                activePosition: newPosition
            },
            // Add Trade Signals to Chart
            market: {
                ...state.market,
                signals: [
                    ...state.market.signals,
                    { 
                        id: `entry-${newPosition.id}`, 
                        type: direction === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
                        price: entry,
                        time: Date.now() / 1000, 
                        label: 'OPEN'
                    }
                ]
            }
        };
    }),

    closePosition: (exitPrice) => set((state) => {
        const pos = state.trading.activePosition;
        if (!pos) return {};

        const isLong = pos.direction === 'LONG';
        const priceDist = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
        const riskDist = Math.abs(pos.entry - pos.stop);
        const finalR = riskDist > 0 ? priceDist / riskDist : 0;
        const finalPnL = pos.size * priceDist;

        const closedTrade: ClosedTrade = {
            ...pos,
            closeTime: Date.now(),
            exitPrice,
            resultR: finalR,
            realizedPnL: finalPnL
        };

        const isWin = finalR > 0;
        
        // Calculate Max Drawdown for the day
        const currentDD = state.trading.dailyStats.totalR + finalR;
        const newMaxDD = Math.min(state.trading.dailyStats.maxDrawdownR, currentDD);

        return {
            trading: {
                ...state.trading,
                activePosition: null,
                tradeHistory: [closedTrade, ...state.trading.tradeHistory],
                accountSize: state.trading.accountSize + finalPnL,
                dailyStats: {
                    totalR: state.trading.dailyStats.totalR + finalR,
                    realizedPnL: state.trading.dailyStats.realizedPnL + finalPnL,
                    wins: state.trading.dailyStats.wins + (isWin ? 1 : 0),
                    losses: state.trading.dailyStats.losses + (isWin ? 0 : 1),
                    tradesToday: state.trading.dailyStats.tradesToday + 1,
                    maxDrawdownR: newMaxDD
                }
            },
             market: {
                ...state.market,
                signals: [
                    ...state.market.signals,
                    { 
                        id: `exit-${pos.id}`, 
                        type: isWin ? 'EXIT_PROFIT' : 'EXIT_LOSS',
                        price: exitPrice,
                        time: Date.now() / 1000, 
                        label: isWin ? `+${finalR.toFixed(1)}R` : `${finalR.toFixed(1)}R`
                    }
                ]
            }
        };
    }),

    setAccountSize: (size) => set(state => ({ trading: { ...state.trading, accountSize: size }})),
    setRiskPercent: (percent) => set(state => ({ trading: { ...state.trading, riskPercent: percent }})),
    resetDailyStats: () => set(state => ({ trading: { ...state.trading, dailyStats: DEFAULT_DAILY_STATS }})),

    addNotification: (toast) => set((state) => ({ notifications: [...state.notifications, toast] })),
    removeNotification: (id) => set((state) => ({ notifications: state.notifications.filter(n => n.id !== id) })),
}));
