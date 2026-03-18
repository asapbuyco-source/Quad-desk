//+------------------------------------------------------------------+
//|                                                  QuadDeskEA.mq5 |
//|                              Quad Desk — Hybrid Quant EA v1.0   |
//|                                                                  |
//|  Strategy: 6-Stage Hybrid Quant (mirrors Python bot/main.py)    |
//|    1. Feature Engine  — ATR, RSI, VWAP Z-Score, Skewness, CVD  |
//|    2. Regime Detection — TREND | RANGE | LIQUIDITY | NEUTRAL    |
//|    3. Sweep Detection  — ABOVE_HIGHS | BELOW_LOWS               |
//|    4. Strategy Layer   — Trend / Mean Reversion / Sweep Rev.    |
//|    5. Bayesian Fusion  — sequential probability update           |
//|    6. Risk Engine      — ATR-based SL, 2R TP, daily loss guard  |
//+------------------------------------------------------------------+
#property copyright "Quad Desk"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Arrays\ArrayDouble.mqh>

//═══════════════════════════════════════════════════════════════════
// INPUT PARAMETERS
//═══════════════════════════════════════════════════════════════════
input group "── Core Settings ──────────────────────────────────────"
input ENUM_TIMEFRAMES InpTimeframe       = PERIOD_M1;     // Analysis Timeframe
input int             InpAnalysisSeconds = 10;            // Cycle interval (seconds)
input int             InpMinCandles      = 60;            // Minimum candles to warm up

input group "── Risk Management ────────────────────────────────────"
input double          InpMaxRiskPct      = 1.0;           // Max risk per trade (% of equity)
input double          InpMaxDailyLossPct = 3.0;           // Max daily loss before halt (% equity)
input double          InpMinConfidence   = 0.60;          // Minimum Bayesian confidence to trade
input double          InpMinRR           = 2.0;           // Minimum Risk:Reward ratio

input group "── Regime Thresholds ──────────────────────────────────"
input double          InpTrendAtrPct     = 0.006;         // ATR% threshold for TREND regime (0.6%)
input double          InpWallProximity   = 0.001;         // LOB wall proximity for LIQUIDITY regime (0.1%)
input double          InpRangePct        = 1.5;           // |Z-Score| ceiling for RANGE regime
input double          InpMeanRevZ        = 2.5;           // Z-Score for Mean Reversion signal
input int             InpOFILevels       = 10;            // Order book levels to inspect for OFI

input group "── Strategy Weights ───────────────────────────────────"
// Trend Strategy score thresholds
input double          InpTrendBuyScore   = 2.0;           // Min score to BUY in trend
input double          InpTrendSellScore  = -2.0;          // Max score to SELL in trend
// Sweep confirmation thresholds
input double          InpSweepOFIMin     = 5.0;           // OFI confirmation threshold for sweeps

input group "── Display ─────────────────────────────────────────────"
input bool            InpShowPanel       = true;          // Show info panel on chart
input color           InpBuyColor        = clrLimeGreen;  // BUY signal color
input color           InpSellColor       = clrTomato;     // SELL signal color
input color           InpWaitColor       = clrGold;       // WAIT color

//═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
//═══════════════════════════════════════════════════════════════════
CTrade   Trade;
CPositionInfo PosInfo;

datetime g_LastCycleTime   = 0;
double   g_DailyStartEquity = 0;
bool     g_DailyLossHalt   = false;
datetime g_CurrentDay      = 0;

// Stats for panel display
string   g_LastVerdict     = "WAITING";
double   g_LastConfidence  = 0;
double   g_LastSL          = 0;
double   g_LastTP          = 0;
string   g_LastRegime      = "---";
string   g_LastAnalysis    = "Warming up...";
int      g_TotalTrades     = 0;

// Tick accumulation for CVD and Tape
double   g_CVD             = 0;
double   g_BuyVol10s       = 0;
double   g_SellVol10s      = 0;
double   g_TotalVol60s     = 0;
datetime g_LastTickTime    = 0;

