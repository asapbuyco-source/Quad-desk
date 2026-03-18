//+------------------------------------------------------------------+
//|                           QuadDeskEA_v2.mq5                      |
//|              Quad Desk — Hybrid Institutional EA v2.0            |
//|                                                                  |
//|  STRATEGY: 7-Stage Hybrid (QuadDesk pipeline + ICT concepts)    |
//|    1. Feature Engine  — ATR, RSI, VWAP Z-Score, Skewness, CVD  |
//|    2. Regime Layer    — TREND | RANGE | LIQUIDITY | NEUTRAL     |
//|    3. ICT Layer       — Kalman bias, CHoCH/BOS, OTE, VPOC       |
//|    4. Sweep Detection — DOM-wall sweep reversal signals          |
//|    5. Bayesian Fusion — 11-factor confidence score              |
//|    6. Risk Engine     — Kelly + Anti-Martingale + ATR sizing    |
//|    7. Trade Mgmt      — Break-even at 1R, Trail from 1.5R       |
//|                                                                  |
//|  BROKER  : Exness (GMT+3) or any MT5 broker                    |
//|  SYMBOL  : Run on any chart — XAUUSDm, USDJPYm, etc.           |
//|  WHAT TO CHANGE:                                                |
//|   → BaseRiskPct      : % risk per trade (default 1.0)          |
//|   → MaxDailyLossPct  : daily halt threshold (default 3.0)      |
//|   → BrokerGMTOffset  : 3 for Exness GMT+3                      |
//|   → SymbolSuffix     : "m" for Exness, "" for standard names   |
//+------------------------------------------------------------------+
#property copyright  "Quad Desk v2 — Hybrid Institutional EA"
#property version    "2.00"
#property description "Kalman | VWAP | VPOC | OTE | CHoCH/BOS | Kelly | AntiMartingale | KillZone"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\DealInfo.mqh>

//+------------------------------------------------------------------+
//| INPUTS                                                           |
//+------------------------------------------------------------------+
input group "=== YOUR ACCOUNT (Change these) ==="
input double BaseRiskPct       = 1.0;   // % risk per trade
input double MaxDailyLossPct   = 3.0;   // Daily loss halt %
input int    MaxOpenTrades     = 1;     // Max simultaneous positions on this chart
input double MinRR             = 1.8;   // Minimum R:R before entry

input group "=== BROKER (Set for your broker) ==="
input int    BrokerGMTOffset   = 3;     // GMT+3 for Exness; change if different
input string SymbolSuffix      = "m";   // "m" for Exness (XAUUSDm). "" for standard names.

input group "=== KILL ZONES (UTC hours — do not change unless needed) ==="
input int    LKZ_Open          = 7;     // London Kill Zone open  (UTC)
input int    LKZ_Close         = 10;    // London Kill Zone close (UTC)
input int    NKZ_Open          = 12;    // New York Kill Zone open (UTC)
input int    NKZ_Close         = 15;    // New York Kill Zone close (UTC)

input group "=== TRADE MANAGEMENT ==="
input double ATR_SL_Mult       = 1.5;   // ATR multiplier for SL beyond swing
input double BreakEvenR        = 1.0;   // Move SL to entry after this R of profit
input double TrailActivateR    = 1.5;   // Start trailing after this R
input double TrailStepR        = 0.5;   // Trail step in R units
input double MaxSpreadPts      = 80.0;  // Max spread in broker points

input group "=== KELLY & ANTI-MARTINGALE ==="
input bool   UseKelly          = true;  // Fractional Kelly sizing
input double KellyFraction     = 0.5;   // Half-Kelly (do not raise above 0.75)
input int    KellyLookback     = 20;    // Trades to calc Kelly over
input bool   UseAntiMartingale = true;  // Reduce size after losses
input double AntiMartPct       = 20.0;  // % reduction per consecutive loss
input double AntiMartMax       = 50.0;  // Max total reduction %

input group "=== SIGNAL THRESHOLDS (Pre-tuned) ==="
input double MinScore          = 52.0;  // Min Bayesian confidence % to trade
input int    ADX_Min           = 14;    // Min ADX trend strength
input int    SwingLen          = 2;     // Pivot lookback sensitivity
input int    LookbackBars      = 20;    // Bars for structure detection
input double OTE_Low           = 0.382; // OTE Fib zone lower bound
input double OTE_High          = 0.79;  // OTE Fib zone upper bound
input double SkewThreshold     = 0.2;   // Return skewness confirmation
input double MeanRevZ          = 2.5;   // Z-Score for mean-reversion signal
input double WallProximity     = 0.001; // DOM wall proximity for LIQUIDITY regime
input double TrendAtrPct       = 0.006; // ATR% for TREND regime gate
input double SweepOFIMin       = 5.0;   // OFI threshold for sweep confirmation
input int    OFILevels         = 10;    // DOM levels inspected for OFI

input group "=== DISPLAY & DIAGNOSTICS ==="
input bool   DiagMode          = false; // Log all factors to Journal
input bool   EnableLogs        = true;
input bool   EnableAlerts      = true;
input bool   ShowPanel         = true;

input group "=== SYSTEM ==="
input int    MagicNumber       = 99001; // EA identifier
input ENUM_TIMEFRAMES Timeframe = PERIOD_M15; // Analysis timeframe

//+------------------------------------------------------------------+
//| CONSTANTS & DEFINES                                              |
//+------------------------------------------------------------------+
#define ATR_PERIOD    14
#define RSI_PERIOD    14
#define ADX_PERIOD    14
#define VWAP_BARS     80
#define VPOC_BARS     50
#define VPOC_BUCKETS  20
#define CVD_BARS      20
#define SKEW_PERIOD   30
#define KALMAN_FAST_Q 0.01
#define KALMAN_FAST_R 0.1
#define KALMAN_SLOW_Q 0.001
#define KALMAN_SLOW_R 1.0

//+------------------------------------------------------------------+
//| STRUCTS                                                          |
//+------------------------------------------------------------------+
struct KalmanState { double estimate, errorCov, Q, R; bool initialized; };

struct Score {
   bool   kalman, structure, ote, vwap, vpoc, cvd, ofi, skew, rsi, rvol, pattern;
   double total;
   string log;
};

struct TradeRec { double rMultiple; };

enum VolReg { VR_LOW, VR_MED, VR_HIGH };

//+------------------------------------------------------------------+
//| GLOBAL STATE                                                     |
//+------------------------------------------------------------------+
CTrade        Trade;
CPositionInfo Pos;
CDealInfo     Deal;

// Cached indicator handles
int      g_hATR       = INVALID_HANDLE;
int      g_hRSI       = INVALID_HANDLE;
int      g_hADX       = INVALID_HANDLE;

