import os
import time
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
import warnings

warnings.filterwarnings('ignore')

try:
    from colorama import Fore, Style, init
    init(autoreset=True)
except ImportError:
    class Fore: GREEN = RED = YELLOW = CYAN = WHITE = MAGENTA = ""
    class Style: RESET_ALL = BRIGHT = ""

# ==============================================================================
# MAin CONFIGURATION and new changes for ATR Threshold for the Live Bot
# ATR threshold is the Minimum ATR required to enter the market. 
# It makes sure that there is enough volatility to trade and make a profit.
# ==============================================================================
CONFIG = {
    "symbols": ["BTCUSDT"],
    "timeframe_mins": 15,
    "initial_balance": 10000.0,
    "base_risk_pct": 1.0,
    "max_daily_loss_pct": 3.0,
    "min_confidence": 0.60,
    
    # Feature Engine
    "atr_period": 14,
    "rsi_period": 14,
    "vwap_period": 20,
    "skew_period": 20,  # was 50 — matches live bot Fix 2
    
    # Thresholds
    "trend_atr_threshold": 0.006,
    "range_z_threshold": 1.06,

    # ── Realistic execution friction ─────────────────────────────────
    # slippage_bps: half-spread cost per side (3 bps on a $95k BTC ≈ $2.85 per side)
    # Set to 0 to see 'theoretical max' performance, 3-5 is realistic for liquid markets
    "slippage_bps": 3,
    # commission_pct: exchange fee per trade LEG (Coinbase Advanced taker = 0.10%)
    # Total round-trip cost at defaults: 3 bps slip ×2 + 0.10% comm ×2 = ~0.26% per trade
    "commission_pct": 0.0004,    # expressed as a fraction (0.001 = 0.1%)
}

# ==============================================================================
# VECTORISED FEATURE ENGINE
# ==============================================================================

def calc_atr(high, low, close, period=14):
    tr = np.maximum(high[1:] - low[1:], 
                    np.maximum(np.abs(high[1:] - close[:-1]), 
                               np.abs(low[1:] - close[:-1])))
    atr = np.full(len(close), np.nan)
    if len(tr) >= period:
        atr[period] = np.mean(tr[:period])
        for i in range(period + 1, len(close)):
            atr[i] = (atr[i-1] * (period - 1) + tr[i-1]) / period
    return atr

def calc_rsi(close, period=14):
    delta = np.diff(close)
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    rsi = np.full(len(close), 50.0)
    if len(gains) >= period:
        avg_g = np.mean(gains[:period])
        avg_l = np.mean(losses[:period])
        for i in range(period, len(gains)):
            avg_g = (avg_g * (period - 1) + gains[i]) / period
            avg_l = (avg_l * (period - 1) + losses[i]) / period
            rsi[i+1] = 100 - (100 / (1 + avg_g / avg_l)) if avg_l > 0 else 100
    return rsi

def calc_vwap_zscore(df, period=20):
    tp = (df['high'] + df['low'] + df['close']) / 3.0
    vol = df['volume']
    
    vwap = (tp * vol).rolling(period).sum() / vol.rolling(period).sum()
    std = tp.rolling(period).std(ddof=0)
    
    z = (df['close'] - vwap) / std
    return z.fillna(0).values

def calc_skewness(close, period=50):
    log_ret = np.zeros(len(close))
    log_ret[1:] = np.log(close[1:] / np.maximum(close[:-1], 1e-10))
    skew = pd.Series(log_ret).rolling(period).skew().fillna(0).values
    return skew

def calc_cvd_proxy(close, open_, volume, period=20, taker_buy_base=None):
    """
    Cumulative Volume Delta.
    If `taker_buy_base` is supplied (Binance kline field 9), uses the exact
    live formula matching App.tsx:  delta = 2 × takerBuyVol − totalVol
    Otherwise falls back to the candle-sign body-weighted proxy.
    """
    if taker_buy_base is not None:
        # Exact formula — mirrors the live frontend CVD calculation
        delta = (2.0 * taker_buy_base) - volume
    else:
        body  = np.abs(close - open_)
        conv  = np.clip(body / (body + 1e-10), 0.3, 1.0)
        dir_  = np.where(close >= open_, 1.0, -1.0)
        delta = dir_ * volume * conv
    cvd = pd.Series(delta).rolling(period).sum().fillna(0).values
    return cvd


# ==============================================================================
# REAL DATA FETCHER — Binance Public REST API
# ==============================================================================