//═══════════════════════════════════════════════════════════════════
// EA LIFECYCLE
//═══════════════════════════════════════════════════════════════════
int OnInit()
{
    Trade.SetExpertMagicNumber(202500);
    Trade.SetDeviationInPoints(20);

    g_DailyStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
    g_CurrentDay       = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
    g_LastCycleTime    = 0;

    Print("[QuadDeskEA] Initialized on ", Symbol(), " / ", EnumToString(InpTimeframe));
    Print("[QuadDeskEA] Min confidence: ", InpMinConfidence, " | Max risk: ", InpMaxRiskPct, "%");

    if (InpShowPanel) DrawPanel("INITIALIZING", clrGold);

    return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
    ObjectsDeleteAll(0, "QD_");
    Print("[QuadDeskEA] Deinitialized. Total trades: ", g_TotalTrades);
}

void OnTick()
{
    // ── Accumulate tick data for CVD / Tape ──────────────────────
    AccumulateTick();

    // ── Only run analysis cycle every InpAnalysisSeconds ─────────
    datetime now = TimeCurrent();
    if ((int)(now - g_LastCycleTime) < InpAnalysisSeconds) return;
    g_LastCycleTime = now;

    // ── Daily reset check ─────────────────────────────────────────
    CheckDailyReset();

    // ── Daily loss guard ──────────────────────────────────────────
    if (!CheckDailyLoss()) return;

    // ── Candle warmup guard ───────────────────────────────────────
    int totalBars = iBars(Symbol(), InpTimeframe);
    if (totalBars < InpMinCandles)
    {
        string msg = StringFormat("Warming up... %d/%d candles", totalBars, InpMinCandles);
        if (InpShowPanel) DrawPanel(msg, InpWaitColor);
        return;
    }

    // ══════════════════════════════════════════════════════════════
    // ALREADY IN A POSITION — SKIP NEW SIGNALS
    // ══════════════════════════════════════════════════════════════
    if (HasOpenPosition())
    {
        UpdatePanelForHolding();
        return;
    }

    // ══════════════════════════════════════════════════════════════
    // STAGE 1: FEATURE ENGINE
    // ══════════════════════════════════════════════════════════════
    double price    = SymbolInfoDouble(Symbol(), SYMBOL_BID);
    double atr      = CalcATR(14);
    double atr_pct  = (price > 0) ? atr / price : 0;
    double rsi      = CalcRSI(14);
    double z_score  = CalcVWAPZScore(20, price);
    double skewness = CalcSkewness(50);
    double ofi      = CalcOFI();

    // ══════════════════════════════════════════════════════════════
    // STAGE 2: REGIME DETECTION
    // ══════════════════════════════════════════════════════════════
    double nearestBuyWall  = 0;
    double nearestSellWall = 0;
    double bestBuySize     = 0;
    double bestSellSize    = 0;
    GetLOBWalls(price, nearestBuyWall, nearestSellWall, bestBuySize, bestSellSize);

    string regime = DetectRegime(price, z_score, atr_pct, nearestBuyWall, nearestSellWall);
    g_LastRegime  = regime;

    // ══════════════════════════════════════════════════════════════
    // STAGE 3: LIQUIDITY SWEEP DETECTION
    // ══════════════════════════════════════════════════════════════
    string sweep = DetectSweep(price, nearestBuyWall, nearestSellWall);

    // ══════════════════════════════════════════════════════════════
    // STAGE 4: STRATEGY LAYER — META MODEL
    // ══════════════════════════════════════════════════════════════
    string rawDirection = "";
    string strategyType = "NEUTRAL";

    double bayes    = CalcBayesian(rsi, ofi, z_score, skewness);
    string tapeDom  = GetTapeDominant();
    string tapeSpd  = GetTapeSpeed();

    if (sweep != "")
    {
        strategyType = "LIQUIDITY_SWEEP";
        rawDirection = StrategySweep(sweep, ofi, g_CVD, tapeDom);
    }
    else if (regime == "TREND")
    {
        strategyType = "TREND";
        rawDirection = StrategyTrend(bayes, ofi, g_CVD, tapeDom);
    }
    else if (regime == "RANGE")
    {
        strategyType = "MEAN_REVERSION";
        rawDirection = StrategyMeanReversion(z_score, rsi);
    }

    if (rawDirection == "")
    {
        g_LastVerdict    = "WAIT";
        g_LastConfidence = 0;
        g_LastAnalysis   = StringFormat("Regime=%s Strategy=%s — no edge", regime, strategyType);
        if (InpShowPanel) DrawPanel(g_LastAnalysis, InpWaitColor);
        return;
    }

    // ══════════════════════════════════════════════════════════════
    // STAGE 5: BAYESIAN SIGNAL FUSION
    // ══════════════════════════════════════════════════════════════
    double confidence = BayesianFusion(rawDirection, ofi, g_CVD, tapeDom, tapeSpd, skewness, rsi);
    g_LastConfidence  = confidence;

    if (confidence < InpMinConfidence)
    {
        g_LastVerdict  = "WAIT";
        g_LastAnalysis = StringFormat(
            "Regime=%s dir=%s P=%.0f%% < threshold=%.0f%%",
            regime, rawDirection, confidence * 100, InpMinConfidence * 100
        );
        if (InpShowPanel) DrawPanel(g_LastAnalysis, InpWaitColor);
        return;
    }

    // ══════════════════════════════════════════════════════════════
    // STAGE 6: RISK ENGINE — SL / TP
    // ══════════════════════════════════════════════════════════════
    bool   isLong    = (rawDirection == "BUY" || rawDirection == "MEAN_REVERSAL_LONG");
    double stopLoss  = 0;
    double takeProfit = 0;
    CalcSlTp(rawDirection, strategyType, price, atr,
             nearestBuyWall, nearestSellWall, sweep,
             stopLoss, takeProfit);

    // Sanity check geometry
    if (isLong  && (stopLoss >= price || takeProfit <= price)) { LogWait("Invalid LONG SL/TP geometry"); return; }
    if (!isLong && (stopLoss <= price || takeProfit >= price)) { LogWait("Invalid SHORT SL/TP geometry"); return; }

    // RR filter
    double risk   = MathAbs(price - stopLoss);
    double reward = MathAbs(takeProfit - price);
    if (risk <= 0 || (reward / risk) < InpMinRR) { LogWait(StringFormat("RR=%.1f < %.1f — skip", reward/risk, InpMinRR)); return; }

    // ══════════════════════════════════════════════════════════════
    // EXECUTE
    // ══════════════════════════════════════════════════════════════
    double lots = CalcLotSize(price, stopLoss);
    if (lots <= 0) { LogWait("Lot size = 0"); return; }

    g_LastVerdict = rawDirection;
    g_LastSL      = stopLoss;
    g_LastTP      = takeProfit;
    g_LastAnalysis = StringFormat(
        "Regime=%s Str=%s | %s @ %.5f | P=%.0f%% | SL=%.5f TP=%.5f | Z=%.2f RSI=%.1f OFI=%.1f",
        regime, strategyType, rawDirection, price, confidence * 100,
        stopLoss, takeProfit, z_score, rsi, ofi
    );

    Print("[QuadDeskEA] >> ", g_LastAnalysis);

    if (isLong)
        PlaceBuy(lots, stopLoss, takeProfit);
    else
        PlaceSell(lots, stopLoss, takeProfit);

    color panelColor = isLong ? InpBuyColor : InpSellColor;
    if (InpShowPanel) DrawPanel(g_LastAnalysis, panelColor);
}