// Tick accumulators
double   g_CVD        = 0;
double   g_BuyVol10s  = 0;
double   g_SellVol10s = 0;
double   g_VolBase60s = 1.0;
int      g_VolBCnt    = 0;
datetime g_LastTick   = 0;
datetime g_TapeDecay  = 0;
datetime g_BaseTime   = 0;
double   g_LastBid    = 0;

// Daily management
double   g_DayEq      = 0;
bool     g_DayHalt    = false;
datetime g_DayMark    = 0;

// Kelly history
TradeRec g_hist[];
int      g_histCount  = 0;
int      g_consecLoss = 0;

// Tester flag
bool     g_isTester   = false;

// Panel state
string   g_panelRegime  = "---";
string   g_panelSignal  = "WAITING";
double   g_panelConf    = 0;
string   g_panelDetail  = "";

// Kill zone log throttle
datetime g_lastKZLog    = 0;

//+------------------------------------------------------------------+
//| INIT                                                             |
//+------------------------------------------------------------------+
int OnInit() {
   Trade.SetExpertMagicNumber(MagicNumber);
   Trade.SetDeviationInPoints(30);
   Trade.SetTypeFilling(ORDER_FILLING_IOC);

   g_isTester = (bool)MQLInfoInteger(MQL_TESTER);

   // Cache indicator handles — created once, not every tick
   g_hATR = iATR(Symbol(), Timeframe, ATR_PERIOD);
   g_hRSI = iRSI(Symbol(), Timeframe, RSI_PERIOD, PRICE_CLOSE);
   g_hADX = iADX(Symbol(), Timeframe, ADX_PERIOD);

   if (g_hATR == INVALID_HANDLE || g_hRSI == INVALID_HANDLE || g_hADX == INVALID_HANDLE) {
      Print("❌ Failed to create indicator handles on ", Symbol());
      return INIT_FAILED;
   }

   if (!g_isTester) MarketBookAdd(Symbol());

   ArrayResize(g_hist, 300);
   g_DayEq    = AccountInfoDouble(ACCOUNT_EQUITY);
   g_DayMark  = 0;

   Print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
   Print("  Quad Desk Hybrid EA v2.0");
   Print("  Symbol: ", Symbol(), " / ", EnumToString(Timeframe));
   Print("  Broker GMT+", BrokerGMTOffset,
         " | Kill Zones: London ", LKZ_Open, "-", LKZ_Close,
         " UTC | NY ", NKZ_Open, "-", NKZ_Close, " UTC");
   Print("  Risk: ", BaseRiskPct, "% | MinScore: ", MinScore, "% | MaxTrades: ", MaxOpenTrades);
   Print("  Mode: ", g_isTester ? "BACKTESTING" : "LIVE");
   Print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   if (!g_isTester) MarketBookRelease(Symbol());
   IndicatorRelease(g_hATR);
   IndicatorRelease(g_hRSI);
   IndicatorRelease(g_hADX);
   ObjectsDeleteAll(0, "QD2_");
}

//+------------------------------------------------------------------+
//| MAIN TICK                                                        |
//+------------------------------------------------------------------+
void OnTick() {
   if (!g_isTester) AccumulateTick();

   CheckDayReset();
   ManagePositions();

   if (g_DayHalt) return;
   if (!CheckDailyLoss()) return;

   if (!InKillZone()) {
      if (DiagMode && EnableLogs) {
         datetime now = TimeCurrent();
         if ((int)(now - g_lastKZLog) > 300) {
            Print("⏱ Outside Kill Zone — London ", LKZ_Open+BrokerGMTOffset, ":00 | NY ",
                  NKZ_Open+BrokerGMTOffset, ":00 broker time");
            g_lastKZLog = now;
         }
      }
      return;
   }

   if (CountMyTrades() >= MaxOpenTrades) return;

   RunSymbol();
   if (ShowPanel && !g_isTester) DrawPanel();
}

//+------------------------------------------------------------------+
//| KILL ZONE                                                        |
//+------------------------------------------------------------------+
bool InKillZone() {
   datetime t = TimeCurrent() - BrokerGMTOffset * 3600;
   MqlDateTime d; TimeToStruct(t, d); int h = d.hour;
   return ((h >= LKZ_Open && h < LKZ_Close) || (h >= NKZ_Open && h < NKZ_Close));
}

//+------------------------------------------------------------------+
//| DAY RESET                                                        |
//+------------------------------------------------------------------+
void CheckDayReset() {
   datetime t = TimeCurrent() - BrokerGMTOffset * 3600;
   MqlDateTime n, l; TimeToStruct(t, n); TimeToStruct(g_DayMark, l);
   if (n.day != l.day || n.mon != l.mon) {
      if (EnableLogs) Print("🔄 New trading day — resetting counters");
      g_DayHalt  = false;
      g_DayMark  = t;
      g_DayEq    = AccountInfoDouble(ACCOUNT_EQUITY);
      g_CVD      = 0;
   }
}

//+------------------------------------------------------------------+
//| DAILY LOSS CHECK                                                 |
//+------------------------------------------------------------------+
bool CheckDailyLoss() {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double dd = (g_DayEq > 0) ? (g_DayEq - eq) / g_DayEq * 100.0 : 0;
   if (dd >= MaxDailyLossPct) {
      if (!g_DayHalt) {
         Print("🛑 DAILY LOSS HALT — ", DoubleToString(dd, 2), "% >= ", MaxDailyLossPct, "%");
         if (EnableAlerts) Alert("QuadDesk v2 — Daily loss limit hit on ", Symbol());
      }
      g_DayHalt = true;
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| TICK CVD ACCUMULATOR (live mode)                                |
//+------------------------------------------------------------------+
void AccumulateTick() {
   MqlTick tick;
   if (!SymbolInfoTick(Symbol(), tick)) return;
   if (tick.time == g_LastTick) return;
   g_LastTick = tick.time;

   double vol   = (double)tick.volume;
   bool   bull  = (tick.bid >= g_LastBid);
   g_LastBid    = tick.bid;
   double usdV  = vol * tick.bid;

   if (bull) { g_CVD += vol; g_BuyVol10s  += usdV; }
   else      { g_CVD -= vol; g_SellVol10s += usdV; }

   datetime now = TimeCurrent();
   if ((int)(now - g_TapeDecay) >= 10) {
      g_BuyVol10s = g_SellVol10s = 0;
      g_TapeDecay = now;
   }
   g_VolBase60s += usdV;
   g_VolBCnt++;
   if ((int)(now - g_BaseTime) >= 60) {
      g_VolBase60s = (g_VolBCnt > 0) ? g_VolBase60s : 1.0;
      g_VolBCnt    = 0;
      g_BaseTime   = now;
   }
}

//+------------------------------------------------------------------+
//| BAR-BASED CVD (backtesting)                                     |
//+------------------------------------------------------------------+
double CalcBarCVD() {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, CVD_BARS + 2, r) < CVD_BARS) return 0;
   double cd = 0;
   for (int i = CVD_BARS - 1; i >= 0; i--) {
      double rng  = r[i].high - r[i].low;
      double body = MathAbs(r[i].close - r[i].open);
      double conv = (rng > 0) ? body / rng : 0.5;
      double dir  = (r[i].close >= r[i].open) ? 1.0 : -1.0;
      cd += dir * (double)r[i].tick_volume * conv;
   }
   return cd;
}