def fetch_binance_candles(symbol: str, interval: str = "5m", years_back: int = 2) -> pd.DataFrame:
    """
    Fetch real OHLCV + taker-buy-volume klines from the Binance public API.
    Returns a DataFrame with columns: open, high, low, close, volume, taker_buy_base
    Falls back to an empty DataFrame on any network/API error.
    """
    try:
        import requests as _req
    except ImportError:
        print("  ⚠️  `requests` not installed. Run: pip install requests")
        return pd.DataFrame()

    end_dt   = datetime.now()
    start_dt = end_dt - timedelta(days=int(365 * years_back))
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms   = int(end_dt.timestamp()   * 1000)

    print(f"  Fetching {symbol} ({interval}) from Binance API "
          f"[{start_dt.date()} → {end_dt.date()}]...")

    all_klines: list = []
    current_ms = start_ms

    while current_ms < end_ms:
        try:
            resp = _req.get(
                "https://api.binance.com/api/v3/klines",
                params={"symbol":    symbol,
                        "interval":  interval,
                        "startTime": current_ms,
                        "endTime":   end_ms,
                        "limit":     1000},
                timeout=20,
            )
            resp.raise_for_status()
            batch = resp.json()
        except Exception as exc:
            print(f"  ⚠️  Binance API error: {exc}. Falling back to CSV / synthetic data.")
            return pd.DataFrame()

        if not batch:
            break
        all_klines.extend(batch)
        current_ms = int(batch[-1][0]) + 1
        if len(batch) < 1000:
            break

    if not all_klines:
        return pd.DataFrame()

    cols = [
        'time', 'open', 'high', 'low', 'close', 'volume',
        'close_time', 'quote_vol', 'trades',
        'taker_buy_base', 'taker_buy_quote', 'ignore',
    ]
    df = pd.DataFrame(all_klines, columns=cols)
    df['time'] = pd.to_datetime(df['time'].astype(int), unit='ms')
    df.set_index('time', inplace=True)
    for col in ('open', 'high', 'low', 'close', 'volume', 'taker_buy_base'):
        df[col] = df[col].astype(float)

    print(f"  ✓ {len(df):,} real bars loaded  "
          f"({df.index[0].date()} → {df.index[-1].date()})")
    return df


# ==============================================================================
# STRATEGY & BAYESIAN FUSION
# ==============================================================================