//═══════════════════════════════════════════════════════════════════
// STAGE 1: FEATURE ENGINE — INDICATOR CALCULATIONS
//═══════════════════════════════════════════════════════════════════

double CalcATR(int period)
{
    double atr[];
    int handle = iATR(Symbol(), InpTimeframe, period);
    if (handle == INVALID_HANDLE) return 0;
    if (CopyBuffer(handle, 0, 0, 2, atr) < 2) return 0;
    IndicatorRelease(handle);
    return atr[0];
}

double CalcRSI(int period)
{
    double rsi[];
    int handle = iRSI(Symbol(), InpTimeframe, period, PRICE_CLOSE);
    if (handle == INVALID_HANDLE) return 50;
    if (CopyBuffer(handle, 0, 0, 2, rsi) < 2) return 50;
    IndicatorRelease(handle);
    return rsi[0];
}

double CalcVWAPZScore(int lookback, double currentPrice)
{
    double high[], low[], close[];
    long   tickVol[];          // CopyTickVolume requires long[]
    int bars = lookback;
    if (CopyHigh(Symbol(),      InpTimeframe, 0, bars, high)    < bars) return 0;
    if (CopyLow(Symbol(),       InpTimeframe, 0, bars, low)     < bars) return 0;
    if (CopyClose(Symbol(),     InpTimeframe, 0, bars, close)   < bars) return 0;
    if (CopyTickVolume(Symbol(), InpTimeframe, 0, bars, tickVol) < bars) return 0;

    double totalVolume = 0, totalTP = 0;
    double typical[];
    ArrayResize(typical, bars);
    for (int i = 0; i < bars; i++)
    {
        double vol = (double)tickVol[i];   // explicit cast: long → double
        typical[i] = (high[i] + low[i] + close[i]) / 3.0;
        totalTP     += typical[i] * vol;
        totalVolume += vol;
    }
    if (totalVolume <= 0) return 0;
    double vwap = totalTP / totalVolume;

    // Standard deviation
    double sumSq = 0;
    for (int i = 0; i < bars; i++)
        sumSq += MathPow(typical[i] - vwap, 2);
    double stdDev = MathSqrt(sumSq / bars);
    if (stdDev <= 0) return 0;

    return (currentPrice - vwap) / stdDev;
}