bool CVDConfirm(int bias) {
   double cvd = g_isTester ? CalcBarCVD() : g_CVD;
   return (bias == 1) ? (cvd > 0) : (cvd < 0);
}

//+------------------------------------------------------------------+
//| TAPE SPEED                                                       |
//+------------------------------------------------------------------+
string GetTapeDominant() {
   if (g_BuyVol10s > g_SellVol10s * 1.5) return "BUY";
   if (g_SellVol10s > g_BuyVol10s * 1.5)  return "SELL";
   return "BALANCED";
}

string GetTapeSpeed() {
   double tot = g_BuyVol10s + g_SellVol10s;
   double base = (g_VolBase60s / 60.0) * 10;
   if (base > 0 && tot > base * 3) return "SCREAMING";
   return "NORMAL";
}

//+------------------------------------------------------------------+
//| ATR / RSI / ADX — uses cached handles                          |
//+------------------------------------------------------------------+
double GetATR() {
   double b[]; ArraySetAsSeries(b, true);
   if (CopyBuffer(g_hATR, 0, 1, 1, b) < 1) return 0;
   return b[0];
}

double GetRSI() {
   double b[]; ArraySetAsSeries(b, true);
   if (CopyBuffer(g_hRSI, 0, 1, 1, b) < 1) return 50;
   return b[0];
}

bool ADXGate() {
   double b[]; ArraySetAsSeries(b, true);
   if (CopyBuffer(g_hADX, 0, 1, 1, b) < 1) return true;
   if (DiagMode && EnableLogs) Print("  [ADX] ", Symbol(), "=", DoubleToString(b[0], 1), " min=", ADX_Min);
   return (b[0] >= ADX_Min);
}

//+------------------------------------------------------------------+
//| ORDER FLOW IMBALANCE                                            |
//+------------------------------------------------------------------+
double CalcOFI() {
   if (g_isTester) {
      MqlRates r[]; ArraySetAsSeries(r, true);
      if (CopyRates(Symbol(), Timeframe, 0, 10, r) < 10) return 0;
      double bv = 0, sv = 0;
      for (int i = 0; i < 10; i++) {
         if (r[i].close >= r[i].open) bv += (double)r[i].tick_volume;
         else                         sv += (double)r[i].tick_volume;
      }
      return bv - sv;
   }
   MqlBookInfo book[];
   if (!MarketBookGet(Symbol(), book)) return 0;
   double price = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   double maxD  = price * 0.005;
   double bid = 0, ask = 0; int bc = 0, ac = 0;
   for (int i = 0; i < ArraySize(book); i++) {
      if (bc >= OFILevels && ac >= OFILevels) break;
      double dist = MathAbs(book[i].price - price);
      if (dist > maxD) continue;
      double v = (double)book[i].volume;
      if (book[i].type == BOOK_TYPE_BUY  && bc < OFILevels) { bid += v; bc++; }
      if (book[i].type == BOOK_TYPE_SELL && ac < OFILevels) { ask += v; ac++; }
   }
   return bid - ask;
}

//+------------------------------------------------------------------+
//| DOM WALL DETECTION                                              |
//+------------------------------------------------------------------+
void GetLOBWalls(double price, double &buyWall, double &sellWall, double &buySize, double &sellSize) {
   buyWall = sellWall = buySize = sellSize = 0;
   MqlBookInfo book[];
   if (!MarketBookGet(Symbol(), book)) return;
   double maxDist = price * 0.005;
   double allSz[]; int cnt = 0;
   for (int i = 0; i < ArraySize(book); i++) {
      double dist = (book[i].type == BOOK_TYPE_BUY) ? MathAbs(price - book[i].price) : MathAbs(book[i].price - price);
      if (dist <= maxDist) { ArrayResize(allSz, cnt + 1); allSz[cnt++] = (double)book[i].volume; }
   }
   if (cnt == 0) return;
   ArraySort(allSz);
   double thresh = allSz[(int)(cnt / 2)] * 5.0;
   for (int i = 0; i < ArraySize(book); i++) {
      double v = (double)book[i].volume;
      if (book[i].type == BOOK_TYPE_BUY) {
         double dist = MathAbs(price - book[i].price);
         if (dist <= maxDist && v > thresh && v > buySize) { buyWall = book[i].price; buySize = v; }
      } else if (book[i].type == BOOK_TYPE_SELL) {
         double dist = MathAbs(book[i].price - price);
         if (dist <= maxDist && v > thresh && v > sellSize) { sellWall = book[i].price; sellSize = v; }
      }
   }
}

//+------------------------------------------------------------------+
//| KALMAN FILTER                                                    |
//+------------------------------------------------------------------+
double KalmanUpdate(KalmanState &s, double z) {
   if (!s.initialized) { s.estimate = z; s.initialized = true; return z; }
   double pMinus = s.errorCov + s.Q;
   double K      = pMinus / (pMinus + s.R);
   s.estimate    = s.estimate + K * (z - s.estimate);
   s.errorCov    = (1.0 - K) * pMinus;
   return s.estimate;
}

int KalmanBias() {
   MqlRates r[]; ArraySetAsSeries(r, true);
   int n = LookbackBars + 15;
   if (CopyRates(Symbol(), Timeframe, 0, n, r) < n) return 0;
   KalmanState kf, ks;
   kf.Q = KALMAN_FAST_Q; kf.R = KALMAN_FAST_R; kf.errorCov = 1.0; kf.initialized = false;
   ks.Q = KALMAN_SLOW_Q; ks.R = KALMAN_SLOW_R; ks.errorCov = 1.0; ks.initialized = false;
   double fast = 0, slow = 0;
   for (int i = n - 1; i >= 0; i--) {
      double mid = (r[i].high + r[i].low + r[i].close) / 3.0;
      fast = KalmanUpdate(kf, mid);
      slow = KalmanUpdate(ks, mid);
   }
   return (fast > slow) ? 1 : -1;
}