def backtest_hybrid(df, config, symbol):
    close = df['close'].values
    high = df['high'].values
    low = df['low'].values
    open_ = df['open'].values
    vol = df['volume'].values
    ts = df.index
    
    print("  Computing features...")
    atr = calc_atr(high, low, close, config['atr_period'])
    rsi = calc_rsi(close, config['rsi_period'])
    zscore = calc_vwap_zscore(df, config['vwap_period'])
    skew = calc_skewness(close, config['skew_period'])
    # CVD: use real taker-buy volume when available (Binance kline field 'taker_buy_base')
    # This mirrors the live app formula exactly: delta = 2 * takerBuyVol - totalVol
    taker_buy_base = df['taker_buy_base'].values if 'taker_buy_base' in df.columns else None
    cvd = calc_cvd_proxy(close, open_, vol, 20, taker_buy_base=taker_buy_base)
    
    atr_pct = np.zeros_like(atr)
    valid_idx = close > 0
    atr_pct[valid_idx] = atr[valid_idx] / close[valid_idx]

    atr_pct_rank = np.zeros(len(close))
    for idx in range(50, len(close)):
        window = atr_pct[max(0, idx-2880):idx]
        if len(window) > 0:
            atr_pct_rank[idx] = np.mean(window <= atr_pct[idx])

    # Proxies for missing live data (LOB / Tape)
    # We use local extreme rollings to simulate walls / liquidity pools
    sw_high = pd.Series(high).rolling(20).max().shift(1).values
    sw_low  = pd.Series(low).rolling(20).min().shift(1).values
    
    # OFI proxy based on volume delta momentum
    ofi_proxy = pd.Series(np.where(close >= open_, vol, -vol)).rolling(5).sum().values
    ofi_normalised = np.tanh(ofi_proxy / 2.0)  # array, index with [i] in loop

    # Volume-surge proxy for the live bot’s SCREAMING tape requirement (Stage 2 TREND gate)
    # Live:  10-second taker notional > 3× per-10s rolling baseline → SCREAMING
    # Proxy: current bar volume > 3× 60-bar rolling mean (same 3× multiplier, different window)
    vol_sma_60 = pd.Series(vol).rolling(60, min_periods=1).mean().shift(1).fillna(0).values
    
    print("  Simulating event-driven trades...")
    
    balance = config['initial_balance']
    trades = []
    open_trades = []
    
    daily_losses = 0
    last_day = None
    daily_halt = False
    
    backtest_alpha = 7.0
    backtest_beta = 5.0
    backtest_regime_alpha = {"RANGE": 7.0, "NEUTRAL": 7.0, "TREND": 7.0, "LIQUIDITY": 7.0}
    backtest_regime_beta = {"RANGE": 5.0, "NEUTRAL": 5.0, "TREND": 5.0, "LIQUIDITY": 5.0}
    backtest_regime_count = {"RANGE": 0, "NEUTRAL": 0, "TREND": 0, "LIQUIDITY": 0}
    
    for i in range(50, len(close)):
        cur_day = ts[i].date()
        if cur_day != last_day:
            daily_losses = 0
            daily_halt = False
            last_day = cur_day
            
        px = close[i]
        
        # 1. Manage Open Trades
        still_open = []
        for t in open_trades:
            hit_sl = (t['dir'] == 1 and low[i] <= t['sl']) or (t['dir'] == -1 and high[i] >= t['sl'])
            hit_tp = (t['dir'] == 1 and high[i] >= t['tp']) or (t['dir'] == -1 and low[i] <= t['tp'])
            
            if hit_sl or hit_tp:
                # Pessimistic Bias: if both hit in the same candle, assume Stop Loss occurred first
                if hit_sl and hit_tp:
                    raw_exit = t['sl']
                else:
                    raw_exit = t['sl'] if hit_sl else t['tp']
                    
                is_long  = t['dir'] == 1

                # ── Apply realistic friction ─────────────────────────────
                slip = config.get('slippage_bps', 3) / 10_000.0
                comm = config.get('commission_pct', 0.0004)  # Binance USDM futures default

                # Slippage worsens both fill prices
                if is_long:
                    eff_entry = t['entry'] * (1.0 + slip)
                    eff_exit  = raw_exit  * (1.0 - slip)
                else:
                    eff_entry = t['entry'] * (1.0 - slip)
                    eff_exit  = raw_exit  * (1.0 + slip)

                # ── Correct Risk Position Sizing ─────────────────────────
                risk_usd = balance * (config['base_risk_pct'] / 100.0)
                sl_distance = abs(t['entry'] - t['sl'])
                
                # How much coin to buy so that sl_distance == risk_usd
                size_coin = risk_usd / max(sl_distance, 1e-9)
                notional_value = size_coin * t['entry']
                
                # Raw directional PnL based on nominal cost vs exit
                price_diff = (eff_exit - eff_entry) if is_long else (eff_entry - eff_exit)
                raw_pnl = size_coin * price_diff

                # Commission is paid on total notional volume traded (Entry + Exit)
                exit_notional = size_coin * eff_exit
                commission_cost = (notional_value + exit_notional) * comm

                pnl = raw_pnl - commission_cost
                r_mult = pnl / max(risk_usd, 1e-9)

                exit_px = raw_exit  # keep original for logging
                balance += pnl
                if pnl < 0:
                    daily_losses += 1
                    if daily_losses >= int(config['max_daily_loss_pct']):
                        daily_halt = True
                
                trades.append({
                    "entry_time": t['entry_time'],
                    "exit_time": ts[i],
                    "dir": "BUY" if t['dir'] == 1 else "SELL",
                    "entry": t['entry'],
                    "exit": exit_px,
                    "pnl": pnl,
                    "r_mult": r_mult,
                    "balance": balance,
                    "regime": t['regime']
                })
                won = (pnl > 0)
                trade_regime = t['regime']
                if won:
                    backtest_alpha += 1.0
                    backtest_regime_alpha[trade_regime] = backtest_regime_alpha.get(trade_regime, 1.0) + 1.0
                else:
                    backtest_beta += 1.0
                    backtest_regime_beta[trade_regime] = backtest_regime_beta.get(trade_regime, 1.0) + 1.0
                backtest_regime_count[trade_regime] = backtest_regime_count.get(trade_regime, 0) + 1
            else:
                still_open.append(t)
        open_trades = still_open
        
        if daily_halt or len(open_trades) > 0:
            continue
            
        # 2. Market Regime
        regime = "NEUTRAL"
        # Proximate to recent swing high/low (simulated walls)
        near_wall = False
        nav_h = sw_high[i]
        nav_l = sw_low[i]
        
        if not np.isnan(nav_h) and not np.isnan(nav_l):
            if abs(px - nav_h) / px <= 0.001 or abs(px - nav_l) / px <= 0.001:
                regime = "LIQUIDITY"
                near_wall = True
        
        if not near_wall:
            # Mirror live bot Stage 2: TREND requires high ATR AND a volume surge
            # (proxy for the SCREAMING tape condition checked against Binance trade feed)
            sma_vol   = vol_sma_60[i] if i < len(vol_sma_60) else 0.0
            vol_surge = sma_vol > 0 and vol[i] > sma_vol * 3.0
            if atr_pct[i] > config['trend_atr_threshold'] and vol_surge:
                regime = "TREND"
            elif abs(zscore[i]) < config['range_z_threshold']:
                regime = "RANGE"
                
        # 3. Liquidity Sweep Detection
        sweep = None
        if not np.isnan(nav_h) and not np.isnan(nav_l):
            prev_h, prev_l = high[i-1], low[i-1]
            prev_c = close[i-1]
            if prev_h > nav_h and px < nav_h:
                sweep = "ABOVE_HIGHS"
            elif prev_l < nav_l and px > nav_l:
                sweep = "BELOW_LOWS"
                
        # 4. Synthese Pre-Bayes matching live `quant_engine.py`
        curr_rsi = rsi[i]
        curr_z = zscore[i]
        curr_skew = skew[i]
        curr_ofi = ofi_normalised[i]  # tanh scale (-1, +1), replaces raw proxy * 10.0

        L_rsi  = 1.8 if curr_rsi > 60 else 0.55 if curr_rsi < 40 else 1.0
        if curr_z < -1.22 and curr_ofi > 0.15:
            L_flow = 2.0
        elif curr_z > 1.22 and curr_ofi < -0.15:
            L_flow = 0.5
        else:
            L_z = 1.3 if curr_z < -1.22 else 0.76 if curr_z > 1.22 else 1.0
            L_o = 1.2 if curr_ofi > 0.30 else 0.83 if curr_ofi < -0.30 else 1.0
            L_flow = L_z * L_o

        L_skew = 1.2 if curr_skew > 0.3 else 0.83 if curr_skew < -0.3 else 1.0
        p_prior = backtest_alpha / (backtest_alpha + backtest_beta)
        prior_odds = p_prior / (1.0 - p_prior)
        bull_odds = prior_odds * L_rsi * L_flow * L_skew
        bayes = bull_odds / (bull_odds + 1.0)
                
        # 5. Strategy Layer
        raw_direction = None
        strategy = ""
        
        if sweep:
            strategy = "SWEEP"
            if sweep == "ABOVE_HIGHS" and (curr_ofi < -0.15 or cvd[i] < 0):
                raw_direction = "SELL"
            elif sweep == "BELOW_LOWS" and (curr_ofi > 0.15 or cvd[i] > 0):
                raw_direction = "BUY"
                
        elif regime == "TREND":
            strategy = "TREND"
            score = 0.0
            
            if bayes > 0.65:    score += 2.0
            elif bayes > 0.55:  score += 1.0
            elif bayes < 0.35:  score -= 2.0
            elif bayes < 0.45:  score -= 1.0

            if curr_ofi > 0.30:         score += 1.5
            elif curr_ofi > 0.15:        score += 0.75
            elif curr_ofi < -0.30:      score -= 1.5
            elif curr_ofi < -0.15:       score -= 0.75

            if cvd[i] > 0: score += 1.0
            elif cvd[i] < 0: score -= 1.0
            
            if curr_ofi > 0: score += 1.0
            elif curr_ofi < 0: score -= 1.0
            
            if score >= 1.5: raw_direction = "BUY"
            elif score <= -1.5: raw_direction = "SELL"
            
        elif regime == "RANGE":
            strategy = "MEAN_REVERSION"
            atr_rank = atr_pct_rank[i]
            if atr_rank < 0.5:
                rsi_long_gate = 55.0
                rsi_short_gate = 45.0
            else:
                rsi_long_gate = 42.0
                rsi_short_gate = 58.0
            if curr_z >= 1.06 and curr_rsi > rsi_short_gate: raw_direction = "SELL"
            elif curr_z <= -1.06 and curr_rsi < rsi_long_gate: raw_direction = "BUY"
            
        if not raw_direction: continue

        # 6. Bayesian Fusion + ULIS proxy
        odds = 1.0
        if curr_ofi > 0.30:    odds *= 2.0
        elif curr_ofi > 0.15:   odds *= 1.4
        elif curr_ofi < -0.30: odds *= 0.5
        elif curr_ofi < -0.15:  odds *= 0.7

        if cvd[i] > 0: odds *= 1.25
        elif cvd[i] < 0: odds *= 0.8

        if curr_skew > 0.3: odds *= 1.12
        elif curr_skew < -0.3: odds *= 0.88
        
        if curr_rsi > 60: odds *= 1.15
        elif curr_rsi < 40: odds *= 0.85
        
        p_bull = odds / (odds + 1.0)
        conf = p_bull if raw_direction == "BUY" else (1.0 - p_bull)

        # CVD directional gate: penalise trades where CVD contradicts direction.
        # Mirrors Stage 4.5 CVD divergence logic in the live bot.
        cvd_confirms_long  = (raw_direction == "BUY"  and cvd[i] > 0)
        cvd_confirms_short = (raw_direction == "SELL" and cvd[i] < 0)
        if not (cvd_confirms_long or cvd_confirms_short):
            conf -= 0.04  # Mild penalty for CVD-contradicting direction

        if (raw_direction == "BUY" and curr_ofi < 0 and curr_z < 0) or \
           (raw_direction == "SELL" and curr_ofi > 0 and curr_z > 0):
            conf -= 0.15 # ULIS cascade veto penalty simulation
        
        if conf < config['min_confidence']:
            continue
            
        # 7. Risk Engine
        is_long = raw_direction == "BUY"
        cur_atr = atr[i]
        
        if strategy == "SWEEP" and sweep:
            sl_dist = abs(px - nav_h if sweep == "ABOVE_HIGHS" else nav_l) + cur_atr * 0.5
            sl_dist = max(sl_dist, cur_atr * 1.43)
        elif strategy == "TREND":
            sl_dist = cur_atr * 2.09  # matches REGIME_PARAMS TREND
        elif strategy == "MEAN_REVERSION":
            sl_dist = cur_atr * 1.43  # matches REGIME_PARAMS RANGE/NEUTRAL
        else:
            sl_dist = px * 0.008

        rr_map = {"SWEEP": 2.0, "TREND": 2.5, "MEAN_REVERSION": 1.8}
        rr_target = rr_map.get(strategy, 2.0)

        sl = px - sl_dist if is_long else px + sl_dist
        tp = px + (sl_dist * rr_target) if is_long else px - (sl_dist * rr_target)
        
        open_trades.append({
            "entry": px,
            "sl": sl,
            "tp": tp,
            "dir": 1 if is_long else -1,
            "entry_time": ts[i],
            "regime": regime
        })

    # Close remaining open trades at the last known price
    last_px = close[-1]
    slip = config.get('slippage_bps', 3) / 10_000.0
    comm = config.get('commission_pct', 0.001)
    for t in open_trades:
        is_long = t['dir'] == 1
        eff_entry = t['entry'] * (1.0 + slip) if is_long else t['entry'] * (1.0 - slip)
        eff_exit  = last_px  * (1.0 - slip) if is_long else last_px  * (1.0 + slip)

        # Correct position sizing (same as main loop)
        risk_usd = balance * (config['base_risk_pct'] / 100.0)
        sl_distance = abs(t['entry'] - t['sl'])
        size_coin = risk_usd / max(sl_distance, 1e-9)
        notional_value = size_coin * t['entry']

        price_diff = (eff_exit - eff_entry) if is_long else (eff_entry - eff_exit)
        raw_pnl = size_coin * price_diff

        exit_notional = size_coin * eff_exit
        commission_cost = (notional_value + exit_notional) * comm
        pnl = raw_pnl - commission_cost
        balance += pnl
        trades.append({
            "entry_time": t['entry_time'],
            "exit_time": ts[-1],
            "dir": "BUY" if t['dir'] == 1 else "SELL",
            "entry": t['entry'],
            "exit": last_px,
            "pnl": pnl,
            "r_mult": pnl / max(risk_usd, 1e-9),
            "balance": balance,
            "regime": t['regime']
        })
        
    return trades, balance