double CalcSkewness(int n)
{
    double close[];
    if (CopyClose(Symbol(), InpTimeframe, 0, n + 1, close) < n + 1) return 0;

    // Log returns
    double returns[];
    ArrayResize(returns, n);
    int valid = 0;
    for (int i = 0; i < n; i++)
    {
        double prev = close[i + 1];
        double curr = close[i];
        if (prev <= 0 || curr <= 0) continue;
        returns[valid++] = MathLog(curr / prev);
    }
    if (valid < 3) return 0;

    double mean = 0;
    for (int i = 0; i < valid; i++) mean += returns[i];
    mean /= valid;

    double m2 = 0, m3 = 0;
    for (int i = 0; i < valid; i++)
    {
        double d = returns[i] - mean;
        m2 += d * d;
        m3 += d * d * d;
    }
    m2 /= valid;
    m3 /= valid;
    if (m2 <= 0) return 0;

    return m3 / MathPow(MathSqrt(m2), 3);
}

double CalcOFI()
{
    // OFI = sum of bid sizes - sum of ask sizes (near-spread only)
    MqlBookInfo book[];
    if (!MarketBookGet(Symbol(), book)) return 0;

    double price         = SymbolInfoDouble(Symbol(), SYMBOL_BID);
    double maxDist       = price * 0.005; // 0.5% from price
    double bidTotal = 0, askTotal = 0;
    int    bidsUsed = 0, asksUsed = 0;

    for (int i = 0; i < ArraySize(book); i++)
    {
        if (bidsUsed >= InpOFILevels && asksUsed >= InpOFILevels) break;
        if (book[i].type == BOOK_TYPE_BUY && MathAbs(price - book[i].price) <= maxDist && bidsUsed < InpOFILevels)
        {
            bidTotal += (double)book[i].volume;  // long → double
            bidsUsed++;
        }
        else if (book[i].type == BOOK_TYPE_SELL && MathAbs(book[i].price - price) <= maxDist && asksUsed < InpOFILevels)
        {
            askTotal += (double)book[i].volume;  // long → double
            asksUsed++;
        }
    }
    return bidTotal - askTotal;
}

void GetLOBWalls(double price,
                 double &buyWall, double &sellWall,
                 double &buySize, double &sellSize)
{
    buyWall  = 0; sellWall = 0;
    buySize  = 0; sellSize = 0;

    MqlBookInfo book[];
    if (!MarketBookGet(Symbol(), book)) return;

    double maxDist   = price * 0.005;  // 0.5% range
    double allSizes[];
    int    count = 0;

    // Collect all sizes to compute median
    for (int i = 0; i < ArraySize(book); i++)
    {
        double dist = (book[i].type == BOOK_TYPE_BUY)
                      ? MathAbs(price - book[i].price)
                      : MathAbs(book[i].price - price);
        if (dist <= maxDist)
        {
            ArrayResize(allSizes, count + 1);
            allSizes[count++] = (double)book[i].volume;  // long → double
        }
    }
    if (count == 0) return;

    // Simple median
    ArraySort(allSizes);
    double median        = allSizes[(int)(count / 2)];
    double wallThreshold = median * 5.0;

    for (int i = 0; i < ArraySize(book); i++)
    {
        double dist   = 0;
        double bvol   = (double)book[i].volume;  // long → double
        if (book[i].type == BOOK_TYPE_BUY)
        {
            dist = MathAbs(price - book[i].price);
            if (dist <= maxDist && bvol > wallThreshold && bvol > buySize)
            {
                buyWall = book[i].price;
                buySize = bvol;
            }
        }
        else if (book[i].type == BOOK_TYPE_SELL)
        {
            dist = MathAbs(book[i].price - price);
            if (dist <= maxDist && bvol > wallThreshold && bvol > sellSize)
            {
                sellWall = book[i].price;
                sellSize = bvol;
            }
        }
    }
}