//+------------------------------------------------------------------+
//| H1 STRUCTURE BIAS — CHoCH and BOS                              |
//+------------------------------------------------------------------+
int GetStructureBias(int kBias) {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), PERIOD_H1, 0, LookbackBars + 5, r) < LookbackBars) return 0;
   double swH = 0, swL = DBL_MAX; int rhIdx = -1, rlIdx = -1;
   for (int i = SwingLen; i < LookbackBars; i++) {
      bool isH = true, isL = true;
      for (int k = 1; k <= SwingLen; k++) {
         if (r[i].high <= r[i-k].high || r[i].high <= r[i+k].high) isH = false;
         if (r[i].low  >= r[i-k].low  || r[i].low  >= r[i+k].low)  isL = false;
      }
      if (isH && rhIdx == -1) { swH = r[i].high; rhIdx = i; }
      if (isL && rlIdx == -1) { swL = r[i].low;  rlIdx = i; }
      if (rhIdx != -1 && rlIdx != -1) break;
   }
   if (swH == 0 || swL == DBL_MAX) return 0;
   double c1h = r[1].high, c1l = r[1].low, c1c = r[1].close;
   double c2h = r[2].high, c2l = r[2].low;
   bool bullSweep = (c1l < swL && c1c > swL), bearSweep = (c1h > swH && c1c < swH);
   bool bullCHoCH = (bullSweep && c1c > c2h), bearCHoCH = (bearSweep && c1c < c2l);
   bool bullBOS   = (c1c > swH), bearBOS   = (c1c < swL);
   if (DiagMode && EnableLogs)
      Print("  [STR] swH=", DoubleToString(swH, 5), " swL=", DoubleToString(swL, 5),
            " bBOS=", bullBOS, " rBOS=", bearBOS, " bCHoCH=", bullCHoCH, " rCHoCH=", bearCHoCH);
   if ((bullCHoCH || bullBOS) && kBias ==  1) return  1;
   if ((bearCHoCH || bearBOS) && kBias == -1) return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| VWAP                                                            |
//+------------------------------------------------------------------+
struct VWAPData { double vwap, upper1, lower1; bool valid; };

VWAPData CalcVWAP() {
   VWAPData v = {0,0,0,false};
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, VWAP_BARS + 2, r) < VWAP_BARS) return v;
   datetime t = TimeCurrent() - BrokerGMTOffset * 3600;
   MqlDateTime dt; TimeToStruct(t, dt);
   int sessStart = (dt.hour >= LKZ_Open && dt.hour < NKZ_Open) ? LKZ_Open : NKZ_Open;
   double sumTV = 0, sumV = 0; int cnt = 0;
   for (int i = 0; i < VWAP_BARS; i++) {
      datetime bt = r[i].time - BrokerGMTOffset * 3600;
      MqlDateTime bd; TimeToStruct(bt, bd);
      if (bd.hour < sessStart) break;
      double tp = (r[i].high + r[i].low + r[i].close) / 3.0;
      double vol = (double)r[i].tick_volume;
      sumTV += tp * vol; sumV += vol; cnt++;
   }
   if (sumV < 1 || cnt < 3) return v;
   v.vwap = sumTV / sumV;
   double varSum = 0, sumV2 = 0;
   for (int i = 0; i < cnt && i < VWAP_BARS; i++) {
      double tp  = (r[i].high + r[i].low + r[i].close) / 3.0;
      double vol = (double)r[i].tick_volume;
      varSum += vol * MathPow(tp - v.vwap, 2); sumV2 += vol;
   }
   double sig = (sumV2 > 0) ? MathSqrt(varSum / sumV2) : 0;
   v.upper1 = v.vwap + sig; v.lower1 = v.vwap - sig; v.valid = true;
   return v;
}

//+------------------------------------------------------------------+
//| VWAP Z-SCORE (for regime detection)                             |
//+------------------------------------------------------------------+
double CalcVWAPZScore(double currentPrice) {
   MqlRates r[]; ArraySetAsSeries(r, true);
   int bars = 20;
   if (CopyRates(Symbol(), Timeframe, 0, bars, r) < bars) return 0;
   long tv[]; ArraySetAsSeries(tv, true);
   if (CopyTickVolume(Symbol(), Timeframe, 0, bars, tv) < bars) return 0;
   double sumTP = 0, sumV = 0;
   double tp[]; ArrayResize(tp, bars);
   for (int i = 0; i < bars; i++) {
      double vol = (double)tv[i];
      tp[i] = (r[i].high + r[i].low + r[i].close) / 3.0;
      sumTP += tp[i] * vol; sumV += vol;
   }
   if (sumV <= 0) return 0;
   double vwap = sumTP / sumV;
   double sumSq = 0;
   for (int i = 0; i < bars; i++) sumSq += MathPow(tp[i] - vwap, 2);
   double sd = MathSqrt(sumSq / bars);
   return (sd > 0) ? (currentPrice - vwap) / sd : 0;
}

//+------------------------------------------------------------------+
//| VOLUME PROFILE POC                                              |
//+------------------------------------------------------------------+
double CalcVPOC() {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, VPOC_BARS + 2, r) < VPOC_BARS) return 0;
   double hi = r[0].high, lo = r[0].low;
   for (int i = 1; i < VPOC_BARS; i++) { if (r[i].high > hi) hi = r[i].high; if (r[i].low < lo) lo = r[i].low; }
   double rng = hi - lo; if (rng < 1e-10) return 0;
   double bsz = rng / VPOC_BUCKETS;
   double vol[]; ArrayResize(vol, VPOC_BUCKETS); ArrayInitialize(vol, 0);
   for (int i = 0; i < VPOC_BARS; i++) {
      int bkt = (int)(((r[i].high + r[i].low) / 2.0 - lo) / bsz);
      if (bkt < 0) bkt = 0; if (bkt >= VPOC_BUCKETS) bkt = VPOC_BUCKETS - 1;
      vol[bkt] += (double)r[i].tick_volume;
   }
   int mx = 0; for (int i = 1; i < VPOC_BUCKETS; i++) if (vol[i] > vol[mx]) mx = i;
   return lo + (mx + 0.5) * bsz;
}

//+------------------------------------------------------------------+
//| OTE FIBONACCI ZONE                                              |
//+------------------------------------------------------------------+
bool OTEConfirm(int bias) {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, LookbackBars + 2, r) < LookbackBars) return false;
   double swH = 0, swL = DBL_MAX;
   for (int i = SwingLen; i < LookbackBars; i++) {
      bool isH = true, isL = true;
      for (int k = 1; k <= SwingLen; k++) {
         if (r[i].high <= r[i-k].high || r[i].high <= r[i+k].high) isH = false;
         if (r[i].low  >= r[i-k].low  || r[i].low  >= r[i+k].low)  isL = false;
      }
      if (isH && swH == 0) swH = r[i].high;
      if (isL && swL == DBL_MAX) swL = r[i].low;
      if (swH > 0 && swL < DBL_MAX) break;
   }
   if (swH == 0 || swL == DBL_MAX) return false;
   double rng = swH - swL; if (rng < 1e-10) return false;
   double ask = SymbolInfoDouble(Symbol(), SYMBOL_ASK), bid = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   if (bias ==  1) { double top = swH - rng * OTE_Low, bot = swH - rng * OTE_High; return (ask >= bot && ask <= top); }
   if (bias == -1) { double bot = swL + rng * OTE_Low, top = swL + rng * OTE_High; return (bid >= bot && bid <= top); }
   return false;
}