# ==============================================================================
# MAIN RUNNER
# ==============================================================================

def load_data(symbol: str, years_back: int = 2) -> pd.DataFrame:
    """
    Data loading priority (most to least realistic):
      1. Binance public REST API  — real OHLCV + taker-buy volume  [DEFAULT]
      2. Local CSV at data/{symbol}_M5.csv
      3. Synthetic random walk    — LAST RESORT, results are non-predictive
    """
    # ── 1. Real Binance data (preferred) ───────────────────────────────────────
    df = fetch_binance_candles(symbol, interval="15m", years_back=years_back)
    if not df.empty:
        return df

    # ── 2. Local CSV fallback ──────────────────────────────────────────────
    csv_path = f"data/{symbol}_M5.csv"
    if os.path.exists(csv_path):
        print(f"  Loading {csv_path}...")
        df = pd.read_csv(csv_path, index_col=0, parse_dates=True)
        df.sort_index(inplace=True)
        return df

    # ── 3. Synthetic fallback (CI / offline only) ───────────────────────────
    print("\n  ⚠️  WARNING: No real data available. Using SYNTHETIC random walk.")
    print("  ⚠️  Results are for code validation ONLY — NOT predictive of live performance.\n")
    np.random.seed(42)
    end_date = datetime.now()
    try:
        start_date = end_date.replace(year=end_date.year - years_back)
    except ValueError:
        start_date = end_date.replace(year=end_date.year - years_back, day=end_date.day - 1)

    periods = int((end_date - start_date).total_seconds() / 300)  # 5-min bars
    dates   = pd.date_range(end=end_date, periods=periods, freq="5min")

    returns = np.random.normal(0, 0.001, periods) * np.abs(np.random.normal(1, 0.2, periods))
    close   = 30_000.0 * np.exp(np.cumsum(returns))   # BTC-realistic starting price
    high    = close * (1 + np.abs(np.random.normal(0, 0.0005, periods)))
    low     = close * (1 - np.abs(np.random.normal(0, 0.0005, periods)))
    open_   = np.roll(close, 1); open_[0] = close[0]
    vol     = np.random.lognormal(mean=10, sigma=1, size=periods)

    return pd.DataFrame(
        {'open': open_, 'high': high, 'low': low, 'close': close, 'volume': vol},
        index=dates,
    )