//═══════════════════════════════════════════════════════════════════
// TICK ACCUMULATORS (CVD & TAPE SPEED)
//═══════════════════════════════════════════════════════════════════
void AccumulateTick()
{
    MqlTick tick;
    if (!SymbolInfoTick(Symbol(), tick)) return;

    if (g_LastTickTime == tick.time) return; // duplicate
    g_LastTickTime = tick.time;

    double tickVol = (double)tick.volume;           // long → double
    double vol     = tickVol * tick.bid;             // ~USD volume

    // Determine aggressor side from bid/ask movement
    static double lastBid = 0;
    bool buyAggress = (tick.bid >= lastBid); // simplified aggressiveness
    lastBid = tick.bid;

    if (buyAggress) { g_CVD += tickVol; g_BuyVol10s  += vol; }
    else            { g_CVD -= tickVol; g_SellVol10s += vol; }

    g_TotalVol60s += vol;

    // Decay 10s counters every second
    static datetime lastDecay = 0;
    datetime now = TimeCurrent();
    if ((int)(now - lastDecay) >= 10)
    {
        g_BuyVol10s  = 0;
        g_SellVol10s = 0;
        lastDecay    = now;
    }
}

string GetTapeDominant()
{
    if (g_BuyVol10s > g_SellVol10s * 1.5)  return "BUY";
    if (g_SellVol10s > g_BuyVol10s * 1.5)  return "SELL";
    return "BALANCED";
}

string GetTapeSpeed()
{
    double total10s   = g_BuyVol10s + g_SellVol10s;
    double baseline   = (g_TotalVol60s / 60.0) * 10;
    if (baseline > 0 && total10s > baseline * 3) return "SCREAMING";
    return "NORMAL";
}

//═══════════════════════════════════════════════════════════════════
// STAGE 2: MARKET REGIME DETECTION
//═══════════════════════════════════════════════════════════════════
string DetectRegime(double price, double z, double atr_pct,
                    double buyWall, double sellWall)
{
    // LIQUIDITY: price within 0.1% of a significant wall
    if (buyWall > 0  && MathAbs(price - buyWall)  / price <= InpWallProximity) return "LIQUIDITY";
    if (sellWall > 0 && MathAbs(price - sellWall) / price <= InpWallProximity) return "LIQUIDITY";

    // TREND: above threshold ATR + screaming tape
    string tape = GetTapeSpeed();
    if (atr_pct > InpTrendAtrPct && tape == "SCREAMING") return "TREND";

    // RANGE: Z-Score tightly bound
    if (MathAbs(z) < InpRangePct) return "RANGE";

    return "NEUTRAL";
}

//═══════════════════════════════════════════════════════════════════
// STAGE 3: LIQUIDITY SWEEP DETECTION
//═══════════════════════════════════════════════════════════════════
string DetectSweep(double price, double buyWall, double sellWall)
{
    // Requires 2 completed candles
    if (iBars(Symbol(), InpTimeframe) < 2) return "";

    double prevHigh = iHigh(Symbol(), InpTimeframe, 1);
    double prevLow  = iLow(Symbol(),  InpTimeframe, 1);

    // Sweep ABOVE highs: previous candle wick pierced sell wall; price now below
    if (sellWall > 0 && prevHigh > sellWall && price < sellWall)
    {
        Print("[QuadDeskEA] SWEEP ABOVE_HIGHS detected at ", sellWall);
        return "ABOVE_HIGHS";
    }

    // Sweep BELOW lows: previous candle wick pierced buy wall; price now above
    if (buyWall > 0 && prevLow < buyWall && price > buyWall)
    {
        Print("[QuadDeskEA] SWEEP BELOW_LOWS detected at ", buyWall);
        return "BELOW_LOWS";
    }

    return "";
}

//═══════════════════════════════════════════════════════════════════
// STAGE 4: STRATEGY LAYER
//═══════════════════════════════════════════════════════════════════