//+------------------------------------------------------------------+
//| RETURN SKEWNESS                                                 |
//+------------------------------------------------------------------+
double CalcSkewness() {
   double cl[]; ArraySetAsSeries(cl, true);
   if (CopyClose(Symbol(), Timeframe, 0, SKEW_PERIOD + 2, cl) < SKEW_PERIOD + 1) return 0;
   double ret[]; ArrayResize(ret, SKEW_PERIOD); int valid = 0;
   for (int i = 0; i < SKEW_PERIOD; i++) {
      if (cl[i+1] > 0 && cl[i] > 0) ret[valid++] = MathLog(cl[i] / cl[i+1]);
   }
   if (valid < 3) return 0;
   double mean = 0; for (int i = 0; i < valid; i++) mean += ret[i]; mean /= valid;
   double m2 = 0, m3 = 0;
   for (int i = 0; i < valid; i++) { double d = ret[i] - mean; m2 += d*d; m3 += d*d*d; }
   m2 /= valid; m3 /= valid;
   return (m2 > 0) ? m3 / MathPow(MathSqrt(m2), 3) : 0;
}

//+------------------------------------------------------------------+
//| RSI / RVOL / PATTERN CHECKS                                     |
//+------------------------------------------------------------------+
bool RSICheck(double rsi, int bias) {
   return (bias == 1) ? (rsi >= 45 && rsi <= 68) : (rsi >= 32 && rsi <= 55);
}

bool RVOLCheck() {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, 22, r) < 22) return false;
   double avg = 0; for (int i = 1; i <= 20; i++) avg += (double)r[i].tick_volume; avg /= 20;
   return (avg > 0 && (double)r[1].tick_volume / avg >= 1.1);
}

bool PatternCheck(int bias) {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, 4, r) < 3) return false;
   double o1=r[1].open, c1=r[1].close, h1=r[1].high, l1=r[1].low;
   double o2=r[2].open, c2=r[2].close;
   double body=MathAbs(c1-o1), rng=h1-l1; if (rng < 1e-10) return false;
   double uw=h1-MathMax(o1,c1), lw=MathMin(o1,c1)-l1;
   if (bias == 1) {
      bool eng = (c2<o2)&&(c1>o1)&&(c1>=o2)&&(o1<=c2);
      bool pin = (lw>=2*body)&&(uw<=0.35*rng)&&(body>=0.1*rng);
      return eng || pin;
   } else {
      bool eng = (c2>o2)&&(c1<o1)&&(c1<=o2)&&(o1>=c2);
      bool pin = (uw>=2*body)&&(lw<=0.35*rng)&&(body>=0.1*rng);
      return eng || pin;
   }
}

//+------------------------------------------------------------------+
//| VOLATILITY REGIME                                               |
//+------------------------------------------------------------------+
VolReg GetVolRegime() {
   double b[]; ArraySetAsSeries(b, true);
   if (CopyBuffer(g_hATR, 0, 1, 20, b) < 20) return VR_MED;
   double cur = b[0], avg = 0; for (int i = 0; i < 20; i++) avg += b[i]; avg /= 20;
   double ratio = (avg > 0) ? cur / avg : 1;
   return (ratio < 0.65) ? VR_LOW : (ratio > 1.4) ? VR_HIGH : VR_MED;
}

double GetTPMult(VolReg vr, double score) {
   double base = (vr == VR_HIGH) ? 3.0 : 2.0;
   if (score >= 85) base *= 1.35; else if (score >= 72) base *= 1.15;
   return MathMax(base, MinRR);
}

//+------------------------------------------------------------------+
//| MARKET REGIME DETECTION (from QuadDesk pipeline)               |
//+------------------------------------------------------------------+
string DetectRegime(double price, double z, double atr_pct, double buyWall, double sellWall) {
   if (buyWall  > 0 && MathAbs(price - buyWall)  / price <= WallProximity) return "LIQUIDITY";
   if (sellWall > 0 && MathAbs(price - sellWall) / price <= WallProximity) return "LIQUIDITY";
   if (atr_pct > TrendAtrPct && GetTapeSpeed() == "SCREAMING") return "TREND";
   if (MathAbs(z) < 2.5) return "RANGE";
   return "NEUTRAL";
}

//+------------------------------------------------------------------+
//| DOM SWEEP DETECTION (from QuadDesk)                            |
//+------------------------------------------------------------------+
string DetectSweep(double price, double buyWall, double sellWall) {
   if (iBars(Symbol(), Timeframe) < 2) return "";
   double prevHigh = iHigh(Symbol(), Timeframe, 1);
   double prevLow  = iLow(Symbol(), Timeframe, 1);
   if (sellWall > 0 && prevHigh > sellWall && price < sellWall) return "ABOVE_HIGHS";
   if (buyWall  > 0 && prevLow  < buyWall  && price > buyWall)  return "BELOW_LOWS";
   return "";
}

//+------------------------------------------------------------------+
//| CORRELATION GUARD                                               |
//+------------------------------------------------------------------+
bool CorrGuard() {
   string sym = Symbol();
   bool isG = (StringFind(sym, "GBPUSD") >= 0), isN = (StringFind(sym, "NZDUSD") >= 0);
   if (!isG && !isN) return true;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      if (!Pos.SelectByIndex(i) || Pos.Magic() != MagicNumber) continue;
      string s = Pos.Symbol();
      if (isG && StringFind(s, "NZDUSD") >= 0) { if (EnableLogs) Print("🔗 Corr block: NZDUSD open, skip GBPUSD"); return false; }
      if (isN && StringFind(s, "GBPUSD") >= 0) { if (EnableLogs) Print("🔗 Corr block: GBPUSD open, skip NZDUSD"); return false; }
   }
   return true;
}

