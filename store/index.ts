import { create } from 'zustand';
import {
    MarketMetrics, CandleData, RecentTrade, OrderBookLevel, TradeSignal, PriceLevel,
    AiScanResult, ToastMessage, Position, DailyStats, BiasMatrixState,
    LiquidityState, RegimeState, AiTacticalState, ExpectedValueData, TimeframeData,
    BiasType, SweepEvent, BreakOfStructure, FairValueGap
} from '../types';
import { MOCK_METRICS, API_BASE_URL } from '../constants';
import { analyzeRegime, calculateRSI } from '../utils/analytics';
import { auth, googleProvider, db } from '../lib/firebase';
import {
    signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, updateProfile, User
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

interface AppState {
    ui: {
        activeTab: string;
        hasEntered: boolean;
        isProfileOpen: boolean;
    };
    config: {
        activeSymbol: string;
        interval: string;
        isBacktest: boolean;
        playbackSpeed: number;
        backtestDate: string;
        aiModel: string;
        telegramBotToken: string;
        telegramChatId: string;
    };
    market: {
        metrics: MarketMetrics;
        candles: CandleData[];
        asks: OrderBookLevel[];
        bids: OrderBookLevel[];
        recentTrades: RecentTrade[];
        signals: TradeSignal[];
        levels: PriceLevel[];
        expectedValue: ExpectedValueData | null;
    };
    ai: {
        scanResult: AiScanResult | undefined;
        isScanning: boolean;
        lastScanTime: number;
        cooldownRemaining: number;
        orderFlowAnalysis: {
            isLoading: boolean;
            verdict: string;
            confidence: number;
            explanation: string;
            flowType: string;
            timestamp: number;
        };
    };
    auth: {
        user: User | null;
        registrationOpen: boolean;
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

    cvdBaseline: number;

    setHasEntered: (val: boolean) => void;
    setActiveTab: (tab: string) => void;
    setProfileOpen: (isOpen: boolean) => void;
    setSymbol: (symbol: string) => void;
    setInterval: (interval: string) => void;
    toggleBacktest: () => void;
    setPlaybackSpeed: (speed: number) => void;
    setBacktestDate: (date: string) => void;
    setAiModel: (model: string) => void;

    setMarketHistory: (payload: { candles: CandleData[], initialCVD: number }) => void;
    setMarketBands: (bands: any) => void;
    processWsTick: (tick: any, realDelta?: number) => void;
    processTradeTick: (trade: RecentTrade) => void;
    processDepthUpdate: (data: { asks: OrderBookLevel[], bids: OrderBookLevel[], metrics: any }) => void;
    refreshHeatmap: () => Promise<void>;
    resetCvd: () => void;

    startAiScan: () => void;
    completeAiScan: (result: AiScanResult) => void;
    updateAiCooldown: (seconds: number) => void;
    fetchOrderFlowAnalysis: (data: any) => Promise<void>;

    setUser: (user: User | null) => void;
    signInGoogle: () => Promise<void>;
    loginEmail: (e: string, p: string) => Promise<void>;
    registerEmail: (e: string, p: string, n: string) => Promise<void>;
    logout: () => Promise<void>;
    updateUserProfile: (data: any) => Promise<void>;
    loadUserPreferences: () => Promise<void>;
    toggleRegistration: (isOpen: boolean) => void;
    initSystemConfig: () => void;

    openPosition: (params: any) => void;
    closePosition: (price: number) => void;
    setRiskPercent: (pct: number) => void;

    refreshBiasMatrix: () => Promise<void>;
    refreshLiquidityAnalysis: () => void;
    refreshRegimeAnalysis: () => void;
    refreshTacticalAnalysis: () => void;

    addNotification: (toast: ToastMessage) => void;
    removeNotification: (id: string) => void;
    logAlert: (alert: any) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
    ui: {
        activeTab: 'dashboard',
        hasEntered: false,
        isProfileOpen: false,
    },
    config: {
        activeSymbol: 'BTCUSDT',
        interval: '1m',
        isBacktest: false,
        playbackSpeed: 1,
        backtestDate: new Date().toISOString().split('T')[0],
        aiModel: 'gemini-3-flash-preview',
        telegramBotToken: '',
        telegramChatId: '',
    },
    market: {
        metrics: MOCK_METRICS,
        candles: [],
        asks: [],
        bids: [],
        recentTrades: [],
        signals: [],
        levels: [],
        expectedValue: null,
    },
    ai: {
        scanResult: undefined,
        isScanning: false,
        lastScanTime: 0,
        cooldownRemaining: 0,
        orderFlowAnalysis: {
            isLoading: false,
            verdict: '',
            confidence: 0,
            explanation: '',
            flowType: '',
            timestamp: 0
        }
    },
    auth: {
        user: null,
        registrationOpen: true,
    },
    trading: {
        activePosition: null,
        accountSize: 10000,
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
        isLoading: false,
    },
    liquidity: {
        sweeps: [],
        bos: [],
        fvg: [],
        lastUpdated: 0,
    },
    regime: {
        symbol: 'BTCUSDT',
        regimeType: 'UNCERTAIN',
        trendDirection: 'NEUTRAL',
        atr: 0,
        rangeSize: 0,
        volatilityPercentile: 0,
        lastUpdated: 0,
    },
    aiTactical: {
        symbol: 'BTCUSDT',
        probability: 50,
        scenario: 'NEUTRAL',
        entryLevel: 0,
        stopLevel: 0,
        exitLevel: 0,
        confidenceFactors: {
            biasAlignment: false,
            liquidityAgreement: false,
            regimeAgreement: false,
            aiScore: 0,
        },
        lastUpdated: 0,
    },
    notifications: [],
    alertLogs: [],
    cvdBaseline: 0,

    setHasEntered: (val) => set(state => ({ ui: { ...state.ui, hasEntered: val } })),
    setActiveTab: (tab) => set(state => ({ ui: { ...state.ui, activeTab: tab } })),
    setProfileOpen: (isOpen) => set(state => ({ ui: { ...state.ui, isProfileOpen: isOpen } })),
    setSymbol: (symbol) => set(state => ({ config: { ...state.config, activeSymbol: symbol } })),
    setInterval: (interval) => set(state => ({ config: { ...state.config, interval } })),
    toggleBacktest: () => set(state => ({ config: { ...state.config, isBacktest: !state.config.isBacktest } })),
    setPlaybackSpeed: (speed) => set(state => ({ config: { ...state.config, playbackSpeed: speed } })),
    setBacktestDate: (date) => set(state => ({ config: { ...state.config, backtestDate: date } })),
    setAiModel: (model) => set(state => ({ config: { ...state.config, aiModel: model } })),

    setMarketHistory: ({ candles, initialCVD }) => {
        // Compute RSI (retailSentiment) and VPIN (toxicity) from the initial historical data
        const closes = candles.map(c => c.close);
        const rsiOnLoad = calculateRSI(closes, 14);
        const vpinSlice = candles.slice(-20);
        const vpinOnLoad = Math.min(100, (vpinSlice.reduce((acc, c) => {
            const vol = c.volume || 0;
            return acc + (vol > 0 ? Math.abs(c.delta || 0) / vol : 0);
        }, 0) / Math.max(vpinSlice.length, 1)) * 100);

        set(state => ({
            cvdBaseline: initialCVD,
            market: {
                ...state.market,
                candles,
                metrics: {
                    ...state.market.metrics,
                    institutionalCVD: initialCVD,
                    retailSentiment: rsiOnLoad,
                    toxicity: vpinOnLoad
                }
            }
        }));
        get().refreshBiasMatrix();
        get().refreshLiquidityAnalysis();
    },

    setMarketBands: (_bands) => { },

    processWsTick: (tick, realDelta = 0) => set(state => {
        const candles = [...state.market.candles];
        if (candles.length === 0) return {};

        const last = candles[candles.length - 1];
        let newCandles = candles;

        const tickTimeSec = Math.floor(tick.t / 1000);
        if (tickTimeSec < last.time) return {};

        if (tickTimeSec === last.time) {
            const updatedCvd = state.cvdBaseline + realDelta;
            newCandles[newCandles.length - 1] = {
                ...last,
                close: tick.c,
                high: Math.max(last.high, tick.c),
                low: Math.min(last.low, tick.c),
                volume: tick.v,
                delta: realDelta,
                cvd: updatedCvd
            };
        } else if (tickTimeSec > last.time) {
            const updatedBaseline = state.cvdBaseline + (last.delta || 0);
            const newCvd = updatedBaseline + realDelta;

            const newCandle: CandleData = {
                time: tickTimeSec,
                open: tick.o,
                high: tick.h,
                low: tick.l,
                close: tick.c,
                volume: tick.v,
                zScoreUpper1: last.zScoreUpper1,
                zScoreLower1: last.zScoreLower1,
                zScoreUpper2: last.zScoreUpper2,
                zScoreLower2: last.zScoreLower2,
                adx: last.adx,
                cvd: newCvd,
                delta: realDelta
            };
            newCandles = [...candles.slice(1), newCandle];

            // --- CVD Divergence Analysis ---
            const window = newCandles.slice(-10);
            const firstPrice = window[0].close;
            const lastPrice = window[window.length - 1].close;
            const firstCvd = window[0].cvd || 0;
            const lastCvd = window[window.length - 1].cvd || 0;
            const windowVol = window.reduce((acc, c) => acc + (c.volume || 0), 0);

            const priceDelta = lastPrice - firstPrice;
            const cvdDelta = lastCvd - firstCvd;

            let interpretation: any = 'NEUTRAL';
            let divergence: any = 'NONE';

            if (priceDelta > 0 && cvdDelta > 0) interpretation = 'REAL STRENGTH';
            else if (priceDelta < 0 && cvdDelta < 0) interpretation = 'REAL WEAKNESS';
            else if (priceDelta <= 0 && cvdDelta > 0) {
                interpretation = 'ABSORPTION';
                divergence = 'BULLISH_ABSORPTION';
            }
            else if (priceDelta >= 0 && cvdDelta < 0) {
                interpretation = 'DISTRIBUTION';
                divergence = 'BEARISH_DISTRIBUTION';
            }

            // --- Statistical Metrics (computed on new-bar open for performance) ---
            const allCloses = newCandles.map(c => c.close);
            const closes50 = allCloses.slice(-50);
            const n50 = closes50.length;
            const mean50 = closes50.reduce((a, b) => a + b, 0) / n50;
            const std50 = Math.sqrt(closes50.reduce((a, c) => a + Math.pow(c - mean50, 2), 0) / n50);
            const skewness = std50 > 0 ? closes50.reduce((a, c) => a + Math.pow((c - mean50) / std50, 3), 0) / n50 : 0;
            const kurtosis = std50 > 0 ? closes50.reduce((a, c) => a + Math.pow((c - mean50) / std50, 4), 0) / n50 - 3 : 0;

            const closes20 = allCloses.slice(-20);
            const mean20 = closes20.reduce((a, b) => a + b, 0) / closes20.length;
            const std20 = Math.sqrt(closes20.reduce((a, c) => a + Math.pow(c - mean20, 2), 0) / closes20.length);
            const zScore = std20 > 0 ? (tick.c - mean20) / std20 : 0;

            // --- RSI (retailSentiment) — computed fresh on every new bar ---
            const allClosesRSI = newCandles.map(c => c.close);
            const rsiValue = calculateRSI(allClosesRSI, 14);

            // --- VPIN / Toxicity: rolling |delta| / volume over last 20 bars ---
            const vpinWindow = newCandles.slice(-20);
            const vpinValue = Math.min(100, (vpinWindow.reduce((acc, c) => {
                const vol = c.volume || 0;
                return acc + (vol > 0 ? Math.abs(c.delta || 0) / vol : 0);
            }, 0) / Math.max(vpinWindow.length, 1)) * 100);

            // --- Bayesian Posterior: P(bull | RSI, OFI) ---
            const ofiNow = state.market.metrics.ofi || 0;
            const lBull = rsiValue > 55 ? 0.65 : rsiValue < 45 ? 0.35 : 0.50;
            const ofiAdj = Math.max(-0.1, Math.min(0.1, ofiNow / 200));
            const lBullAdj = Math.max(0.05, Math.min(0.95, lBull + ofiAdj));
            const bayesianPosterior = (lBullAdj * 0.5) / ((lBullAdj * 0.5) + ((1 - lBullAdj) * 0.5));

            return {
                cvdBaseline: updatedBaseline,
                market: {
                    ...state.market,
                    candles: newCandles,
                    metrics: {
                        ...state.market.metrics,
                        price: tick.c,
                        institutionalCVD: newCvd,
                        zScore,
                        skewness,
                        kurtosis,
                        bayesianPosterior,
                        retailSentiment: rsiValue,
                        toxicity: vpinValue,
                        cvdContext: {
                            trend: cvdDelta > 0 ? 'UP' : 'DOWN',
                            divergence,
                            interpretation,
                            value: windowVol > 0 ? (cvdDelta / windowVol) * 100 : 0
                        }
                    }
                }
            };
        }

        // Mid-bar update: keep institutionalCVD and zScore in sync without heavy stats
        const mbCloses20 = newCandles.slice(-20).map(c => c.close);
        const mbMean20 = mbCloses20.reduce((a, b) => a + b, 0) / mbCloses20.length;
        const mbStd20 = Math.sqrt(mbCloses20.reduce((a, c) => a + Math.pow(c - mbMean20, 2), 0) / mbCloses20.length);
        const mbZScore = mbStd20 > 0 ? (tick.c - mbMean20) / mbStd20 : 0;

        return {
            market: {
                ...state.market,
                candles: newCandles,
                metrics: {
                    ...state.market.metrics,
                    price: tick.c,
                    institutionalCVD: state.cvdBaseline + realDelta,
                    zScore: mbZScore
                }
            }
        };
    }),

    processTradeTick: (trade) => set(state => {
        const trades = [trade, ...state.market.recentTrades].slice(0, 50);
        return {
            market: { ...state.market, recentTrades: trades }
        };
    }),

    processDepthUpdate: ({ asks, bids }) => set(state => {
        const bidVol = bids.reduce((acc, b) => acc + b.size, 0);
        const askVol = asks.reduce((acc, a) => acc + a.size, 0);
        const totalVol = bidVol + askVol;
        const imbalance = totalVol > 0 ? ((bidVol - askVol) / totalVol) * 100 : 0;

        const allLevels = [...asks, ...bids];
        const meanSize = allLevels.length > 0 ? allLevels.reduce((acc, l) => acc + l.size, 0) / allLevels.length : 0;
        const threshold = meanSize * 2.5;

        const classify = (l: OrderBookLevel) => {
            if (l.size > threshold) return 'WALL';
            if (l.size < meanSize * 0.1) return 'HOLE';
            return 'NORMAL';
        };

        return {
            market: {
                ...state.market,
                asks: asks.map(a => ({ ...a, classification: classify(a) as any })),
                bids: bids.map(b => ({ ...b, classification: classify(b) as any })),
                metrics: { ...state.market.metrics, ofi: imbalance }
            }
        };
    }),

    refreshHeatmap: async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/heatmap`);
            if (res.ok) {
                const heatmap = await res.json();
                set(state => ({ market: { ...state.market, metrics: { ...state.market.metrics, heatmap } } }));
            }
        } catch (e) {
            console.warn("Heatmap fetch failed");
        }
    },

    resetCvd: () => set(state => ({
        cvdBaseline: 0,
        market: { ...state.market, metrics: { ...state.market.metrics, institutionalCVD: 0 } }
    })),

    startAiScan: () => set(state => ({ ai: { ...state.ai, isScanning: true } })),
    completeAiScan: (result) => set(state => ({
        ai: {
            ...state.ai,
            isScanning: false,
            scanResult: result,
            lastScanTime: Date.now(),
            cooldownRemaining: 60
        }
    })),
    updateAiCooldown: (seconds) => set(state => ({ ai: { ...state.ai, cooldownRemaining: seconds } })),

    fetchOrderFlowAnalysis: async (payload) => {
        set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: true } } }));
        try {
            const res = await fetch(`${API_BASE_URL}/analyze/flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const analysis = await res.json();
                set(state => ({
                    ai: {
                        ...state.ai,
                        orderFlowAnalysis: {
                            isLoading: false,
                            verdict: analysis.verdict,
                            confidence: analysis.confidence,
                            explanation: analysis.explanation,
                            flowType: analysis.flow_type,
                            timestamp: Date.now()
                        }
                    }
                }));
            }
        } catch (e) {
            set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: false } } }));
        }
    },

    setUser: (user) => set(state => ({ auth: { ...state.auth, user } })),
    signInGoogle: async () => {
        try { await signInWithPopup(auth, googleProvider); } catch (e: any) {
            get().addNotification({ id: Date.now().toString(), type: 'error', title: 'Auth Failed', message: e.message });
        }
    },
    loginEmail: async (e, p) => { await signInWithEmailAndPassword(auth, e, p); },
    registerEmail: async (e, p, n) => {
        const res = await createUserWithEmailAndPassword(auth, e, p);
        if (res.user) { await updateProfile(res.user, { displayName: n }); }
    },
    logout: async () => { await signOut(auth); },
    updateUserProfile: async (data) => { set(state => ({ config: { ...state.config, ...data } })); },
    loadUserPreferences: async () => {
        try {
            const user = get().auth.user;
            if (user) {
                const snap = await getDoc(doc(db, 'users', user.uid));
                if (snap.exists()) set(s => ({ config: { ...s.config, ...snap.data().config } }));
            }
        } catch (e) { }
    },
    toggleRegistration: (isOpen) => set(state => ({ auth: { ...state.auth, registrationOpen: isOpen } })),
    initSystemConfig: () => { },

    openPosition: (params) => {
        const { entry, stop, target, direction } = params;
        const riskAmount = get().trading.accountSize * (get().trading.riskPercent / 100);
        const stopDistance = Math.abs(entry - stop);
        const size = stopDistance > 0 ? riskAmount / stopDistance : 0;

        set(state => ({
            trading: {
                ...state.trading, activePosition: {
                    id: Date.now().toString(),
                    symbol: get().config.activeSymbol,
                    direction, entry, stop, target, size, riskAmount,
                    isOpen: true, openTime: Date.now(), floatingR: 0, unrealizedPnL: 0
                }
            }
        }));
    },
    closePosition: (price) => set(state => {
        const pos = state.trading.activePosition;
        if (!pos) return {};
        const pnl = pos.direction === 'LONG' ? (price - pos.entry) * pos.size : (pos.entry - price) * pos.size;
        const r = pnl / pos.riskAmount;
        const newStats = { ...state.trading.dailyStats };
        newStats.totalR += r;
        newStats.realizedPnL += pnl;
        if (r > 0) newStats.wins++; else newStats.losses++;
        newStats.tradesToday++;
        // Track worst single-trade loss as max drawdown in R
        if (r < 0 && Math.abs(r) > newStats.maxDrawdownR) {
            newStats.maxDrawdownR = Math.abs(r);
        }
        return {
            trading: { ...state.trading, activePosition: null, accountSize: state.trading.accountSize + pnl, dailyStats: newStats }
        };
    }),
    setRiskPercent: (pct) => set(state => ({ trading: { ...state.trading, riskPercent: pct } })),

    refreshBiasMatrix: async () => {
        set(state => ({ biasMatrix: { ...state.biasMatrix, isLoading: true } }));
        const candles = get().market.candles;
        // Map interval string to minutes so window sizes match real timeframes
        const _itvToMins: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 };
        const _curMins = _itvToMins[get().config.interval] || 1;

        const calculateBiasForWindow = (windowSize: number): TimeframeData => {
            if (candles.length < Math.max(windowSize, 20)) {
                return { bias: 'NEUTRAL', sparkline: new Array(20).fill(50), lastUpdated: Date.now() };
            }
            const slice = candles.slice(-windowSize);
            const closes = slice.map(c => c.close);
            const rsi = calculateRSI(closes, 14);

            // Safety: ensure SMA calculation has data
            const sma = closes.length > 0 ? (closes.reduce((a, b) => a + b, 0) / closes.length) : 0;
            const current = closes.length > 0 ? (closes[closes.length - 1] ?? 0) : 0;

            let bias: BiasType = 'NEUTRAL';
            if (current > sma && rsi > 55) bias = 'BULL';
            else if (current < sma && rsi < 45) bias = 'BEAR';

            return {
                bias,
                sparkline: closes.slice(-20),
                lastUpdated: Date.now()
            };
        };

        set(state => {
            const updatedBiasMatrix: BiasMatrixState = {
                ...state.biasMatrix,
                isLoading: false,
                lastUpdated: Date.now(),
                daily: calculateBiasForWindow(Math.max(20, Math.round(1440 / _curMins))),
                h4: calculateBiasForWindow(Math.max(14, Math.round(240 / _curMins))),
                h1: calculateBiasForWindow(Math.max(14, Math.round(60 / _curMins))),
                m5: calculateBiasForWindow(Math.max(5, Math.round(5 / _curMins))),
            };
            return { biasMatrix: updatedBiasMatrix };
        });
    },
    refreshLiquidityAnalysis: () => set(state => {
        const candles = state.market.candles;
        if (candles.length < 10) return {};

        const N = 5; // swing lookback in bars
        const MAX_PER_TYPE = 8;
        const now = Date.now();
        const lastCandle = candles[candles.length - 1];

        // --- FVG Detection: 3-bar imbalance pattern, scan last 60 bars ---
        const fvgEvents: FairValueGap[] = [];
        const fvgScanStart = Math.max(2, candles.length - 60);
        for (let i = fvgScanStart; i < candles.length; i++) {
            const prev2 = candles[i - 2];
            const curr = candles[i];
            if (curr.low > prev2.high) {
                fvgEvents.push({
                    id: `fvg-bull-${curr.time}`,
                    startPrice: prev2.high,
                    endPrice: curr.low,
                    direction: 'BULLISH',
                    resolved: lastCandle.close < prev2.high,
                    timestamp: now,
                    candleTime: curr.time
                });
            } else if (curr.high < prev2.low) {
                fvgEvents.push({
                    id: `fvg-bear-${curr.time}`,
                    startPrice: curr.high,
                    endPrice: prev2.low,
                    direction: 'BEARISH',
                    resolved: lastCandle.close > prev2.low,
                    timestamp: now,
                    candleTime: curr.time
                });
            }
        }

        // --- Swing High/Low Identification ---
        const swingHighs: { price: number; idx: number; time: number | string }[] = [];
        const swingLows: { price: number; idx: number; time: number | string }[] = [];
        for (let i = N; i < candles.length; i++) {
            const c = candles[i];
            let isHigh = true, isLow = true;
            // Look-left: full N bars; look-right: as many as available (no forced N-bar right window)
            const rightEnd = Math.min(i + N, candles.length - 1);
            for (let j = i - N; j <= rightEnd; j++) {
                if (j === i) continue;
                if (candles[j].high >= c.high) isHigh = false;
                if (candles[j].low <= c.low) isLow = false;
            }
            if (isHigh) swingHighs.push({ price: c.high, idx: i, time: c.time });
            if (isLow) swingLows.push({ price: c.low, idx: i, time: c.time });
        }

        // --- BOS + Sweep Detection from swing points ---
        const bosEvents: BreakOfStructure[] = [];
        const sweepEvents: SweepEvent[] = [];

        // Check last 5 swing highs: first subsequent candle triggering BOS or sweep wins
        for (const sh of swingHighs.slice(-5)) {
            for (let i = sh.idx + 1; i < candles.length; i++) {
                const c = candles[i];
                if (c.close > sh.price) {
                    bosEvents.push({ id: `bos-bull-${c.time}`, price: sh.price, direction: 'BULLISH', timestamp: now, candleTime: c.time });
                    break;
                }
                if (c.high > sh.price && c.close <= sh.price) {
                    sweepEvents.push({ id: `sweep-buy-${c.time}`, price: sh.price, side: 'BUY', timestamp: now, candleTime: c.time });
                    break;
                }
            }
        }

        // Check last 5 swing lows
        for (const sl of swingLows.slice(-5)) {
            for (let i = sl.idx + 1; i < candles.length; i++) {
                const c = candles[i];
                if (c.close < sl.price) {
                    bosEvents.push({ id: `bos-bear-${c.time}`, price: sl.price, direction: 'BEARISH', timestamp: now, candleTime: c.time });
                    break;
                }
                if (c.low < sl.price && c.close >= sl.price) {
                    sweepEvents.push({ id: `sweep-sell-${c.time}`, price: sl.price, side: 'SELL', timestamp: now, candleTime: c.time });
                    break;
                }
            }
        }

        return {
            liquidity: {
                sweeps: sweepEvents.slice(-MAX_PER_TYPE),
                bos: bosEvents.slice(-MAX_PER_TYPE),
                fvg: fvgEvents.slice(-MAX_PER_TYPE),
                lastUpdated: now
            }
        };
    }),
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
            },
            market: { ...state.market, metrics: { ...state.market.metrics, regime: analysis.type } }
        };
    }),
    refreshTacticalAnalysis: () => set(state => {
        const matrix = state.biasMatrix;
        const regimeType = state.regime.regimeType;
        const trendDir = state.regime.trendDirection;
        const ofi = state.market.metrics.ofi;

        let prob = 50;
        let scenario: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

        // Algorithmic Confluence Scoring
        let bullScore = 0;
        if (matrix.daily?.bias === 'BULL') bullScore += 10;
        if (matrix.h4?.bias === 'BULL') bullScore += 10;
        if (matrix.h1?.bias === 'BULL') bullScore += 10;
        if (regimeType === 'TRENDING' && trendDir === 'BULL') bullScore += 30;
        if (ofi > 20) bullScore += 20;

        let bearScore = 0;
        if (matrix.daily?.bias === 'BEAR') bearScore += 10;
        if (matrix.h4?.bias === 'BEAR') bearScore += 10;
        if (matrix.h1?.bias === 'BEAR') bearScore += 10;
        if (regimeType === 'TRENDING' && trendDir === 'BEAR') bearScore += 30;
        if (ofi < -20) bearScore += 20;

        // Liquidity sweep cross-scoring (both vars declared above)
        // A BUY-side sweep (wick above swing high, close back inside) = bearish reversal signal
        if (state.liquidity.sweeps.some((s: any) => s.side === 'BUY')) bearScore += 15;
        // A SELL-side sweep (wick below swing low, close back inside) = bullish reversal signal
        if (state.liquidity.sweeps.some((s: any) => s.side === 'SELL')) bullScore += 15;

        if (bullScore > bearScore) {
            prob = 50 + (bullScore / 2);
            scenario = 'BULLISH';
        } else if (bearScore > bullScore) {
            prob = 50 + (bearScore / 2);
            scenario = 'BEARISH';
        }

        const currentPrice = state.market.metrics.price;
        const atr = state.regime.atr || currentPrice * 0.005;

        return {
            aiTactical: {
                ...state.aiTactical,
                symbol: state.config.activeSymbol,
                lastUpdated: Date.now(),
                probability: Math.min(prob, 95),
                scenario,
                entryLevel: currentPrice,
                stopLevel: scenario === 'BULLISH' ? currentPrice - (atr * 1.5) : currentPrice + (atr * 1.5),
                exitLevel: scenario === 'BULLISH' ? currentPrice + (atr * 3) : currentPrice - (atr * 3),
                confidenceFactors: {
                    biasAlignment: bullScore > 20 || bearScore > 20,
                    liquidityAgreement: state.liquidity.sweeps.length > 0,
                    regimeAgreement: regimeType === 'TRENDING',
                    aiScore: Math.min(prob / 100, 1)
                }
            }
        };
    }),

    addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
    removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),
    logAlert: async (alert) => set(state => ({ alertLogs: [alert, ...state.alertLogs].slice(0, 50) }))
}));