// Strategy A — Trend Following
string StrategyTrend(double bayes, double ofi, double cvd, string dominant)
{
    double score = 0;

    if      (bayes > 0.65) score += 2.0;
    else if (bayes > 0.55) score += 1.0;
    else if (bayes < 0.35) score -= 2.0;
    else if (bayes < 0.45) score -= 1.0;

    if      (ofi > 20)  score += 1.5;
    else if (ofi > 8)   score += 0.75;
    else if (ofi < -20) score -= 1.5;
    else if (ofi < -8)  score -= 0.75;

    if (cvd > 0) score += 1.0;
    else         score -= 1.0;

    if      (StringFind(dominant, "BUY")  >= 0) score += 1.0;
    else if (StringFind(dominant, "SELL") >= 0) score -= 1.0;

    Print(StringFormat("[TrendStrategy] score=%.2f", score));

    if (score >= InpTrendBuyScore)  return "BUY";
    if (score <= InpTrendSellScore) return "SELL";
    return "";
}

// Strategy B — Mean Reversion
string StrategyMeanReversion(double z, double rsi)
{
    if (z >= InpMeanRevZ && rsi > 45)
    {
        Print(StringFormat("[MeanRev] SELL — Z=%.2f RSI=%.1f", z, rsi));
        return "MEAN_REVERSAL_SHORT";
    }
    if (z <= -InpMeanRevZ && rsi < 55)
    {
        Print(StringFormat("[MeanRev] BUY — Z=%.2f RSI=%.1f", z, rsi));
        return "MEAN_REVERSAL_LONG";
    }
    return "";
}

// Strategy C — Liquidity Sweep Reversal
string StrategySweep(string sweep, double ofi, double cvd, string dominant)
{
    if (sweep == "ABOVE_HIGHS")
    {
        bool ofiOk  = (ofi < -InpSweepOFIMin);
        bool cvdOk  = (cvd < 0);
        bool tapeOk = (StringFind(dominant, "SELL") >= 0 || dominant == "BALANCED");
        if (ofiOk || cvdOk || tapeOk)
        {
            Print(StringFormat("[SweepStrat] SELL after ABOVE_HIGHS — OFI=%.0f CVD=%.0f Tape=%s", ofi, cvd, dominant));
            return "SELL";
        }
    }
    if (sweep == "BELOW_LOWS")
    {
        bool ofiOk  = (ofi > InpSweepOFIMin);
        bool cvdOk  = (cvd > 0);
        bool tapeOk = (StringFind(dominant, "BUY") >= 0 || dominant == "BALANCED");
        if (ofiOk || cvdOk || tapeOk)
        {
            Print(StringFormat("[SweepStrat] BUY after BELOW_LOWS — OFI=%.0f CVD=%.0f Tape=%s", ofi, cvd, dominant));
            return "BUY";
        }
    }
    return "";
}

// Bayesian posterior P(bull|RSI, OFI, Z, Skew) used by StrategyTrend
double CalcBayesian(double rsi, double ofi, double z, double skew)
{
    double L_rsi  = (rsi > 55)   ? 3.0  : (rsi < 45)    ? 0.333 : 1.0;
    double L_ofi  = (ofi > 10)   ? 1.5  : (ofi < -10)   ? 0.667 : 1.0;
    double L_z    = (z < -1.5)   ? 1.6  : (z > 1.5)     ? 0.625 : 1.0;
    double L_skew = (skew > 0.3) ? 1.2  : (skew < -0.3) ? 0.833 : 1.0;

    double odds = L_rsi * L_ofi * L_z * L_skew;
    return odds / (odds + 1.0);
}

//═══════════════════════════════════════════════════════════════════
// STAGE 5: BAYESIAN SIGNAL FUSION (full confidence score)
//═══════════════════════════════════════════════════════════════════
double BayesianFusion(string direction, double ofi, double cvd,
                      string dominant, string tapeSpeed,
                      double skewness, double rsi)
{
    double odds = 1.0; // prior P = 0.5

    // Signal 1 — OFI
    if      (ofi > 20)  odds *= 2.0;
    else if (ofi > 8)   odds *= 1.4;
    else if (ofi < -20) odds *= 0.5;
    else if (ofi < -8)  odds *= 0.7;

    // Signal 2 — CVD
    if      (cvd > 0) odds *= 1.25;
    else if (cvd < 0) odds *= 0.80;

    // Signal 3 — Tape
    bool screaming = (tapeSpeed == "SCREAMING");
    if      (StringFind(dominant, "BUY")  >= 0 && screaming) odds *= 1.20;
    else if (StringFind(dominant, "BUY")  >= 0)              odds *= 1.10;
    else if (StringFind(dominant, "SELL") >= 0 && screaming) odds *= 0.75;
    else if (StringFind(dominant, "SELL") >= 0)              odds *= 0.90;

    // Signal 4 — Skewness
    if      (skewness > 0.3)  odds *= 1.12;
    else if (skewness < -0.3) odds *= 0.88;

    // Signal 5 — RSI
    if      (rsi > 60) odds *= 1.15;
    else if (rsi < 40) odds *= 0.85;

    double p_bull = odds / (odds + 1.0);

    if (direction == "BUY" || direction == "MEAN_REVERSAL_LONG")  return p_bull;
    return 1.0 - p_bull;
}