//+------------------------------------------------------------------+
//| BAYESIAN SCORE — 11 FACTORS (structure properly gated)         |
//| Kalman=12 | Structure=20 | OTE=10 | VWAP=8  | VPOC=8          |
//| CVD=8     | OFI=7        | Skew=5 | RSI=7   | RVOL=5 | Pat=10 |
//| Total possible = 100                                            |
//+------------------------------------------------------------------+
Score BuildScore(int bias, int sBias, double rsi, double ofi, double skew) {
   Score sc; double pts = 0; string log = "";

   sc.kalman = (KalmanBias() == bias);
   if (sc.kalman) { pts += 12; log += "KAL✓ "; } else log += "KAL✗ ";

   // FIXED: structure is gated on the actual sBias matching the trade direction
   sc.structure = (sBias == bias);
   if (sc.structure) { pts += 20; log += "STR✓ "; } else log += "STR✗ ";

   sc.ote = OTEConfirm(bias);
   if (sc.ote) { pts += 10; log += "OTE✓ "; } else log += "OTE✗ ";

   VWAPData v = CalcVWAP();
   double px = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   sc.vwap = v.valid && ((bias == 1 && px <= v.vwap) || (bias == -1 && px >= v.vwap));
   if (sc.vwap) { pts += 8; log += "VWP✓ "; } else log += "VWP✗ ";

   double poc = CalcVPOC(), atr = GetATR();
   sc.vpoc = (poc > 0 && MathAbs(px - poc) <= atr * 2.0);
   if (sc.vpoc) { pts += 8; log += "POC✓ "; } else log += "POC✗ ";

   sc.cvd = CVDConfirm(bias);
   if (sc.cvd) { pts += 8; log += "CVD✓ "; } else log += "CVD✗ ";

   sc.ofi = (bias == 1 && ofi >= 0) || (bias == -1 && ofi <= 0);
   if (sc.ofi) { pts += 7; log += "OFI✓ "; } else log += "OFI✗ ";

   sc.skew = (bias == 1 && skew > SkewThreshold) || (bias == -1 && skew < -SkewThreshold);
   if (sc.skew) { pts += 5; log += "SKW✓ "; } else log += "SKW✗ ";

   sc.rsi = RSICheck(rsi, bias);
   if (sc.rsi) { pts += 7; log += "RSI✓ "; } else log += "RSI✗ ";

   sc.rvol = RVOLCheck();
   if (sc.rvol) { pts += 5; log += "RVL✓ "; } else log += "RVL✗ ";

   sc.pattern = PatternCheck(bias);
   if (sc.pattern) { pts += 10; log += "PAT✓"; } else log += "PAT✗";

   sc.total = pts; sc.log = log;
   return sc;
}

//+------------------------------------------------------------------+
//| MASTER ANALYSIS — called every tick within kill zone           |
//+------------------------------------------------------------------+
void RunSymbol() {
   if (HasPosition()) return;

   long spread = SymbolInfoInteger(Symbol(), SYMBOL_SPREAD);
   if (spread > (long)MaxSpreadPts) {
      if (DiagMode && EnableLogs) Print("  [BLOCK] Spread=", spread, " > ", MaxSpreadPts);
      return;
   }

   if (!CorrGuard()) return;
   if (!ADXGate()) { if (DiagMode && EnableLogs) Print("  [BLOCK] ADX below ", ADX_Min); return; }

   VolReg vr = GetVolRegime();
   if (vr == VR_LOW) { if (DiagMode && EnableLogs) Print("  [BLOCK] Low volatility regime"); return; }

   // ── Feature Engine ──────────────────────────────────────────────
   double price   = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   double atr     = GetATR();   if (atr <= 0) return;
   double atr_pct = (price > 0) ? atr / price : 0;
   double rsi     = GetRSI();
   double z       = CalcVWAPZScore(price);
   double skew    = CalcSkewness();
   double ofi     = CalcOFI();

   // ── DOM walls (regime + sweep) ───────────────────────────────────
   double buyWall = 0, sellWall = 0, buySize = 0, sellSize = 0;
   if (!g_isTester) GetLOBWalls(price, buyWall, sellWall, buySize, sellSize);

   // ── Regime ──────────────────────────────────────────────────────
   string regime = DetectRegime(price, z, atr_pct, buyWall, sellWall);
   g_panelRegime = regime;

   // ── Sweep overlay ───────────────────────────────────────────────
   string sweep = "";
   if (!g_isTester) sweep = DetectSweep(price, buyWall, sellWall);

   // ── ICT Layer: Kalman → Structure ───────────────────────────────
   int kBias = KalmanBias();
   if (DiagMode && EnableLogs) Print("  [KAL] bias=", kBias == 1 ? "BULL" : "BEAR");

   int sBias = GetStructureBias(kBias);

   // Determine trade direction
   int bias = 0;
   if (sweep == "ABOVE_HIGHS") bias = -1;
   else if (sweep == "BELOW_LOWS") bias = 1;
   else if (sBias != 0) bias = sBias;
   else if (regime == "RANGE") {
      if (z >= MeanRevZ && rsi > 45)  bias = -1;
      if (z <= -MeanRevZ && rsi < 55) bias =  1;
   }

   if (bias == 0) {
      if (DiagMode && EnableLogs) Print("  [BLOCK] No directional bias — ", regime);
      return;
   }

   // ── Score ────────────────────────────────────────────────────────
   Score sc = BuildScore(bias, sBias, rsi, ofi, skew);
   g_panelConf   = sc.total;
   g_panelDetail = StringFormat("%s %.0f%% [%s]", Symbol(), sc.total, sc.log);

   if (sc.total < MinScore) {
      if (EnableLogs)
         Print("⬜ Score=", DoubleToString(sc.total, 0), "% (need ", DoubleToString(MinScore, 0), "%) | ", sc.log);
      g_panelSignal = "WAIT";
      return;
   }

   // ── Sweep bonus: if sweep + strong score → bump confidence print
   if (sweep != "" && EnableLogs)
      Print("🌊 DOM Sweep: ", sweep, " + score ", sc.total, "% — entering");

   if (EnableLogs)
      Print("🎯 Score=", sc.total, "% | ", sc.log, " | ", (bias == 1 ? "BUY" : "SELL"),
            " Regime=", regime, " Sweep=", (sweep == "" ? "none" : sweep));

   g_panelSignal = (bias == 1 ? "BUY" : "SELL");
   ExecuteTrade(bias, sc, vr, atr, buyWall, sellWall);
}