def run():
    print(f"\n{Fore.CYAN}{Style.BRIGHT}{'━'*62}")
    print(f"  Macro Hybrid Bot — Vectorised Backtester")
    print(f"  10-Year Test Engine")
    print(f"{'━'*62}{Style.RESET_ALL}\n")
    
    t_start = time.time()
    
    for symbol in CONFIG['symbols']:
        print(f"  {Fore.CYAN}▶ {symbol}{Style.RESET_ALL}")
        # Try to load local CSV if it exists, otherwise use synthetic
        csv_path = f"data/{symbol}_M5.csv"
        if os.path.exists(csv_path):
            print(f"  Loading {csv_path}...")
            df = pd.read_csv(csv_path, index_col=0, parse_dates=True)
            df.sort_index(inplace=True)
        else:
            df = load_data(symbol)
            
        print(f"  Bars: {len(df):,} ({df.index[0].date()} -> {df.index[-1].date()})")
        
        trades, final_bal = backtest_hybrid(df, CONFIG, symbol)
        
        # Report
        df_t = pd.DataFrame(trades)
        if len(df_t) == 0:
            print(f"  {Fore.RED}No trades executed.{Style.RESET_ALL}")
            continue
            
        wins = (df_t['pnl'] > 0).sum()
        total = len(df_t)
        wr = wins / total * 100
        net = df_t['pnl'].sum()
        
        print(f"\n  Results for {symbol}:")
        print(f"  Initial Balance: ${CONFIG['initial_balance']:,.2f}")
        color = Fore.GREEN if net > 0 else Fore.RED
        print(f"  Final Balance:   {color}${final_bal:,.2f}{Style.RESET_ALL}")
        print(f"  Net Profit:      {color}${net:,.2f}{Style.RESET_ALL}")
        print(f"  Total Trades:    {total}")
        print(f"  Win Rate:        {wr:.1f}%")
        
        # Breakdown by regime
        print("\n  Performance by Regime:")
        by_regime = df_t.groupby('regime').agg(
            trades=('pnl', 'count'),
            win_rate=('pnl', lambda x: (x>0).mean() * 100),
            pnl=('pnl', 'sum')
        )
        print(by_regime.to_string())
        print(f"\n{Fore.CYAN}{Style.BRIGHT}{'━'*62}{Style.RESET_ALL}\n")
        
    print(f"  Total time: {time.time() - t_start:.2f}s")

if __name__ == "__main__":
    run()