//═══════════════════════════════════════════════════════════════════
// STAGE 6: RISK ENGINE
//═══════════════════════════════════════════════════════════════════
void CalcSlTp(string direction, string stratType, double price, double atr,
              double buyWall, double sellWall, string sweep,
              double &slOut, double &tpOut)
{
    bool   isLong  = (direction == "BUY" || direction == "MEAN_REVERSAL_LONG");
    double slDist  = atr * 1.5; // default: trend
    double tpWall  = 0;

    if (stratType == "TREND")
    {
        slDist = atr * 1.5;
        tpWall = isLong ? sellWall : buyWall;
    }
    else if (stratType == "MEAN_REVERSION")
    {
        slDist = atr * 1.0;
    }
    else if (stratType == "LIQUIDITY_SWEEP" && sweep != "")
    {
        double sweepLevel = (sweep == "ABOVE_HIGHS") ? sellWall : buyWall;
        slDist = (sweepLevel > 0) ? MathAbs(price - sweepLevel) + (atr * 0.5) : atr * 1.0;
        slDist = MathMax(slDist, atr * 0.5);
        tpWall = isLong ? sellWall : buyWall;
    }
    else
    {
        slDist = price * 0.008; // fallback 0.8%
    }

    if (isLong)
    {
        slOut = NormalizeDouble(price - slDist, _Digits);
        double tp2r = price + (slDist * InpMinRR);
        tpOut = (tpWall > 0 && tpWall > tp2r) ? tpWall * 0.9995 : tp2r;
        tpOut = NormalizeDouble(tpOut, _Digits);
    }
    else
    {
        slOut = NormalizeDouble(price + slDist, _Digits);
        double tp2r = price - (slDist * InpMinRR);
        tpOut = (tpWall > 0 && tpWall < tp2r) ? tpWall * 1.0005 : tp2r;
        tpOut = NormalizeDouble(tpOut, _Digits);
    }
}

//═══════════════════════════════════════════════════════════════════
// ORDER EXECUTION
//═══════════════════════════════════════════════════════════════════
double CalcLotSize(double price, double stopLoss)
{
    double equity   = AccountInfoDouble(ACCOUNT_EQUITY);
    double riskUSD  = equity * (InpMaxRiskPct / 100.0);
    double slDist   = MathAbs(price - stopLoss);
    if (slDist <= 0) return 0;

    double tickVal  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
    double tickSize = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_SIZE);
    if (tickVal <= 0 || tickSize <= 0) return 0;

    double slTicks  = slDist / tickSize;
    double lots     = riskUSD / (slTicks * tickVal);

    double minLot   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MIN);
    double maxLot   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MAX);
    double stepLot  = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);

    lots = MathFloor(lots / stepLot) * stepLot;
    lots = MathMax(minLot, MathMin(maxLot, lots));
    return lots;
}

void PlaceBuy(double lots, double sl, double tp)
{
    double ask = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
    if (Trade.Buy(lots, Symbol(), ask, sl, tp, "QuadDesk BUY"))
    {
        g_TotalTrades++;
        Print(StringFormat("[QuadDeskEA] BUY placed | lots=%.2f ask=%.5f SL=%.5f TP=%.5f",
              lots, ask, sl, tp));
    }
    else
        Print("[QuadDeskEA] BUY FAILED: ", Trade.ResultRetcodeDescription());
}

void PlaceSell(double lots, double sl, double tp)
{
    double bid = SymbolInfoDouble(Symbol(), SYMBOL_BID);
    if (Trade.Sell(lots, Symbol(), bid, sl, tp, "QuadDesk SELL"))
    {
        g_TotalTrades++;
        Print(StringFormat("[QuadDeskEA] SELL placed | lots=%.2f bid=%.5f SL=%.5f TP=%.5f",
              lots, bid, sl, tp));
    }
    else
        Print("[QuadDeskEA] SELL FAILED: ", Trade.ResultRetcodeDescription());
}