//+------------------------------------------------------------------+
//| EXECUTE TRADE                                                   |
//+------------------------------------------------------------------+
void ExecuteTrade(int bias, Score &sc, VolReg vr, double atr, double buyWall, double sellWall) {
   MqlRates r[]; ArraySetAsSeries(r, true);
   if (CopyRates(Symbol(), Timeframe, 0, LookbackBars, r) < LookbackBars) return;
   double swL = DBL_MAX, swH = 0;
   for (int i = 1; i < LookbackBars; i++) {
      if (r[i].low  < swL) swL = r[i].low;
      if (r[i].high > swH) swH = r[i].high;
   }

   double ask   = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
   double bid   = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   int    dig   = (int)SymbolInfoInteger(Symbol(), SYMBOL_DIGITS);
   double pt    = SymbolInfoDouble(Symbol(), SYMBOL_POINT);
   double minD  = SymbolInfoInteger(Symbol(), SYMBOL_TRADE_STOPS_LEVEL) * pt * 2.0;
   double tpMult = GetTPMult(vr, sc.total);

   double entry, sl, slDist, tp;

   if (bias == 1) {
      entry   = ask;
      sl      = NormalizeDouble(swL - atr * ATR_SL_Mult, dig);
      slDist  = entry - sl;
      if (slDist < minD) { sl = entry - minD; slDist = minD; }
      // Use sell wall as TP anchor if it would give better R
      double tpBase = NormalizeDouble(entry + slDist * tpMult, dig);
      tp = (sellWall > 0 && sellWall > tpBase) ? NormalizeDouble(sellWall * 0.9997, dig) : tpBase;
   } else {
      entry   = bid;
      sl      = NormalizeDouble(swH + atr * ATR_SL_Mult, dig);
      slDist  = sl - entry;
      if (slDist < minD) { sl = entry + minD; slDist = minD; }
      double tpBase = NormalizeDouble(entry - slDist * tpMult, dig);
      tp = (buyWall > 0 && buyWall < tpBase) ? NormalizeDouble(buyWall * 1.0003, dig) : tpBase;
   }

   if (slDist <= 0) { if (EnableLogs) Print("⚠️ SL dist=0"); return; }

   double rr = MathAbs(tp - entry) / slDist;
   if (rr < MinRR) { if (EnableLogs) Print("⚠️ RR=", DoubleToString(rr, 2), " < ", MinRR, " skip"); return; }

   double riskPct = KellyRisk() * AntiMartScale();
   double lots    = CalcLots(slDist, riskPct);
   if (lots <= 0) { if (EnableLogs) Print("⚠️ Lots=0 slDist=", slDist); return; }

   string vrStr = (vr == VR_HIGH) ? "HiVol" : "MedVol";
   string cmt   = StringFormat("QDv2_%s_S%.0f_%s", (bias == 1 ? "B" : "S"), sc.total, vrStr);
   bool   sent  = (bias == 1) ? Trade.Buy(lots, Symbol(), 0, sl, tp, cmt)
                              : Trade.Sell(lots, Symbol(), 0, sl, tp, cmt);
   if (sent) {
      if (EnableLogs)
         Print("✅ ", (bias == 1 ? "BUY" : "SELL"),
               " | Score=", sc.total, "% | TP=", DoubleToString(tpMult, 1), "R",
               " | Lots=", lots, " | Risk=", DoubleToString(riskPct, 2), "%",
               " | SL=", sl, " | TP=", tp);
      if (EnableAlerts)
         Alert("QuadDesk v2 — ", Symbol(), " ", (bias == 1 ? "BUY" : "SELL"),
               " Score:", sc.total, "% TP:", tpMult, "R");
   } else {
      if (EnableLogs)
         Print("❌ Order failed: ", GetLastError(), " ", Trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| KELLY + ANTI-MARTINGALE                                        |
//+------------------------------------------------------------------+
double KellyRisk() {
   if (!UseKelly || g_histCount < 5) return BaseRiskPct;
   int n = MathMin(g_histCount, KellyLookback);
   double wins = 0, avgWin = 0; int wc = 0;
   for (int i = g_histCount - n; i < g_histCount; i++) {
      if (g_hist[i].rMultiple > 0) { wins++; avgWin += g_hist[i].rMultiple; wc++; }
   }
   double p = wins / n, q = 1 - p;
   double b = (wc > 0) ? avgWin / wc : 1.5; if (b <= 0) return BaseRiskPct;
   double fk = (b * p - q) / b; if (fk <= 0) return BaseRiskPct * 0.5;
   double r = fk * KellyFraction * 100;
   return MathMax(0.25, MathMin(2.0, r));
}

double AntiMartScale() {
   if (!UseAntiMartingale || g_consecLoss == 0) return 1.0;
   double red = MathMin(g_consecLoss * AntiMartPct, AntiMartMax);
   return 1.0 - red / 100.0;
}

double CalcLots(double slDist, double riskPct) {
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double risk = bal * (riskPct / 100.0);
   double tSz  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_SIZE);
   double tVl  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
   double step = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);
   double mn   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MIN);
   double mx   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MAX);
   if (tSz <= 0 || tVl <= 0 || slDist <= 0) return 0;
   double slV = (slDist / tSz) * tVl; if (slV <= 0) return 0;
   double lots = MathFloor((risk / slV) / step) * step;
   return NormalizeDouble(MathMax(mn, MathMin(mx, lots)), 2);
}

//+------------------------------------------------------------------+
//| POSITION MANAGEMENT — Break-even + Trailing                    |
//+------------------------------------------------------------------+
void ManagePositions() {
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      if (!Pos.SelectByIndex(i) || Pos.Magic() != MagicNumber) continue;
      string sym   = Pos.Symbol();
      double open  = Pos.PriceOpen(), curSL = Pos.StopLoss(), curTP = Pos.TakeProfit();
      ulong  ticket = Pos.Ticket();
      ENUM_POSITION_TYPE type = Pos.PositionType();
      double bid   = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask   = SymbolInfoDouble(sym, SYMBOL_ASK);
      double curPx = (type == POSITION_TYPE_BUY) ? bid : ask;
      int    dig   = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double pt    = SymbolInfoDouble(sym, SYMBOL_POINT);
      double initR = MathAbs(open - curSL); if (initR < 1e-10) continue;
      double curR  = (type == POSITION_TYPE_BUY) ? (curPx - open) / initR : (open - curPx) / initR;
      double newSL = curSL;

      // Break-even
      if (curR >= BreakEvenR) {
         if (type == POSITION_TYPE_BUY && curSL < open - pt)
            newSL = NormalizeDouble(open + pt, dig);
         if (type == POSITION_TYPE_SELL && (curSL > open + pt || curSL == 0))
            newSL = NormalizeDouble(open - pt, dig);
      }
      // Trailing
      if (curR >= TrailActivateR) {
         double trl;
         if (type == POSITION_TYPE_BUY) {
            trl = NormalizeDouble(curPx - initR * TrailStepR, dig);
            if (trl > newSL) newSL = trl;
         } else {
            trl = NormalizeDouble(curPx + initR * TrailStepR, dig);
            if (curSL == 0 || trl < newSL) newSL = trl;
         }
      }
      bool imp = (type == POSITION_TYPE_BUY) ? (newSL > curSL + pt) : (curSL == 0 || newSL < curSL - pt);
      if (imp) {
         if (!Trade.PositionModify(ticket, newSL, curTP) && EnableLogs)
            Print("⚠️ SL modify failed: ", sym, " Err:", GetLastError());
         else if (EnableLogs)
            Print("🔧 ", sym, " SL→", NormalizeDouble(newSL, dig), " R=", DoubleToString(curR, 2));
      }
   }
}

