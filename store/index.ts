import { create } from 'zustand';
import {
    MarketMetrics, CandleData, RecentTrade, OrderBookLevel, TradeSignal, PriceLevel,
    AiScanResult, ToastMessage, Position, DailyStats, BiasMatrixState,
    LiquidityState, RegimeState, AiTacticalState, ExpectedValueData, TimeframeData,
    BiasType, SweepEvent, BreakOfStructure, FairValueGap, MacroStrategyState, BotSettingsState,
    DarkPoolState, BotTrade
} from '../types';
import { MOCK_METRICS, API_BASE_URL, DARK_POOL_THRESHOLDS } from '../constants';
import { analyzeRegime, calculateRSI } from '../utils/analytics';
import { auth, googleProvider, db } from '../lib/firebase';
import {
    signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, updateProfile, User
} from 'firebase/auth';
import { doc, getDoc, collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';

// ── Centralised constants (used across store + components) ──────────────────
/** Skewness magnitude considered statistically significant — used by Bayesian, Macro, Sentinel, UI */
export const SKEW_SIGNIFICANT = 0.3;

// ── Module-level refs (not reactive, used for inter-frame coordination) ──────
/** Most recent OFI value written by processDepthUpdate, read by processWsTick Bayesian calc */
let _latestOfi = 0;
/** Timestamp of the last Z-Score divergence notification, to throttle spam */
let _lastZDivAlertMs = 0;
const Z_DIV_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

interface AppState {
    ui: {
        activeTab: string;
        hasEntered: boolean;
        isProfileOpen: boolean;
        theme?: 'dark' | 'light';
        soundEnabled?: boolean;
        volume?: number;
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
    macroStrategy: MacroStrategyState;
    botSettings: BotSettingsState;
    notifications: ToastMessage[];
    alertLogs: any[];
    darkPool: DarkPoolState;
    /** Rolling -1 to +1 bias from dark pool, used by SentinelPanel and BiasMatrix */
    darkPoolBias: number;
    /** Bot trade history from Firestore botTrades collection */
    botTrades: BotTrade[];
    /** Bot live console logs from Firestore botLogs collection */
    botLogs: any[];

    cvdBaseline: number;

    /** Cumulative OFI — running sum of OFI delta ticks, resets to 0 via resetCvd */
    cofi: number;
    /** Rolling OFI history for multi-timeframe convergence (last 60 readings) */
    ofiHistory: number[];

    setHasEntered: (val: boolean) => void;
    setActiveTab: (tab: string) => void;
    setProfileOpen: (isOpen: boolean) => void;
    setSymbol: (symbol: string) => void;
    setInterval: (interval: string) => void;
    toggleBacktest: () => void;
    setPlaybackSpeed: (speed: number) => void;
    setBacktestDate: (date: string) => void;
    setAiModel: (model: string) => void;

    setTheme: (theme: 'dark' | 'light') => void;
    toggleSound: () => void;
    setVolume: (vol: number) => void;
    setConfig: (config: Partial<AppState['config']>) => void;
    setBotSettings: (settings: Partial<BotSettingsState>) => void;

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
    fetchMacroStrategyAnalysis: (payload: any) => Promise<void>;

    addNotification: (toast: ToastMessage) => void;
    removeNotification: (id: string) => void;
    logAlert: (alert: any) => Promise<void>;

    fetchDarkPoolData: () => Promise<void>;
    startDarkPoolPolling: () => () => void;
    /** Subscribe to Firestore botTrades and sync chart levels */
    subscribeToBotTrades: () => () => void;
    /** Subscribe to Firestore botLogs for live terminal UI */
    subscribeToBotLogs: () => () => void;
    /** Subscribe to live bot status (heartbeat) */
    subscribeToBotStatus: () => () => void;
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
        aiModel: 'gemini-2.0-flash',
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
    macroStrategy: {
        aiResult: null,
        isLoading: false,
        lastUpdated: 0,
    },
    botSettings: {
        isActive: false,
        exchange: 'coinbase',
        environment: 'live',
        tradingPair: 'BTC-USD',
        maxRiskPerTradePct: 1.0,
        maxDailyLossPct: 3.0,
        analysisIntervalSec: 15,
        minConfidence: 0.70,
        accountSize: 100,
        ulisGateEnabled: true,
        status: 'OFFLINE',
        activePositions: 0,
        lastUlis: '—',
    },
    notifications: [],
    alertLogs: [],
    botTrades: [],
    botLogs: [],
    cvdBaseline: 0,
    cofi: 0,
    ofiHistory: [],
    darkPoolBias: 0,
    darkPool: {
        whaleFeed: [],
        blockTrades: [],
        biasHistory: [],
        inflowOutflow: [],
        isLoading: false,
        isSimulated: true,
        lastUpdated: 0,
    },

    setHasEntered: (val) => set(state => ({ ui: { ...state.ui, hasEntered: val } })),
    setActiveTab: (tab) => set(state => ({ ui: { ...state.ui, activeTab: tab } })),
    setProfileOpen: (isOpen) => set(state => ({ ui: { ...state.ui, isProfileOpen: isOpen } })),
    setSymbol: (symbol) => set(state => ({ config: { ...state.config, activeSymbol: symbol } })),
    setInterval: (interval) => set(state => ({ config: { ...state.config, interval } })),
    toggleBacktest: () => set(state => ({ config: { ...state.config, isBacktest: !state.config.isBacktest } })),
    setPlaybackSpeed: (speed) => set(state => ({ config: { ...state.config, playbackSpeed: speed } })),
    setBacktestDate: (date) => set(state => ({ config: { ...state.config, backtestDate: date } })),
    setAiModel: (model) => set(state => ({ config: { ...state.config, aiModel: model } })),

    setTheme: (theme) => set((state) => ({ ui: { ...state.ui, theme } })),
    toggleSound: () => set((state) => ({ ui: { ...state.ui, soundEnabled: !state.ui.soundEnabled } })),
    setVolume: (volume) => set((state) => ({ ui: { ...state.ui, volume } })),
    setConfig: (newConfig) => set((state) => ({ config: { ...state.config, ...newConfig } })),
    setBotSettings: (newSettings) => set((state) => ({
        botSettings: { ...state.botSettings, ...newSettings }
    })),

    setMarketHistory: ({ candles, initialCVD }) => {
        // Bug Fix #4: Reset CVD baseline and COFI on every symbol/interval change
        // so stale baseline from a previous symbol doesn't pollute the new feed.
        _latestOfi = 0;

        // Compute RSI (retailSentiment) and VPIN (toxicity) from the initial historical data
        const closes = candles.map(c => c.close);
        const rsiOnLoad = calculateRSI(closes, 14);
        const vpinSlice = candles.slice(-20);
        const vpinOnLoad = Math.min(100, (vpinSlice.reduce((acc, c) => {
            const vol = c.volume || 0;
            return acc + (vol > 0 ? Math.abs(c.delta || 0) / vol : 0);
        }, 0) / Math.max(vpinSlice.length, 1)) * 100);

        set(state => ({
            // Bug Fix #4: Reset CVD accumulator state alongside market history
            cvdBaseline: initialCVD,
            cofi: 0,
            ofiHistory: [],
            market: {
                ...state.market,
                candles,
                metrics: {
                    ...state.market.metrics,
                    institutionalCVD: initialCVD,
                    retailSentiment: rsiOnLoad,
                    toxicity: vpinOnLoad,
                    ofi: 0
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
                high: Math.max(last.high, tick.h),
                low: Math.min(last.low, tick.l),
                volume: tick.v,
                delta: realDelta,
                cvd: updatedCvd
            };
        } else if (tickTimeSec > last.time) {
            const updatedBaseline = state.cvdBaseline + (last.delta || 0);
            const newCvd = updatedBaseline + realDelta;
            const newOfiHistory = [...state.ofiHistory, _latestOfi].slice(-60);

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

            // FIX #2: Skewness on LOG RETURNS (not price levels)
            const closes51 = allCloses.slice(-51);
            const returns50 = closes51.slice(1).map((c, i) => Math.log(c / closes51[i]));
            const n50 = returns50.length;
            const rMean = n50 > 0 ? returns50.reduce((a, b) => a + b, 0) / n50 : 0;
            const rStd = n50 > 1 ? Math.sqrt(returns50.reduce((a, r) => a + Math.pow(r - rMean, 2), 0) / n50) : 0;
            const skewness = rStd > 0.000001 ? returns50.reduce((a, r) => a + Math.pow((r - rMean) / rStd, 3), 0) / n50 : 0;
            const kurtosis = rStd > 0.000001 ? returns50.reduce((a, r) => a + Math.pow((r - rMean) / rStd, 4), 0) / n50 - 3 : 0;

            // FIX #3: Z-Score anchored to VWAP (consistent with chart bands)
            const window20 = newCandles.slice(-20);
            const typicals20 = window20.map(c => (c.high + c.low + c.close) / 3);
            let vwapNum = 0, vwapDen = 0;
            for (let j = 0; j < window20.length; j++) {
                const vol = window20[j].volume || 1;
                vwapNum += typicals20[j] * vol;
                vwapDen += vol;
            }
            const vwap20 = vwapDen > 0 ? vwapNum / vwapDen : tick.c;
            
            // Volume-weighted std anchored to VWAP
            let vwVarSum = 0;
            for (let j = 0; j < window20.length; j++) {
                const vol = window20[j].volume || 1;
                vwVarSum += vol * Math.pow(typicals20[j] - vwap20, 2);
            }
            const vwapStd = vwapDen > 0 ? Math.sqrt(vwVarSum / vwapDen) : 0;
            const zScore = vwapStd > 0 ? (tick.c - vwap20) / vwapStd : 0;

            // --- RSI (retailSentiment) — computed fresh on every new bar ---
            const allClosesRSI = newCandles.map(c => c.close);
            const rsiValue = calculateRSI(allClosesRSI, 14);

            // --- VPIN / Toxicity: rolling |delta| / volume over last 20 bars ---
            const vpinWindow = newCandles.slice(-20);
            const vpinValue = Math.min(100, (vpinWindow.reduce((acc, c) => {
                const vol = c.volume || 0;
                return acc + (vol > 0 ? Math.abs(c.delta || 0) / vol : 0);
            }, 0) / Math.max(vpinWindow.length, 1)) * 100);

            // Multi-factor Bayesian Posterior P(bull|evidence)
            // Each indicator contributes an independent likelihood update.
            // Bug Fix #2: Use _latestOfi (module-level ref written by processDepthUpdate)
            // instead of state.market.metrics.ofi which lags by one WebSocket frame.
            const L_rsi = rsiValue > 55 ? 3.0 : rsiValue < 45 ? 0.333 : 1.0;
            const L_ofi = _latestOfi > 10 ? 1.5 : _latestOfi < -10 ? 0.667 : 1.0;
            const L_z = zScore < -1.5 ? 1.6 : zScore > 1.5 ? 0.625 : 1.0;
            // Bug Fix #8: Use centralised SKEW_SIGNIFICANT constant (0.3) for consistency
            const L_skew = skewness > SKEW_SIGNIFICANT ? 1.2 : skewness < -SKEW_SIGNIFICANT ? 0.833 : 1.0;
            // Prior: 0.5, Posterior = unnormalized likelihood product
            const bullOdds = 1.0 * L_rsi * L_ofi * L_z * L_skew; // prior odds = 1 (i.e. 0.5/0.5)
            const bayesianPosterior = bullOdds / (bullOdds + 1.0); // [0,1]

            // ─── Z-Score Divergence Detection ──────────────────────────────
            // Alert when price makes a new 10-bar high/low but Z-Score doesn't confirm.
            // Bug Fix #9: Gate with Z_DIV_COOLDOWN_MS (10 min) to prevent flooding
            // every bar when a sustained divergence condition exists.
            if (newCandles.length >= 10) {
                const recent10 = newCandles.slice(-10);
                const prevHighs = newCandles.slice(-11, -1).map(c => c.high);
                const prevLows = newCandles.slice(-11, -1).map(c => c.low);

                const curr10High = Math.max(...recent10.map(c => c.high));
                const curr10Low = Math.min(...recent10.map(c => c.low));
                const prev10High = Math.max(...prevHighs);
                const prev10Low = Math.min(...prevLows);

                const nowMs = Date.now();
                const canFireZDiv = nowMs - _lastZDivAlertMs > Z_DIV_COOLDOWN_MS;

                if (canFireZDiv && curr10High > prev10High && zScore < -0.5) {
                    _lastZDivAlertMs = nowMs;
                    setTimeout(() => get().addNotification({
                        id: `zdiv-bear-${nowMs}`,
                        type: 'warning',
                        title: '⚡ Z-Score Divergence',
                        message: `Price new high but Z=${zScore.toFixed(2)}σ — potential bearish fakeout`
                    }), 0);
                } else if (canFireZDiv && curr10Low < prev10Low && zScore > 0.5) {
                    _lastZDivAlertMs = nowMs;
                    setTimeout(() => get().addNotification({
                        id: `zdiv-bull-${nowMs}`,
                        type: 'warning',
                        title: '⚡ Z-Score Divergence',
                        message: `Price new low but Z=+${zScore.toFixed(2)}σ — potential bullish fakeout`
                    }), 0);
                }
            }

            return {
                cvdBaseline: updatedBaseline,
                ofiHistory: newOfiHistory,
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
        const prev19 = newCandles.length >= 20 ? newCandles.slice(-20, -1) : newCandles.slice(0, -1);
        const currTypical = (tick.h + tick.l + tick.c) / 3.0;
        
        let mbVwapNum = 0, mbVwapDen = 0, sumTyp = 0;
        for (let j = 0; j < prev19.length; j++) {
            const tCost = (prev19[j].high + prev19[j].low + prev19[j].close) / 3.0;
            const vol = prev19[j].volume || 1;
            mbVwapNum += tCost * vol;
            mbVwapDen += vol;
            sumTyp += tCost;
        }
        
        mbVwapNum += currTypical * (tick.v || 1);
        mbVwapDen += (tick.v || 1);
        sumTyp += currTypical;
        
        const mbVwap20 = mbVwapDen > 0 ? mbVwapNum / mbVwapDen : tick.c;
        
        let mbVwVarSum = (tick.v || 1) * Math.pow(currTypical - mbVwap20, 2);
        for (let j = 0; j < prev19.length; j++) {
            const tCost = (prev19[j].high + prev19[j].low + prev19[j].close) / 3.0;
            const vol = prev19[j].volume || 1;
            mbVwVarSum += vol * Math.pow(tCost - mbVwap20, 2);
        }
        const mbStd20 = mbVwapDen > 0 ? Math.sqrt(mbVwVarSum / mbVwapDen) : 0;
        const mbZScore = mbStd20 > 0 ? (tick.c - mbVwap20) / mbStd20 : 0;

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
        // ─── Sort defensively: asks ascending (best ask = [0]), bids descending (best bid = [0])
        const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
        const sortedBids = [...bids].sort((a, b) => b.price - a.price);

        const bestAsk = sortedAsks[0]?.price ?? 0;
        const bestBid = sortedBids[0]?.price ?? 0;
        const midPrice = (bestAsk + bestBid) / 2 || 1;

        // ─── Signal 1: Proximity-weighted depth imbalance
        // Levels closer to mid-price carry exponentially more weight.
        // Decay constant k: each additional level away reduces weight by ~18%.
        const k = 0.18;
        let weightedBid = 0, weightedAsk = 0;
        sortedBids.forEach((b, i) => { weightedBid += b.size * Math.exp(-k * i); });
        sortedAsks.forEach((a, i) => { weightedAsk += a.size * Math.exp(-k * i); });
        const totalWeighted = weightedBid + weightedAsk;
        const depthImbalance = totalWeighted > 0 ? ((weightedBid - weightedAsk) / totalWeighted) * 100 : 0;

        // ─── Signal 2: Delta-OFI (Cont et al. microstructure definition)
        // OFI = Σ bid_delta where price ≥ bestBid - Σ ask_delta where price ≤ bestAsk
        // a positive bid delta at best bid = aggressive buying pressure
        // a positive ask delta at best ask = new supply added (bearish)
        let deltaOfiRaw = 0;
        sortedBids.forEach(b => {
            if (b.price >= bestBid) deltaOfiRaw += (b.delta ?? 0);   // bid reinforced at top = bullish
        });
        sortedAsks.forEach(a => {
            if (a.price <= bestAsk) deltaOfiRaw -= (a.delta ?? 0);   // ask reinforced at top = bearish
        });

        // Normalise delta OFI to [-100, 100] using a rolling vol estimate (mid * 0.001 as proxy unit)
        const deltaUnit = midPrice * 0.001 || 1;
        const deltaOfi = Math.max(-100, Math.min(100, (deltaOfiRaw / deltaUnit) * 10));

        // ─── Composite OFI: 60% depth imbalance + 40% delta signal
        const ofi = (depthImbalance * 0.6) + (deltaOfi * 0.4);

        // Bug Fix #2: Keep module-level ref in sync so processWsTick Bayesian reads current OFI
        _latestOfi = ofi;

        // ─── Wall / Hole classification using per-side median (robust to outliers)
        const allLevels = [...sortedAsks, ...sortedBids];
        const sorted = [...allLevels].map(l => l.size).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] || 1;
        // Bug Fix #5: Add absolute floor based on notional value to prevent over-classification
        // during thin-market sessions where the median itself collapses to near zero.
        // Floor = 0.15% of mid-price in USD equivalent (e.g. ~$143 for BTC @ $95k)
        const absoluteFloor = midPrice * 0.0015;
        const baseWallThreshold = Math.max(median * 4, absoluteFloor);   // >4× median = significant wall
        const holeThreshold = median * 0.15; // <15% median = liquidity hole

        const classify = (l: OrderBookLevel, index: number) => {
            // Apply exponential penalty to wall threshold based on distance from spread
            // Deeper orders must be significantly larger to be classified as a wall (mitigates spoofing)
            const penalizedThreshold = baseWallThreshold * Math.exp(k * index);

            if (l.size > penalizedThreshold) return 'WALL';
            if (l.size < holeThreshold) return 'HOLE';
            return 'NORMAL';
        };

        // ─── COFI: accumulate OFI delta ─────────────────────────────────────
        const prevOfi = state.market.metrics.ofi || 0;
        const newCofi = state.cofi + ofi - prevOfi;

        return {
            cofi: newCofi,
            market: {
                ...state.market,
                asks: sortedAsks.map((a, i) => ({ ...a, classification: classify(a, i) as any })),
                bids: sortedBids.map((b, i) => ({ ...b, classification: classify(b, i) as any })),
                metrics: { ...state.market.metrics, ofi: Math.round(ofi * 10) / 10 }
            }
        };
    }),

    refreshHeatmap: async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/heatmap`, {
                headers: { 'X-API-Key': (import.meta as any).env.VITE_BACKEND_API_KEY || '' }
            });
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
        cofi: 0,
        ofiHistory: [],
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

        // ── Deterministic Order Flow Analysis Engine ─────────────────────────
        // Simulates 150ms processing delay for UX realism
        await new Promise(r => setTimeout(r, 150));

        const { netDelta, totalVolume, pocPrice, cvdTrend, candleCount, price, symbol } = payload;

        // ── Factor 1: Delta/Volume ratio (absorption detection) ──────────────
        // If large volume but low delta → hidden absorption (contra-directional)
        const dvRatio = totalVolume > 0 ? Math.abs(netDelta) / totalVolume : 0;
        // dvRatio < 0.2 = high absorption, > 0.5 = aggressive directional
        const isAbsorption = dvRatio < 0.2 && totalVolume > 0;
        const isAggressive = dvRatio > 0.5;

        // ── Factor 2: Net Delta direction and magnitude ──────────────────────
        const deltaDir = netDelta > 0 ? 'BULL' : netDelta < 0 ? 'BEAR' : 'NEUTRAL';
        const deltaStrong = Math.abs(netDelta) > totalVolume * 0.3;

        // ── Factor 3: CVD trend direction ────────────────────────────────────
        const cvdBull = cvdTrend === 'UP';
        const cvdBear = cvdTrend === 'DOWN';
        const cvdFlat = cvdTrend === 'FLAT';

        // ── Factor 4: Price vs POC (mean-reversion setup) ────────────────────
        const pocPct = pocPrice > 0 ? ((price - pocPrice) / pocPrice) * 100 : 0;
        const abovePOC = pocPct > 0.05;  // price stretched above POC
        const belowPOC = pocPct < -0.05; // price stretched below POC
        const atPOC = !abovePOC && !belowPOC;

        // ── Composite scoring ────────────────────────────────────────────────
        let bullScore = 0;
        let bearScore = 0;

        // Delta direction (primary signal)
        if (deltaDir === 'BULL') bullScore += deltaStrong ? 30 : 15;
        else if (deltaDir === 'BEAR') bearScore += deltaStrong ? 30 : 15;

        // CVD momentum
        if (cvdBull) bullScore += 25;
        else if (cvdBear) bearScore += 25;

        // Absorption context — flips interpretation
        if (isAbsorption) {
            // High volume, low net delta = hidden contra-directional pressure
            if (abovePOC) bearScore += 20; // absorbing sells above POC = bearish
            if (belowPOC) bullScore += 20; // absorbing buys below POC = bullish
        }

        // Aggressive flow reinforces trend
        if (isAggressive && cvdBull && deltaDir === 'BULL') bullScore += 15;
        if (isAggressive && cvdBear && deltaDir === 'BEAR') bearScore += 15;

        // POC gravity — price above POC in a bull run adds confidence; below in bear adds confidence
        if (abovePOC && cvdBull) bullScore += 10;
        if (belowPOC && cvdBear) bearScore += 10;
        // Price far from POC with contra-delta = mean reversion signal
        if (abovePOC && deltaDir === 'BEAR') bearScore += 15;
        if (belowPOC && deltaDir === 'BULL') bullScore += 15;

        const totalScore = bullScore + bearScore;
        const edge = Math.abs(bullScore - bearScore);
        const minEdge = 15;

        let rawVerdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
        if (bullScore > bearScore && edge >= minEdge) rawVerdict = 'BULLISH';
        else if (bearScore > bullScore && edge >= minEdge) rawVerdict = 'BEARISH';

        const confidence = totalScore > 0 ? Math.min(0.5 + (edge / totalScore) * 0.45, 0.97) : 0.5;

        // ── Flow type classification ──────────────────────────────────────────
        let flowType = 'MIXED';
        if (isAbsorption) flowType = 'ABSORPTION';
        else if (isAggressive && !cvdFlat) flowType = 'AGGRESSIVE';
        else if (cvdFlat && atPOC) flowType = 'CONSOLIDATION';
        else if (cvdBull || cvdBear) flowType = 'MOMENTUM';

        // ── Natural-language explanation (AI-grade quality) ──────────────────
        const deltaFmt = (netDelta > 0 ? '+' : '') + Math.round(netDelta).toLocaleString();
        const volFmt = Math.round(totalVolume).toLocaleString();
        const pocFmt = pocPrice.toFixed(2);
        const priceFmt = price.toFixed(2);
        const pocPctFmt = (pocPct > 0 ? '+' : '') + pocPct.toFixed(2) + '%';

        const lines: string[] = [];

        // Opening — what the data shows
        if (rawVerdict === 'BULLISH') {
            lines.push(`📈 Order flow is net bullish for ${symbol}. Net delta is ${deltaFmt} over ${candleCount} candles with ${volFmt} total volume — buyers are in control.`);
        } else if (rawVerdict === 'BEARISH') {
            lines.push(`📉 Order flow is net bearish for ${symbol}. Net delta is ${deltaFmt} over ${candleCount} candles with ${volFmt} total volume — sellers are dominating aggressor activity.`);
        } else {
            lines.push(`⚖️ Order flow for ${symbol} is balanced. Net delta of ${deltaFmt} relative to ${volFmt} total volume indicates no clear directional conviction at this time.`);
        }

        // CVD trend context
        if (cvdBull) lines.push(`The Cumulative Volume Delta (CVD) is trending up, confirming that buyers have been the consistent aggressor across the session.`);
        else if (cvdBear) lines.push(`The CVD trend is declining, confirming persistent sell-side aggression. This is not a single-candle spike — it represents sustained directional pressure.`);
        else lines.push(`CVD is flat (${cvdTrend}), indicating that buying and selling aggression have been roughly offsetting. No momentum edge from CVD.`);

        // Absorption analysis
        if (isAbsorption) {
            lines.push(`⚠️ High-volume absorption is detected (D/V ratio: ${dvRatio.toFixed(2)}). Large volume is trading without producing proportional delta — this signals hidden ${rawVerdict === 'BULLISH' ? 'buying demand absorbing offers' : 'selling pressure absorbing bids'}. This is often seen at inflection points.`);
        } else if (isAggressive) {
            lines.push(`Flow aggression is high (D/V ratio: ${dvRatio.toFixed(2)}). Initiators are hitting ${deltaDir === 'BULL' ? 'asks aggressively — urgency is present on the buy side' : 'bids aggressively — urgency is present on the sell side'}.`);
        }

        // POC context
        if (atPOC) {
            lines.push(`Price (${priceFmt}) is near the Point of Control (${pocFmt}), the highest-volume price node. This is a decision zone — expect either rejection or a breakout with volume confirmation.`);
        } else if (abovePOC) {
            lines.push(`Price is ${pocPctFmt} above the POC (${pocFmt}). ${rawVerdict === 'BULLISH' ? 'Buyers are accepting value above POC, suggesting confidence in new highs.' : 'Despite being above POC, sell-side pressure is building — a reversion back to POC at ' + pocFmt + ' is plausible.'}`);
        } else {
            lines.push(`Price is ${pocPctFmt} below the POC (${pocFmt}). ${rawVerdict === 'BEARISH' ? 'Sellers are accepting lower value, suggesting a structural shift lower.' : 'Price is below POC but buy-side flow is strengthening — a snapback to POC (' + pocFmt + ') is the primary target.'}`);
        }

        // Conclusion
        lines.push(`\nVerdict: ${rawVerdict} | Confidence: ${(confidence * 100).toFixed(0)}% | Flow: ${flowType}`);
        if (rawVerdict === 'BULLISH') lines.push(`Watch for: sustained CVD expansion, price acceptance above ${pocFmt}, and OFI > +10 as confirmation. Invalidated if CVD rolls over and delta goes negative.`);
        else if (rawVerdict === 'BEARISH') lines.push(`Watch for: CVD continuation down, price rejection at ${pocFmt}, and OFI < -10. Invalidated if buyers step in and delta turns strongly positive.`);
        else lines.push(`Remain patient. Wait for a clear delta directional break combined with CVD trend confirmation before committing to a directional bias.`);

        const explanation = lines.join('\n\n');

        set(state => ({
            ai: {
                ...state.ai,
                orderFlowAnalysis: {
                    isLoading: false,
                    verdict: rawVerdict,
                    confidence,
                    explanation,
                    flowType,
                    timestamp: Date.now()
                }
            }
        }));
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
                if (snap.exists()) {
                    const data = snap.data();
                    const restoredBot = { ...data.botSettings };
                    // Recalculate status from isActive so it's consistent after refresh
                    if (restoredBot && restoredBot.isActive !== undefined) {
                        restoredBot.status = restoredBot.isActive ? 'ONLINE' : 'OFFLINE';
                    }
                    set(s => ({
                        config: { ...s.config, ...data.config },
                        botSettings: { ...s.botSettings, ...restoredBot }
                    }));
                }
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

        /**
         * Bug Fix #3: Bias matrix timeframe resolution guard.
         * If the current chart interval is COARSER than the target timeframe window
         * (e.g. viewing 1h chart and asking for M5 bias = 5-bar window = 5 hours),
         * the result is meaningless. Return a special marker so the UI can show
         * "Insufficient Resolution" instead of a mislabeled bias signal.
         */
        const calculateBiasForWindow = (windowSize: number, targetMins: number): TimeframeData => {
            // Guard: current interval is coarser than target timeframe
            if (_curMins > targetMins) {
                return {
                    bias: 'NEUTRAL' as BiasType,
                    sparkline: [],
                    lastUpdated: Date.now(),
                    insufficientResolution: true
                } as TimeframeData;
            }

            if (candles.length < Math.max(windowSize, 20)) {
                return { bias: 'NEUTRAL', sparkline: new Array(20).fill(50), lastUpdated: Date.now() };
            }
            const slice = candles.slice(-windowSize);
            const closes = slice.map(c => c.close);
            const rsi = calculateRSI(closes, 14);

            // Safety: ensure SMA calculation has data
            const sma = closes.length > 0 ? (closes.reduce((a, b) => a + b, 0) / closes.length) : 0;
            const current = closes.length > 0 ? (closes[closes.length - 1] ?? 0) : 0;

            // CVD direction within this window (cumulative delta)
            let windowCvdDelta = 0;
            const midIndex = Math.floor(slice.length / 2);
            for (let i = midIndex; i < slice.length; i++) {
                windowCvdDelta += (slice[i].delta || 0);
            }

            // 3-factor scoring: price vs SMA (structural), RSI (momentum), CVD delta (flow)
            let bullFactors = 0;
            let bearFactors = 0;
            if (current > sma) bullFactors++; else if (current < sma) bearFactors++;
            if (rsi > 55) bullFactors++; else if (rsi < 45) bearFactors++;
            if (windowCvdDelta > 0) bullFactors++; else if (windowCvdDelta < 0) bearFactors++;

            let bias: BiasType = 'NEUTRAL';
            if (bullFactors >= 2) bias = 'BULL';
            else if (bearFactors >= 2) bias = 'BEAR';

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
                daily: calculateBiasForWindow(Math.max(20, Math.round(1440 / _curMins)), 1440),
                h4: calculateBiasForWindow(Math.max(14, Math.round(240 / _curMins)), 240),
                h1: calculateBiasForWindow(Math.max(14, Math.round(60 / _curMins)), 60),
                m5: calculateBiasForWindow(Math.max(5, Math.round(5 / _curMins)), 5),
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
        const regime = state.regime;
        const metrics = state.market.metrics;

        // ── Pull all signals ──────────────────────────────────────────────────
        const ofi = metrics.ofi || 0;
        const zScore = metrics.zScore || 0;
        const bayes = metrics.bayesianPosterior || 0.5;
        const cvd = metrics.institutionalCVD || 0;
        const skewness = metrics.skewness || 0;
        const regimeType = regime.regimeType;
        const trendDir = regime.trendDirection;
        const price = metrics.price;
        const atr = regime.atr || price * 0.005;

        // ── Multi-factor Bull/Bear scoring (max 100 points each side) ─────────
        let bullScore = 0;
        let bearScore = 0;

        // Timeframe bias alignment (daily=20, H4=15, H1=10, M5=5)
        if (matrix.daily?.bias === 'BULL') bullScore += 20; else if (matrix.daily?.bias === 'BEAR') bearScore += 20;
        if (matrix.h4?.bias === 'BULL') bullScore += 15; else if (matrix.h4?.bias === 'BEAR') bearScore += 15;
        if (matrix.h1?.bias === 'BULL') bullScore += 10; else if (matrix.h1?.bias === 'BEAR') bearScore += 10;
        if (matrix.m5?.bias === 'BULL') bullScore += 5; else if (matrix.m5?.bias === 'BEAR') bearScore += 5;

        // Regime (trend alignment = high conviction)
        if (regimeType === 'TRENDING' && trendDir === 'BULL') bullScore += 20;
        else if (regimeType === 'TRENDING' && trendDir === 'BEAR') bearScore += 20;
        else if (regimeType === 'MEAN_REVERTING') {
            // Mean reversion: strong z-score drives the opposite direction signal
            if (zScore > 2.0) bearScore += 15;
            else if (zScore < -2.0) bullScore += 15;
        }

        // OFI (normalised: >15 = meaningful, >30 = strong)
        if (ofi > 15) bullScore += Math.min(15, Math.round(ofi / 3));
        else if (ofi < -15) bearScore += Math.min(15, Math.round(-ofi / 3));

        // Bayesian posterior (>0.6 = bull conviction, <0.4 = bear)
        if (bayes > 0.65) bullScore += 15;
        else if (bayes > 0.55) bullScore += 8;
        else if (bayes < 0.35) bearScore += 15;
        else if (bayes < 0.45) bearScore += 8;

        // CVD direction
        if (cvd > 50000) bullScore += 10;
        else if (cvd > 20000) bullScore += 5;
        else if (cvd < -50000) bearScore += 10;
        else if (cvd < -20000) bearScore += 5;

        // Z-Score extreme (mean reversion signal, lower weight when trending)
        const zWeight = regimeType === 'TRENDING' ? 4 : 8;
        if (zScore > 2.0) bearScore += zWeight;  // overbought → bearish
        else if (zScore < -2.0) bullScore += zWeight; // oversold → bullish

        // Skewness (negative skew = downside distribution = bearish)
        if (skewness < -0.5) bearScore += 6;
        else if (skewness > 0.5) bullScore += 6;

        // Liquidity sweep cross-scoring
        // BUY sweep (highs taken, close back below = BEARISH reversal)
        if (state.liquidity.sweeps.some((s: any) => s.side === 'BUY')) bearScore += 10;
        // SELL sweep (lows taken, close back above = BULLISH reversal)
        if (state.liquidity.sweeps.some((s: any) => s.side === 'SELL')) bullScore += 10;

        // BOS alignment boosts
        const latestBOS = state.liquidity.bos?.[state.liquidity.bos.length - 1];
        if (latestBOS?.direction === 'BULLISH') bullScore += 8;
        else if (latestBOS?.direction === 'BEARISH') bearScore += 8;

        // ── Determine dominant scenario ──────────────────────────────────────
        let scenario: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
        const edge = Math.abs(bullScore - bearScore);

        if (bullScore > bearScore && edge >= 10) scenario = 'BULLISH';
        else if (bearScore > bullScore && edge >= 10) scenario = 'BEARISH';

        // ── Probability calculation ──────────────────────────────────────────
        // Map dominant score (0→100) to probability range 50→95
        const maxPossible = 124; // maximum achievable score with all factors
        const dominantScore = Math.max(bullScore, bearScore);
        const edgeRatio = Math.min(dominantScore / maxPossible, 1);
        // Scale to 50–95 range (no system should claim >95% certainty)
        const prob = scenario === 'NEUTRAL' ? 50 : Math.round(50 + edgeRatio * 45);

        // ── Fragility-adjusted R:R ───────────────────────────────────────────
        // High fragility = wider stops needed (less favourable R:R)
        const zAbs = Math.abs(zScore);
        const fragilityFactor = 1 + Math.min(zAbs / 3, 0.5); // 1.0→1.5
        const slMult = 1.5 * fragilityFactor;
        const tpMult = slMult * (prob > 75 ? 3 : prob > 60 ? 2.5 : 2); // TP scales with conviction

        // Bug Fix #6: Compute Expected Value (E.V.) from the tactical levels.
        // This was previously always null, breaking the EV checklist item in SentinelPanel.
        const stopLevel = scenario === 'BULLISH'
            ? price - (atr * slMult)
            : price + (atr * slMult);
        const exitLevel = scenario === 'BULLISH'
            ? price + (atr * tpMult)
            : price - (atr * tpMult);

        const stopDistance = Math.abs(price - stopLevel);
        const targetDistance = Math.abs(exitLevel - price);
        const rrRatio = stopDistance > 0 ? targetDistance / stopDistance : 0;
        // Win probability derived from tactical score (capped at 0.75 to avoid overconfidence)
        const winProb = Math.min(0.75, prob / 100);
        const computedEV: ExpectedValueData = {
            ev: (winProb * targetDistance) - ((1 - winProb) * stopDistance),
            winProbability: winProb,
            lossAmount: stopDistance,
            winAmount: targetDistance,
            rrRatio
        };

        return {
            aiTactical: {
                ...state.aiTactical,
                symbol: state.config.activeSymbol,
                lastUpdated: Date.now(),
                probability: Math.min(prob, 95),
                scenario,
                entryLevel: price,
                stopLevel,
                exitLevel,
                confidenceFactors: {
                    biasAlignment: (bullScore >= 30 || bearScore >= 30),
                    liquidityAgreement: state.liquidity.sweeps.length > 0,
                    regimeAgreement: regimeType !== 'UNCERTAIN',
                    aiScore: Math.min(edgeRatio, 1)
                }
            },
            market: {
                ...state.market,
                // Bug Fix #6 continued: write expectedValue to market slice so SentinelPanel receives it
                expectedValue: scenario !== 'NEUTRAL' ? computedEV : null
            }
        };
    }),

    fetchMacroStrategyAnalysis: async (payload) => {
        set(state => ({ macroStrategy: { ...state.macroStrategy, isLoading: true } }));

        // ── Deterministic Macro Strategy Engine ─────────────────────────────
        // 150ms processing delay for UX realism
        await new Promise(r => setTimeout(r, 150));

        const { symbol, price, skewness, bayesianPosterior, zScore, rsi, ofi, cvd, tapeSpeed, tapeDominant, wallContext } = payload;

        // ── Factor scoring ───────────────────────────────────────────────────
        let bullScore = 0;
        let bearScore = 0;
        const signals: string[] = [];

        // 1. Bayesian Posterior P(Bull|Evidence) — strongest signal
        if (bayesianPosterior > 0.65) { bullScore += 25; signals.push(`Bayesian P(Bull)=${(bayesianPosterior * 100).toFixed(1)}% — strong upside evidence`); }
        else if (bayesianPosterior > 0.55) { bullScore += 12; signals.push(`Bayesian P(Bull)=${(bayesianPosterior * 100).toFixed(1)}% — mild bullish lean`); }
        else if (bayesianPosterior < 0.35) { bearScore += 25; signals.push(`Bayesian P(Bull)=${(bayesianPosterior * 100).toFixed(1)}% — strong downside evidence`); }
        else if (bayesianPosterior < 0.45) { bearScore += 12; signals.push(`Bayesian P(Bull)=${(bayesianPosterior * 100).toFixed(1)}% — mild bearish lean`); }
        else signals.push(`Bayesian is neutral (${(bayesianPosterior * 100).toFixed(1)}%)`);

        // 2. OFI — real-time flow pressure
        if (ofi > 25) { bullScore += 20; signals.push(`OFI=${ofi.toFixed(1)} — strong buy-side depth imbalance`); }
        else if (ofi > 10) { bullScore += 10; signals.push(`OFI=${ofi.toFixed(1)} — mild buy pressure`); }
        else if (ofi < -25) { bearScore += 20; signals.push(`OFI=${ofi.toFixed(1)} — strong sell-side depth imbalance`); }
        else if (ofi < -10) { bearScore += 10; signals.push(`OFI=${ofi.toFixed(1)} — mild sell pressure`); }
        else signals.push(`OFI=${ofi.toFixed(1)} — balanced order book`);

        // 3. CVD — session-level aggressed flow
        if (cvd > 50000) { bullScore += 15; signals.push(`CVD=${Math.round(cvd).toLocaleString()} — institutional buyer dominance`); }
        else if (cvd > 10000) { bullScore += 7; signals.push(`CVD=${Math.round(cvd).toLocaleString()} — slight buy aggression`); }
        else if (cvd < -50000) { bearScore += 15; signals.push(`CVD=${Math.round(cvd).toLocaleString()} — institutional seller dominance`); }
        else if (cvd < -10000) { bearScore += 7; signals.push(`CVD=${Math.round(cvd).toLocaleString()} — slight sell aggression`); }
        else signals.push(`CVD=${Math.round(cvd).toLocaleString()} — balanced`);

        // 4. Z-Score (mean-reversion vs trend context)
        // |Z| > 2.5 = sentiment wash (MEAN_REVERSAL candidate)
        const isMeanReversal = Math.abs(zScore) >= 2.5;
        if (zScore > 2.5) { bearScore += 20; signals.push(`Z-Score=${zScore.toFixed(2)} — extreme overbought, mean-reversion risk`); }
        else if (zScore > 1.0) { bullScore += 10; signals.push(`Z-Score=${zScore.toFixed(2)} — above VWAP, trending bullish`); }
        else if (zScore < -2.5) { bullScore += 20; signals.push(`Z-Score=${zScore.toFixed(2)} — extreme oversold, snap-back potential`); }
        else if (zScore < -1.0) { bearScore += 10; signals.push(`Z-Score=${zScore.toFixed(2)} — below VWAP, trending bearish`); }
        else signals.push(`Z-Score=${zScore.toFixed(2)} — near VWAP, neutral zone`);

        // 5. Skewness — tail risk direction
        if (skewness < -0.3) { bearScore += 12; signals.push(`Skewness=${skewness.toFixed(3)} — negative tail: downside risk skewed`); }
        else if (skewness < -0.1) { bearScore += 5; signals.push(`Mild negative skewness (${skewness.toFixed(3)})`); }
        else if (skewness > 0.3) { bullScore += 12; signals.push(`Skewness=${skewness.toFixed(3)} — positive tail: upside potential skewed`); }
        else if (skewness > 0.1) { bullScore += 5; signals.push(`Mild positive skewness (${skewness.toFixed(3)})`); }
        else signals.push(`Skewness ~0 — symmetric return distribution`);

        // 6. RSI (sentiment oscillator)
        if (rsi < 30) { bullScore += 10; signals.push(`RSI=${Math.round(rsi)} — capitulation zone (high mean-reversion probability)`); }
        else if (rsi >= 55 && rsi < 70) { bullScore += 8; signals.push(`RSI=${Math.round(rsi)} — healthy bullish momentum`); }
        else if (rsi >= 70) { bearScore += 10; signals.push(`RSI=${Math.round(rsi)} — overbought — exhaustion risk`); }
        else if (rsi < 45) { bearScore += 8; signals.push(`RSI=${Math.round(rsi)} — bearish momentum reset`); }
        else signals.push(`RSI=${Math.round(rsi)} — neutral (45–55 band)`);

        // 7. Tape speed + LOB walls (microstructure)
        if (tapeSpeed === 'SCREAMING') {
            if (tapeDominant === 'BUY (ASK HIT)') { bullScore += 10; signals.push(`Tape SCREAMING — aggressive buy side hitting asks`); }
            else if (tapeDominant === 'SELL (BID HIT)') { bearScore += 10; signals.push(`Tape SCREAMING — aggressive sell side hitting bids`); }
            else signals.push(`Tape SCREAMING but balanced — potential delta divergence`);
        }

        // ── Verdict routing ──────────────────────────────────────────────────
        const totalScore = bullScore + bearScore;
        const dominantEdge = Math.abs(bullScore - bearScore);
        const confidence = totalScore > 0 ? Math.min(0.50 + (dominantEdge / totalScore) * 0.45, 0.97) : 0.50;

        let verdict: string;
        if (isMeanReversal && dominantEdge < 15) {
            verdict = 'MEAN_REVERSAL';
        } else if (bullScore > bearScore && dominantEdge >= 12) {
            verdict = 'BUY';
        } else if (bearScore > bullScore && dominantEdge >= 12) {
            verdict = 'SELL';
        } else {
            verdict = 'NEUTRAL';
        }

        // ── Generate analysis text ────────────────────────────────────────────
        const priceStr = price.toFixed(2);
        const confPct = (confidence * 100).toFixed(0);

        let opening = '';
        if (verdict === 'BUY') opening = `📈 Macro strategy for ${symbol} at ${priceStr} is BULLISH (${confPct}% confidence). The statistical and microstructure evidence aligns to the upside. Asset is showing directional bias with multiple confirming factors.`;
        else if (verdict === 'SELL') opening = `📉 Macro strategy for ${symbol} at ${priceStr} is BEARISH (${confPct}% confidence). Multiple quantitative filters are negatively aligned — risk is tilted to the downside.`;
        else if (verdict === 'MEAN_REVERSAL') opening = `🔄 Macro strategy for ${symbol} at ${priceStr} signals a MEAN REVERSAL (${confPct}% confidence). Price has stretched significantly from statistical fair value (Z-Score: ${zScore.toFixed(2)}), and conflicting flows suggest an imminent snap-back.`;
        else opening = `⚖️ Macro strategy for ${symbol} at ${priceStr} is NEUTRAL (${confPct}% confidence). Signals are mixed or below threshold — no high-conviction directional edge is present at this time.`;

        const signalBlock = signals.slice(0, 6).map((s, i) => `${i + 1}. ${s}`).join('\n');

        let conclusion = '';
        if (verdict === 'BUY') conclusion = `Bias is LONG. Monitor for OFI remaining positive and CVD expansion. Invalidated if Z-Score crosses above +2.5 (sentiment wash) or Bayesian drops below 0.50.`;
        else if (verdict === 'SELL') conclusion = `Bias is SHORT. Watch for CVD acceleration to the downside. Position invalidation: Bayesian rises above 0.55 or OFI flips positive with tape buying.`;
        else if (verdict === 'MEAN_REVERSAL') conclusion = `Do NOT chase the trend at this extension. Wait for a close back toward the VWAP baseline or a delta reversal print. ${zScore > 0 ? 'Target: reversion to VWAP and potential flip to short if Bayesian collapses.' : 'Target: snap-back toward VWAP. Watch for positive delta as buyers absorb the sell pressure.'}`;
        else conclusion = `Await a Bayesian directional break (>0.60 or <0.40), OFI exceeding ±15, and Z-Score trending away from 0 before committing to a trade.`;

        const analysis = `${opening}\n\nActive Signals:\n${signalBlock}\n\nWall Context: ${wallContext}\n\n${conclusion}`;

        set(state => ({
            macroStrategy: {
                ...state.macroStrategy,
                isLoading: false,
                aiResult: { verdict, confidence, analysis },
                lastUpdated: Date.now()
            }
        }));
    },

    addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
    removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),
    logAlert: async (alert) => set(state => ({ alertLogs: [alert, ...state.alertLogs].slice(0, 50) })),

    // ── Dark Pool / Institutional Radar ─────────────────────────────────────
    fetchDarkPoolData: async () => {
        set(state => ({ darkPool: { ...state.darkPool, isLoading: true } }));

        try {
            // Call the backend proxy — keeps WHALE_ALERT_API_KEY server-side
            const res = await fetch(`${API_BASE_URL}/whale-alerts`, {
                headers: { 'X-API-Key': (import.meta as any).env.VITE_BACKEND_API_KEY || '' }
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }

            const data = await res.json();
            // Backend shape: { whaleFeed, blockTrades, inflowOutflow, rawBias, isReal }

            const rawBias: number = data.rawBias ?? 0;
            const prevHistory = get().darkPool.biasHistory;
            const biasHistory = [...prevHistory, rawBias].slice(-20);

            set({
                darkPool: {
                    whaleFeed: data.whaleFeed ?? [],
                    blockTrades: data.blockTrades ?? [],
                    inflowOutflow: data.inflowOutflow ?? [],
                    biasHistory,
                    isLoading: false,
                    isSimulated: !(data.isReal),
                    lastUpdated: Date.now(),
                },
                darkPoolBias: rawBias,
            });

        } catch (e: any) {
            console.error('[DarkPool] fetch error:', e.message);
            // Leave existing data intact, just clear the loading flag
            set(state => ({
                darkPool: { ...state.darkPool, isLoading: false }
            }));
        }
    },

    startDarkPoolPolling: () => {
        const { fetchDarkPoolData } = get();
        fetchDarkPoolData(); // immediate first fetch
        const id = setInterval(fetchDarkPoolData, DARK_POOL_THRESHOLDS.POLL_INTERVAL_MS);
        return () => clearInterval(id);
    },

    subscribeToBotTrades: () => {
        const q = query(
            collection(db, 'botTrades'),
            orderBy('ts_ms', 'desc'),
            limit(50)
        );
        const unsub = onSnapshot(q, (snap) => {
            const trades: BotTrade[] = snap.docs.map(d => ({
                id: d.id,
                ...(d.data() as Omit<BotTrade, 'id'>),
            }));
            set({ botTrades: trades });

            // ── Sync active bot trade levels to chart ─────────────────────
            // The latest trade (index 0 after desc sort) represents the bot's
            // most recent position. Push its entry / SL / TP as PriceLevel
            // items so the chart draws them automatically.
            if (trades.length > 0) {
                const latest = trades[0];
                const botLevels: PriceLevel[] = [
                    {
                        price: latest.entry_price,
                        type: 'ENTRY',
                        label: `Bot Entry (${latest.verdict})`,
                    },
                    {
                        price: latest.stop_loss,
                        type: 'STOP_LOSS',
                        label: 'Bot Stop Loss',
                    },
                    {
                        price: latest.take_profit,
                        type: 'TAKE_PROFIT',
                        label: 'Bot Take Profit',
                    },
                ];
                set(state => ({
                    market: {
                        ...state.market,
                        levels: [
                            // Remove old bot levels, keep any user-placed levels
                            ...state.market.levels.filter(
                                l => !l.label?.startsWith('Bot ')
                            ),
                            ...botLevels,
                        ],
                    },
                }));
            }
        }, (err) => {
            console.warn('[Store] botTrades subscription error:', err);
        });
        return unsub;
    },

    subscribeToBotLogs: () => {
        const q = query(
            collection(db, 'botLogs'),
            orderBy('ts_ms', 'desc'),
            limit(50)
        );
        const unsub = onSnapshot(q, (snap) => {
            const logs = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
            }));
            const sorted = logs.sort((a: any, b: any) => a.ts_ms - b.ts_ms);
            set({ botLogs: sorted });
        }, (err) => {
            console.warn('[Store] botLogs subscription error:', err);
        });
        return unsub;
    },

    subscribeToBotStatus: () => {
        const unsub = onSnapshot(doc(db, 'botStatus', 'live'), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                set((state) => ({
                    botSettings: {
                        ...state.botSettings,
                        status: data.isRunning ? 'ONLINE' : 'OFFLINE',
                        lastHeartbeat: data.lastHeartbeat?.toMillis ? data.lastHeartbeat.toMillis() : Date.now(),
                        exchange: data.exchange || state.botSettings.exchange,
                        tradingPair: data.symbol || state.botSettings.tradingPair,
                        botMode: data.mode,
                        environment: data.environment,
                        activePositions: data.activePositions || 0,
                        totalTrades: data.totalTrades || 0,
                        lastSignal: data.lastSignal || 'WAIT',
                        lastUlis: data.lastUlis || '—',
                    }
                }));
            }
        }, (err) => {
            console.warn('[Store] botStatus subscription error:', err);
        });
        return unsub;
    },
}));