//═══════════════════════════════════════════════════════════════════
// POSITION / DAILY LOSS MANAGEMENT
//═══════════════════════════════════════════════════════════════════
bool HasOpenPosition()
{
    for (int i = 0; i < PositionsTotal(); i++)
    {
        if (PosInfo.SelectByIndex(i) && PosInfo.Magic() == 202500)
            return true;
    }
    return false;
}

void CheckDailyReset()
{
    datetime today = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
    if (today != g_CurrentDay)
    {
        g_CurrentDay       = today;
        g_DailyStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
        g_DailyLossHalt    = false;
        g_CVD              = 0;
        Print("[QuadDeskEA] New trading day — stats reset.");
    }
}

bool CheckDailyLoss()
{
    if (g_DailyLossHalt)
    {
        if (InpShowPanel) DrawPanel("DAILY LOSS LIMIT REACHED — HALTED", clrGray);
        return false;
    }
    double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
    double drawdown  = (g_DailyStartEquity - equity) / g_DailyStartEquity * 100.0;
    if (drawdown >= InpMaxDailyLossPct)
    {
        g_DailyLossHalt = true;
        Print(StringFormat("[QuadDeskEA] DAILY LOSS HALT — drawdown=%.2f%%", drawdown));
        if (InpShowPanel) DrawPanel("DAILY LOSS LIMIT REACHED — HALTED", clrGray);
        return false;
    }
    return true;
}

void UpdatePanelForHolding()
{
    if (!InpShowPanel) return;
    string msg = StringFormat("HOLDING | SL=%.5f TP=%.5f | Trades=%d", g_LastSL, g_LastTP, g_TotalTrades);
    DrawPanel(msg, clrDodgerBlue);
}

void LogWait(string reason)
{
    g_LastVerdict  = "WAIT";
    g_LastAnalysis = "WAIT — " + reason;
    Print("[QuadDeskEA] WAIT: ", reason);
    if (InpShowPanel) DrawPanel(g_LastAnalysis, InpWaitColor);
}

//═══════════════════════════════════════════════════════════════════
// CHART PANEL (DISPLAY)
//═══════════════════════════════════════════════════════════════════
void DrawPanel(string message, color clr)
{
    string name = "QD_Panel";
    int    x = 15, y = 30;

    string header  = "════ QUAD DESK EA v1.0 ════";
    string line1   = StringFormat("Symbol   : %s  |  TF: %s", Symbol(), EnumToString(InpTimeframe));
    string line2   = StringFormat("Regime   : %s", g_LastRegime);
    string line3   = StringFormat("Signal   : %s  |  P=%.0f%%", g_LastVerdict, g_LastConfidence * 100);
    string line4   = StringFormat("SL       : %.5f  |  TP: %.5f", g_LastSL, g_LastTP);
    string line5   = StringFormat("Trades   : %d  |  Daily Halt: %s", g_TotalTrades, g_DailyLossHalt ? "YES" : "NO");
    string line6   = StringFormat("Analysis : %s", StringSubstr(message, 0, 60));

    string lines[] = { header, line1, line2, line3, line4, line5, line6 };

    for (int i = 0; i < ArraySize(lines); i++)
    {
        string lname = "QD_L" + IntegerToString(i);
        if (ObjectFind(0, lname) < 0)
        {
            ObjectCreate(0, lname, OBJ_LABEL, 0, 0, 0);
            ObjectSetInteger(0, lname, OBJPROP_CORNER,    CORNER_LEFT_UPPER);
            ObjectSetInteger(0, lname, OBJPROP_FONTSIZE,  9);
            ObjectSetString(0,  lname, OBJPROP_FONT,      "Consolas");
            ObjectSetInteger(0, lname, OBJPROP_BACK,      false);
        }
        ObjectSetString(0,  lname, OBJPROP_TEXT, lines[i]);
        ObjectSetInteger(0, lname, OBJPROP_XDISTANCE, x);
        ObjectSetInteger(0, lname, OBJPROP_YDISTANCE, y + i * 16);
        ObjectSetInteger(0, lname, OBJPROP_COLOR, (i == 0 || i == 2) ? clr : clrWhiteSmoke);
    }
    ChartRedraw(0);
}
//+------------------------------------------------------------------+