//+------------------------------------------------------------------+
//| TRADE CLOSE — Update Kelly history (magic-gated)               |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &req,
                        const MqlTradeResult  &res) {
   if (trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if (!HistoryDealSelect(trans.deal)) return;
   Deal.Ticket(trans.deal);
   // FIXED: only count deals from this EA
   if (Deal.Magic() != MagicNumber) return;
   if (Deal.Entry() != DEAL_ENTRY_OUT && Deal.Entry() != DEAL_ENTRY_INOUT) return;
   double pnl  = Deal.Profit() + Deal.Swap() + Deal.Commission();
   double base = AccountInfoDouble(ACCOUNT_BALANCE) * BaseRiskPct / 100.0;
   double rEst = (base > 0) ? pnl / base : 0;
   if (g_histCount < 300) { g_hist[g_histCount].rMultiple = rEst; g_histCount++; }
   if (pnl < 0) {
      g_consecLoss++;
      if (EnableLogs) Print("🔴 Loss | ConsecLoss=", g_consecLoss, " | AntiMart=",
                            DoubleToString(AntiMartScale() * 100, 0), "% | P&L=", DoubleToString(pnl, 2));
   } else {
      g_consecLoss = 0;
      if (EnableLogs) Print("🟢 Win | P&L=", DoubleToString(pnl, 2));
   }
}

//+------------------------------------------------------------------+
//| HELPERS                                                         |
//+------------------------------------------------------------------+
int CountMyTrades() {
   int n = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--)
      if (Pos.SelectByIndex(i) && Pos.Magic() == MagicNumber) n++;
   return n;
}

bool HasPosition() {
   for (int i = PositionsTotal() - 1; i >= 0; i--)
      if (Pos.SelectByIndex(i) && Pos.Magic() == MagicNumber && Pos.Symbol() == Symbol()) return true;
   return false;
}

//+------------------------------------------------------------------+
//| CHART PANEL (9 lines)                                           |
//+------------------------------------------------------------------+
void DrawPanel() {
   double eq    = AccountInfoDouble(ACCOUNT_EQUITY);
   double dd    = (g_DayEq > 0) ? (g_DayEq - eq) / g_DayEq * 100.0 : 0;
   string lines[9];
   lines[0] = "══════ QUAD DESK v2 — HYBRID INSTITUTIONAL ══════";
   lines[1] = StringFormat("Symbol: %-10s  TF: %-6s  Mode: %s",
              Symbol(), EnumToString(Timeframe), g_isTester ? "BACKTEST" : "LIVE");
   lines[2] = StringFormat("KillZone: %-8s  Broker: GMT+%d",
              InKillZone() ? "✅ ACTIVE" : "⛔ CLOSED", BrokerGMTOffset);
   lines[3] = StringFormat("Regime: %-12s  Score: %.0f%%", g_panelRegime, g_panelConf);
   lines[4] = StringFormat("Signal: %-8s  Kelly: %.2f%%  AntMart: %.0f%%",
              g_panelSignal, KellyRisk(), AntiMartScale() * 100);
   lines[5] = StringFormat("Daily DD: %.2f%%  Halt: %-3s  ConsecLoss: %d",
              dd, g_DayHalt ? "YES" : "NO", g_consecLoss);
   lines[6] = StringFormat("Positions: %d/%d  Risk: %.1f%%  MaxDD: %.1f%%",
              CountMyTrades(), MaxOpenTrades, BaseRiskPct, MaxDailyLossPct);
   lines[7] = StringFormat("LKZ %02d:00-%02d:00 UTC | NKZ %02d:00-%02d:00 UTC",
              LKZ_Open, LKZ_Close, NKZ_Open, NKZ_Close);
   lines[8] = StringFormat("%.60s", g_panelDetail);

   color clr = (g_panelSignal == "BUY")  ? clrLimeGreen :
               (g_panelSignal == "SELL") ? clrTomato : clrGold;

   for (int i = 0; i < 9; i++) {
      string n = "QD2_L" + IntegerToString(i);
      if (ObjectFind(0, n) < 0) {
         ObjectCreate(0, n, OBJ_LABEL, 0, 0, 0);
         ObjectSetInteger(0, n, OBJPROP_CORNER,   CORNER_LEFT_UPPER);
         ObjectSetInteger(0, n, OBJPROP_FONTSIZE,  9);
         ObjectSetString(0,  n, OBJPROP_FONT,      "Consolas");
         ObjectSetInteger(0, n, OBJPROP_BACK,      false);
      }
      ObjectSetString(0,  n, OBJPROP_TEXT,      lines[i]);
      ObjectSetInteger(0, n, OBJPROP_XDISTANCE, 15);
      ObjectSetInteger(0, n, OBJPROP_YDISTANCE, 28 + i * 16);
      ObjectSetInteger(0, n, OBJPROP_COLOR, (i == 0 || i == 4) ? clr : clrWhiteSmoke);
   }
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| BACKTEST REPORT                                                 |
//+------------------------------------------------------------------+
double OnTester() {
   double profit = TesterStatistics(STAT_PROFIT);
   double dd     = TesterStatistics(STAT_EQUITY_DD);
   double trades = TesterStatistics(STAT_TRADES);
   double wins   = TesterStatistics(STAT_PROFIT_TRADES);
   double pf     = TesterStatistics(STAT_PROFIT_FACTOR);
   double sharpe = TesterStatistics(STAT_SHARPE_RATIO);
   double wr     = (trades > 0) ? wins / trades * 100 : 0;
   Print("━━━━━━━━━━━━━━━━━ QUAD DESK v2 RESULTS ━━━━━━━━━━━━━━━━━");
   Print("  Net Profit   : $", DoubleToString(profit, 2));
   Print("  Max Drawdown : $", DoubleToString(dd, 2));
   Print("  Total Trades : ", (int)trades);
   Print("  Win Rate     : ", DoubleToString(wr, 1), "%");
   Print("  Profit Factor: ", DoubleToString(pf, 2));
   Print("  Sharpe Ratio : ", DoubleToString(sharpe, 2));
   Print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
   if (dd == 0 || trades < 10) return 0;
   return (sharpe > 0 ? sharpe : 0.01) * (profit > 0 ? profit : 0) / dd;
}
//+------------------------------------------------------------------+


