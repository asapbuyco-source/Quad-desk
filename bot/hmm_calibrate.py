"""
bot/hmm_calibrate.py  — Dr. Klint Physics Dept. Upgrade (Jun 2026)
====================================================================
WHAT CHANGED FROM THE ORIGINAL:
  1. 5-feature observation vector (was 4) — adds log-return z-score (velocity)
     which is the key discriminant between VOLATILE and TREND at same ATR level.
  2. Per-symbol calibration for BTC, ETH, SOL with ATR normalisation.
  3. Edge-sufficiency validator: checks that calibrated params produce
     positive EV against realistic fee structure before writing.
  4. Regime quality audit: computes separation distance (Bhattacharyya),
     transition stability, and VOLATILE hallucination rate.
  5. Auto-patcher: if edge-sufficient, writes _MU/_SIGMA/_A back into
     main.py via regex so the running bot gets updated without manual copy-paste.
  6. Multi-symbol consensus: fits BTC, ETH, SOL independently, then
     produces an ensemble that is valid across all three.
  7. Walk-forward out-of-sample validation (last 20% of data held out).
  8. Continuous re-calibration cron entry: running with --daemon mode
     schedules a daily re-fit at 02:00 UTC so params stay current.

Usage:
    # Single symbol, interactive:
    python -m bot.hmm_calibrate --symbol BTCUSDT --years 1

    # Full multi-symbol ensemble (recommended before going live):
    python -m bot.hmm_calibrate --multi --years 1

    # Daemon mode (re-calibrates daily at 02:00 UTC):
    python -m bot.hmm_calibrate --multi --daemon

    # Force fresh data (ignore cache):
    python -m bot.hmm_calibrate --multi --no-cache

Output:
    bot/hmm_params.json          — machine-readable params for runtime loader
    bot/hmm_calibration_report.txt  — human-readable audit report
    Patches _MU/_SIGMA/_A in main.py if edge is confirmed sufficient.
"""

import argparse
import json
import os
import re
import sys
import time
import math
import textwrap
from datetime import datetime, timezone, timedelta
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Physics constants
# ---------------------------------------------------------------------------
FEE_RATE          = 0.0002    # Binance USDM maker fee (entry always postOnly limit)
ROUND_TRIP_COST   = FEE_RATE + 0.0002 * 0.55 + 0.0005 * 0.45   # 0.0535%: maker entry + TP/SL blend
#                                ^maker TP@55%WR   ^taker SL@45%WR
MIN_EDGE_THRESHOLD = 0.003    # 0.3% minimum expected move net of fees
BHATTACHARYYA_MIN  = 0.40     # minimum state separation (0=identical, ∞=perfect)
VOLATILE_HALLUCINATION_MAX = 0.35  # max fraction of RANGE bars mis-labelled VOLATILE
TREND_STABILITY_MIN        = 0.70  # P(TREND→TREND) must be this high for real trend regime

from bot.hmm_features import FEATURE_SCHEMA_V2  # F-01: schema identity for main.py validation

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

# ATR normalisation scale — same values as signal_config.py SYMBOL_ATR_SCALE
# Divides each symbol's atr_pct before feeding into the BTC-calibrated HMM.
ATR_SCALE = {"BTCUSDT": 1.0, "ETHUSDT": 1.4, "SOLUSDT": 3.2}

# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------

def _calc_atr(high, low, close, period=14):
    tr = np.maximum(high[1:] - low[1:],
                    np.maximum(np.abs(high[1:] - close[:-1]),
                               np.abs(low[1:] - close[:-1])))
    atr = np.full(len(close), np.nan)
    if len(tr) >= period:
        atr[period] = np.mean(tr[:period])
        for i in range(period + 1, len(close)):
            atr[i] = (atr[i-1] * (period - 1) + tr[i-1]) / period
    return atr


def _calc_vwap_zscore(close, high, low, volume, period=20):
    """Legacy 20-bar VWAP Z — kept for backward compatibility.
    The runtime bot uses session_vwap_z (24h rolling). Calibration now uses
    the SAME 24h definition via _calc_session_vwap_z to avoid feature mismatch."""
    import pandas as pd
    tp   = (high + low + close) / 3.0
    vol  = pd.Series(volume)
    tp_s = pd.Series(tp)
    vwap = (tp_s * vol).rolling(period).sum() / vol.rolling(period).sum()
    std  = tp_s.rolling(period).std(ddof=0)
    z    = (pd.Series(close) - vwap) / std
    return z.fillna(0).values


def _calc_session_vwap_z(close, high, low, volume, atr_pct_rank):
    """Replicate runtime quant_engine._session_vwap_z: 24h rolling VWAP,
    n_sig-bar std window, quadrature floor, clipped to [-4, 4]."""
    n = len(close)
    z = np.zeros(n)
    WINDOW_BARS = 96  # 24h of 15m
    for i in range(50, n):
        s = max(0, i - WINDOW_BARS)
        tp = (high[s:i + 1] + low[s:i + 1] + close[s:i + 1]) / 3.0
        v = volume[s:i + 1]
        vwap = np.sum(tp * v) / max(np.sum(v), 1e-9)
        n_sig = max(10, min(25, int((1.0 - atr_pct_rank[i]) * 40 + 10)))
        lo = max(0, i - n_sig)
        h = high[lo:i]
        l = low[lo:i]
        c = close[lo:i]
        vv = volume[lo:i]
        if len(h) < 5 or np.sum(vv) <= 0:
            continue
        tp_w = (h + l + c) / 3.0
        vw_var = np.sum(vv * (tp_w - vwap) ** 2) / np.sum(vv)
        std = np.sqrt(vw_var)
        min_std = close[i] * 0.00005
        std = np.sqrt(std * std + min_std * min_std)
        z[i] = (close[i] - vwap) / std
    return np.clip(z, -4.0, 4.0)


def _calc_zret(close, period=20):
    """Log-return z-score: velocity of price move relative to recent std."""
    import pandas as pd
    log_ret = np.zeros(len(close))
    log_ret[1:] = np.log(np.maximum(close[1:], 1e-10) /
                          np.maximum(close[:-1], 1e-10))
    s = pd.Series(log_ret)
    mu  = s.rolling(period).mean().fillna(0).values
    sig = s.rolling(period).std(ddof=0).fillna(1e-8).values
    zr  = np.where(sig > 1e-9, (log_ret - mu) / sig, 0.0)
    return np.clip(zr, -5.0, 5.0)


def _calc_atr_rank(atr_pct, window=2880):
    """Percentile rank of current ATR% within 30-day rolling window."""
    rank = np.zeros(len(atr_pct))
    for i in range(50, len(atr_pct)):
        w = atr_pct[max(0, i - window):i]
        if len(w) > 0:
            rank[i] = np.mean(w <= atr_pct[i])
    return rank


def build_feature_matrix(df, symbol: str = "BTCUSDT", start_idx: int = 50):
    """
    F-01 FIX: Build 7-column observation matrix matching FEATURE_SCHEMA_V2.
      f0: atr_pct / atr_scale         — normalised volatility level
      f1: |z_score|                   — VWAP deviation magnitude
      f2: tape_bin (binary)           — volume spike indicator
      f3: atr_pct_rank                — ATR percentile in 30-day window
      f4: |z_ret|                     — log-return velocity (kinetic energy)
      f5: funding_rate × 1000         — funding rate scaled and bounded
      f6: sma_disp                    — SIGNED (close - SMA100)/SMA100 — trend direction
    """
    close  = df['close'].values.astype(float)
    high   = df['high'].values.astype(float)
    low    = df['low'].values.astype(float)
    volume = df['volume'].values.astype(float)

    atr_scale = ATR_SCALE.get(symbol.upper(), 2.0)

    atr     = _calc_atr(high, low, close, period=14)
    atr_pct = np.where(close > 0, atr / close, 0.0) / atr_scale
    atr_rank = _calc_atr_rank(atr_pct, window=2880)
    # FIX: use the SAME 24h VWAP Z as the runtime bot (feature mismatch fix)
    zscore  = _calc_session_vwap_z(close, high, low, volume, atr_rank)
    abs_z   = np.abs(zscore)
    z_ret   = _calc_zret(close, period=20)
    abs_zr  = np.abs(z_ret)

    vol_sma  = df['volume'].shift(1).rolling(60, min_periods=1).mean().fillna(0).values
    tape_bin = np.where(volume > vol_sma * 3.0, 1.0, 0.0)

    funding_rate = df['funding_rate'].values.astype(float)

    # f6: SIGNED displacement from 100-bar SMA — catches directional trends.
    # A 22% rally puts price ~+10-20% above SMA100; a range oscillates near 0.
    import pandas as pd
    sma100 = pd.Series(close).rolling(100, min_periods=20).mean().fillna(pd.Series(close)).values
    sma_disp = np.where(sma100 > 0, (close - sma100) / sma100, 0.0)
    sma_disp = np.clip(sma_disp, -0.30, 0.30)

    X = np.column_stack([
        np.clip(atr_pct[start_idx:],  0.0, 0.03),   # f0
        np.clip(abs_z[start_idx:],    0.0, 4.0),     # f1
        tape_bin[start_idx:],                        # f2
        np.clip(atr_rank[start_idx:], 0.0, 1.0),    # f3
        np.clip(abs_zr[start_idx:],   0.0, 4.0),    # f4
        np.clip(funding_rate[start_idx:] * 1000, -2.0, 2.0), # f5
        sma_disp[start_idx:],                        # f6
    ])
    valid = np.all(np.isfinite(X), axis=1)
    return X[valid], valid


# ---------------------------------------------------------------------------
# HMM fitting
# ---------------------------------------------------------------------------

def fit_hmm(X, n_components=5, n_iter=300, n_restarts=3):
    """F-02: 5-state GaussianHMM — RANGE, COMPRESSION, TREND, VOLATILE, SQUEEZE."""
    from hmmlearn import hmm as hmmlearn_hmm
    best_model = None
    best_score = -np.inf
    for seed in range(n_restarts):
        model = hmmlearn_hmm.GaussianHMM(
            n_components=n_components,
            covariance_type="diag",
            n_iter=n_iter,
            tol=1e-5,
            random_state=seed,
            verbose=False,
        )
        model.fit(X, lengths=[len(X)])
        score = model.score(X, lengths=[len(X)])
        if score > best_score:
            best_score = score
            best_model = model
    print(f"  Best log-likelihood: {best_score:.2f} (over {n_restarts} restarts)")
    return best_model


def order_states(model):
    """
    F-02 FIX: Order 5 HMM states by ascending atr_pct mean (f0).
    RANGE < COMPRESSION < TREND < VOLATILE < SQUEEZE.
    
    The first 4 states are ordered by atr_pct ascending. SQUEEZE is the
    highest-atr state (f0 max) with extreme |z_ret| (f4 max). If the
    highest-atr state has lower |z_ret| than state 3, swap them.
    """
    n_s = model.means_.shape[0]
    order = np.argsort(model.means_[:, 0])  # sort by atr_pct ascending

    # Refine SQUEEZE/VOLATILE: SQUEEZE should have highest |z_ret| (f4)
    if n_s >= 5:
        s3, s4 = order[3], order[4]
        if model.means_[s3, 4] > model.means_[s4, 4]:
            order = np.array([order[0], order[1], order[2], s4, s3])

    return np.array(order)


def extract_params(model, order):
    mu    = model.means_[order].astype(float)
    n_f   = model.covars_.shape[1]
    sigma = np.sqrt(model.covars_[order][:, range(n_f), range(n_f)]).astype(float)
    A     = model.transmat_[order][:, order].astype(float)
    pi    = model.startprob_[order].astype(float)
    return mu, sigma, A, pi


# ---------------------------------------------------------------------------
# Edge-sufficiency validation (the key Physics Dept. contribution)
# ---------------------------------------------------------------------------

def bhattacharyya_distance(mu1, sigma1, mu2, sigma2):
    """
    Bhattacharyya distance between two diagonal Gaussians.
    BD > 0.40 indicates adequate separation for reliable classification.
    """
    sigma_avg = (sigma1 + sigma2) / 2.0
    term1 = 0.125 * np.sum(((mu1 - mu2) ** 2) / np.maximum(sigma_avg, 1e-9))
    term2 = 0.5 * np.sum(np.log(
        np.maximum(sigma_avg, 1e-9) /
        np.sqrt(np.maximum(sigma1 * sigma2, 1e-18))
    ))
    return term1 + term2


def compute_hallucination_rate(X, model, order, labels):
    """
    Compute fraction of low-volatility (RANGE-class) bars that the HMM
    labels as VOLATILE. High hallucination → the VOLATILE state is leaking
    into quiet market conditions.
    """
    from hmmlearn import hmm as hmmlearn_hmm
    states = model.predict(X)
    range_idx    = list(order).index(order[0])   # RANGE = lowest atr state
    volatile_idx = labels.index("VOLATILE")  # F-02: was hardcoded 2 — wrong for 5-state

    # RANGE bars: f0 (atr_pct) below 25th percentile
    q25 = np.percentile(X[:, 0], 25)
    low_vol_mask = X[:, 0] <= q25

    reordered = np.zeros_like(states)
    for new_idx, old_state in enumerate(order):
        reordered[states == old_state] = new_idx

    volatile_in_low_vol = np.sum((reordered == volatile_idx) & low_vol_mask)
    total_low_vol       = np.sum(low_vol_mask)
    return float(volatile_in_low_vol / max(total_low_vol, 1))


def compute_expected_edge(mu, sigma, A, labels, fee_rate=FEE_RATE):
    """
    Estimate expected edge per trade from calibrated HMM parameters.

    Physics model:
      - In RANGE:    mean reversion expected move ≈ 2 * mu[RANGE, f0] (ATR proxy)
        but only realised with P(reversion) ≈ 1 - A[RANGE,RANGE]
      - In TREND:    momentum expected move ≈ mu[TREND, f1] * mu[TREND, f0]
      - In VOLATILE: either momentum or MR depending on z_ret (f4)

    This is a ROUGH lower bound. Actual edge depends on entry timing.
    Return: dict of estimated_gross_edge, net_edge, edge_sufficient bool
    """
    range_idx    = labels.index("RANGE")
    comp_idx     = labels.index("COMPRESSION") if "COMPRESSION" in labels else range_idx
    trend_idx    = labels.index("TREND")
    volatile_idx = labels.index("VOLATILE")
    squeeze_idx  = labels.index("SQUEEZE") if "SQUEEZE" in labels else volatile_idx
    n_states     = len(labels)

    # RANGE edge: ATR move on mean reversion, realised fraction = 1 - persistence
    range_atr  = mu[range_idx, 0]
    range_persistence = A[range_idx, range_idx]
    range_edge = range_atr * (1.0 - range_persistence)

    # COMPRESSION edge: coiling spring — higher potential energy than RANGE
    comp_atr  = mu[comp_idx, 0]
    comp_persistence = A[comp_idx, comp_idx]
    comp_edge = comp_atr * (1.0 - comp_persistence) * 1.2  # 20% bonus for explosive breakouts

    # TREND edge: z_score magnitude × atr gives approximate expected move
    trend_atr  = mu[trend_idx, 0]
    trend_z    = mu[trend_idx, 1]
    trend_edge = trend_atr * min(trend_z, 3.0) * 0.3

    # VOLATILE edge: weighted by KE routing probability
    vol_zret = mu[volatile_idx, 4] if mu.shape[1] > 4 else 1.0
    ke = 0.5 * vol_zret ** 2
    p_trend_route = 1.0 - math.exp(-max(ke - 0.86, 0.0))
    p_mr_route = 1.0 - p_trend_route
    vol_edge = (p_trend_route * trend_edge + p_mr_route * range_edge) * 0.7

    # SQUEEZE edge: cascade vacuum — highest ATR with rapid reversion
    squeeze_atr = mu[squeeze_idx, 0]
    squeeze_persistence = A[squeeze_idx, squeeze_idx] if squeeze_idx != volatile_idx else 0.3
    squeeze_edge = squeeze_atr * (1.0 - squeeze_persistence) * 1.5  # explosive reversion

    # Weighted by stationary distribution (eigenvector of A)
    try:
        evals, evecs = np.linalg.eig(A.T)
        stat_idx = np.argmin(np.abs(evals - 1.0))
        stationary = np.abs(evecs[:, stat_idx])
        stationary /= stationary.sum()
    except Exception:
        stationary = np.ones(n_states) / n_states

    edges = np.array([range_edge, comp_edge, trend_edge, vol_edge, squeeze_edge])
    if len(edges) > n_states:
        edges = edges[:n_states]
    gross_edge = float(np.dot(stationary, edges))
    net_edge   = gross_edge - ROUND_TRIP_COST
    sufficient = net_edge >= MIN_EDGE_THRESHOLD

    return {
        "gross_edge":      float(gross_edge),
        "net_edge":        float(net_edge),
        "edge_sufficient": bool(sufficient),
        "stationary_dist": [float(x) for x in stationary.tolist()],
        "range_edge":      float(range_edge),
        "compression_edge": float(comp_edge),
        "trend_edge":      float(trend_edge),
        "volatile_edge":   float(vol_edge),
        "squeeze_edge":    float(squeeze_edge),
    }


def validate_params(mu, sigma, A, labels):
    """
    Full physics audit of calibrated parameters.
    Returns (passed: bool, report: dict).
    """
    range_idx       = labels.index("RANGE")
    comp_idx        = labels.index("COMPRESSION") if "COMPRESSION" in labels else range_idx
    trend_idx       = labels.index("TREND")
    volatile_idx    = labels.index("VOLATILE")
    squeeze_idx     = labels.index("SQUEEZE") if "SQUEEZE" in labels else volatile_idx

    # 1. Bhattacharyya separation — key pairs
    bd_rc = bhattacharyya_distance(mu[range_idx],    sigma[range_idx],
                                    mu[comp_idx],     sigma[comp_idx])   # RANGE/COMPRESSION
    bd_ct = bhattacharyya_distance(mu[comp_idx],     sigma[comp_idx],
                                    mu[trend_idx],    sigma[trend_idx])   # COMPRESSION/TREND
    bd_rt = bhattacharyya_distance(mu[range_idx],    sigma[range_idx],
                                    mu[trend_idx],    sigma[trend_idx])   # RANGE/TREND
    bd_tv = bhattacharyya_distance(mu[trend_idx],    sigma[trend_idx],
                                    mu[volatile_idx], sigma[volatile_idx]) # TREND/VOLATILE
    bd_vs = bhattacharyya_distance(mu[volatile_idx], sigma[volatile_idx],
                                    mu[squeeze_idx],  sigma[squeeze_idx])  # VOLATILE/SQUEEZE

    # F-02 FIX: Mandatory separation — TREND must be separable from COMPRESSION
    # and VOLATILE (the two adjacent states). RANGE/VOLATILE was the old problem;
    # now COMPRESSION bridges them so separation is naturally better.
    bd_ct_ok = bd_ct >= BHATTACHARYYA_MIN  # mandatory
    bd_tv_ok = bd_tv >= BHATTACHARYYA_MIN  # mandatory
    sep_ok = bd_ct_ok and bd_tv_ok

    # 2. TREND persistence
    trend_stability = A[trend_idx, trend_idx]
    stability_ok = trend_stability >= TREND_STABILITY_MIN

    # 3. State ordering: atr_pct must be strictly RANGE < COMP < TREND < VOL < SQUEEZE
    vol_ordering_ok = (
        mu[range_idx, 0] < mu[comp_idx, 0] < mu[trend_idx, 0] < mu[volatile_idx, 0] < mu[squeeze_idx, 0]
    )

    # 4. TREND has highest |z| (f1)
    trend_highest_z = mu[trend_idx, 1] >= max(mu[range_idx, 1], mu[comp_idx, 1],
                                                mu[volatile_idx, 1], mu[squeeze_idx, 1])

    # 5. Sigma > 0 for all
    sigma_positive = np.all(sigma > 0)

    # 6. Transition rows sum to 1
    row_sums_ok = np.allclose(A.sum(axis=1), 1.0, atol=1e-3)

    passed = all([sep_ok, stability_ok, vol_ordering_ok, trend_highest_z,
                   sigma_positive, row_sums_ok])

    return bool(passed), {
        "bhattacharyya_range_compression":  float(round(bd_rc, 4)),
        "bhattacharyya_compression_trend":  float(round(bd_ct, 4)),
        "bhattacharyya_range_trend":        float(round(bd_rt, 4)),
        "bhattacharyya_trend_volatile":     float(round(bd_tv, 4)),
        "bhattacharyya_volatile_squeeze":   float(round(bd_vs, 4)),
        "separation_ok":                    bool(sep_ok),
        "trend_persistence":                float(round(trend_stability, 4)),
        "stability_ok":                     bool(stability_ok),
        "vol_ordering_ok":                  bool(vol_ordering_ok),
        "trend_highest_z":                  bool(trend_highest_z),
        "sigma_positive":                   bool(sigma_positive),
        "row_sums_ok":                      bool(row_sums_ok),
    }


# ---------------------------------------------------------------------------
# Walk-forward out-of-sample test
# ---------------------------------------------------------------------------

def walk_forward_test(X, n_components=5, train_frac=0.80):
    """
    Train on first train_frac of data, evaluate label consistency on remainder.
    Returns accuracy proxy: fraction of OOS bars where predicted state
    matches the in-sample state distribution for that volatility level.
    """
    n_train = int(len(X) * train_frac)
    X_train = X[:n_train]
    X_test  = X[n_train:]

    if len(X_train) < 200 or len(X_test) < 50:
        return {"oos_consistency": None, "note": "Insufficient data for walk-forward"}

    model_train = fit_hmm(X_train, n_components, n_restarts=1)  # speed: consistency check only
    order_train = order_states(model_train)
    mu_train, sigma_train, A_train, _ = extract_params(model_train, order_train)

    # Full model for reference
    model_full  = fit_hmm(X, n_components, n_restarts=1)  # speed: consistency check only
    order_full  = order_states(model_full)
    mu_full, sigma_full, _, _ = extract_params(model_full, order_full)

    # OOS: predict with train model, then with full model
    states_train_on_oos = model_train.predict(X_test)
    states_full_on_oos  = model_full.predict(X_test)

    # Remap to ordered labels for both
    def remap(states, order):
        out = np.zeros_like(states)
        for new_i, old_s in enumerate(order):
            out[states == old_s] = new_i
        return out

    oos_train = remap(states_train_on_oos, order_train)
    oos_full  = remap(states_full_on_oos,  order_full)

    # Consistency: fraction where both agree on the regime label
    consistency = float(np.mean(oos_train == oos_full))

    return {
        "n_train":          n_train,
        "n_oos":            len(X_test),
        "oos_consistency":  round(float(consistency), 4),
        "interpretation":   "GOOD" if consistency >= 0.70 else "UNSTABLE — need more data",
    }


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def fetch_data(symbol: str, interval: str = "15m", years_back: int = 1,
               use_cache: bool = True):
    """Fetch OHLCV from Binance with local cache."""
    import pandas as pd
    cache_dir  = os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, f"{symbol}_{interval}_cached.pkl")

    if use_cache and os.path.exists(cache_file):
        age_h = (time.time() - os.path.getmtime(cache_file)) / 3600.0
        if age_h < 24:
            try:
                df = pd.read_pickle(cache_file)
                print(f"  [CACHE] {symbol}: {len(df):,} bars (age={age_h:.1f}h)")
                return df
            except Exception:
                pass

    try:
        import requests
    except ImportError:
        print("  [ERROR] requests not installed. Run: pip install requests")
        return pd.DataFrame()

    end_dt   = datetime.now()
    start_dt = end_dt - timedelta(days=int(365 * years_back))
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms   = int(end_dt.timestamp()   * 1000)

    print(f"  [FETCH] {symbol} {interval} from Binance "
          f"[{start_dt.date()} -> {end_dt.date()}]...")

    all_klines = []
    cur = start_ms
    while cur < end_ms:
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/klines",  # USDM Futures endpoint
            params={"symbol": symbol, "interval": interval,
                    "startTime": cur, "endTime": end_ms, "limit": 1500},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        all_klines.extend(batch)
        cur = int(batch[-1][0]) + 1
        if len(batch) < 1500:
            break

    if not all_klines:
        print(f"  [WARN] No data returned for {symbol}")
        return pd.DataFrame()

    cols = ['time','open','high','low','close','volume',
            'close_time','quote_vol','trades',
            'taker_buy_base','taker_buy_quote','ignore']
    df = pd.DataFrame(all_klines, columns=cols)
    df['time'] = pd.to_datetime(df['time'].astype(int), unit='ms')
    df.set_index('time', inplace=True)
    for c in ('open','high','low','close','volume','taker_buy_base'):
        df[c] = df[c].astype(float)
    df.drop(columns=[c for c in df.columns
                     if c not in ('open','high','low','close','volume','taker_buy_base')],
            inplace=True)

    print(f"  [OK] {len(df):,} bars  ({df.index[0].date()} -> {df.index[-1].date()})")
    
    # Fetch funding rate
    print(f"  [FETCH] {symbol} Funding Rate...")
    fr_list = []
    fr_cur = start_ms
    while fr_cur < end_ms:
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/fundingRate",
            params={"symbol": symbol, "startTime": fr_cur, "endTime": end_ms, "limit": 1000},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch: break
        fr_list.extend(batch)
        fr_cur = int(batch[-1]['fundingTime']) + 1
        if len(batch) < 1000: break
    if fr_list:
        import pandas as pd
        fr_df = pd.DataFrame(fr_list)
        fr_df['time'] = pd.to_datetime(fr_df['fundingTime'].astype(int), unit='ms')
        fr_df['funding_rate'] = fr_df['fundingRate'].astype(float)
        fr_df.set_index('time', inplace=True)
        # Keep only funding_rate and drop duplicates if any
        fr_df = fr_df[~fr_df.index.duplicated(keep='last')][['funding_rate']]
        df = df.join(fr_df, how='left')
        df['funding_rate'] = df['funding_rate'].ffill().fillna(0.0)
    else:
        df['funding_rate'] = 0.0

    try:
        df.to_pickle(cache_file)
    except Exception as e:
        print(f"  [WARN] Cache write failed: {e}")
    return df


# ---------------------------------------------------------------------------
# Ensemble: combine multi-symbol calibrations
# ---------------------------------------------------------------------------

def ensemble_params(results: list, weights=None):
    """
    Weighted average of mu, sigma, A across symbols.
    Weights default to equal. BTC gets 2× weight (reference asset).
    """
    if weights is None:
        weights = [2.0 if r["symbol"] == "BTCUSDT" else 1.0 for r in results]
    total_w = sum(weights)
    weights = [w / total_w for w in weights]

    mu_ens    = sum(w * np.array(r["mu"])    for w, r in zip(weights, results))
    sigma_ens = sum(w * np.array(r["sigma"]) for w, r in zip(weights, results))
    A_ens     = sum(w * np.array(r["A"])     for w, r in zip(weights, results))

    # Re-normalise transition rows
    A_ens = A_ens / A_ens.sum(axis=1, keepdims=True)
    return mu_ens, sigma_ens, A_ens


def ensemble_pi(results: list, weights=None):
    """F-06 FIX: Weighted average initial-state distribution across symbols."""
    if weights is None:
        weights = [2.0 if r["symbol"] == "BTCUSDT" else 1.0 for r in results]
    total_w = sum(weights)
    weights = [w / total_w for w in weights]
    pi_ens = sum(w * np.array(r["pi"]) for w, r in zip(weights, results))
    pi_ens = pi_ens / pi_ens.sum()
    return pi_ens.tolist()


# ---------------------------------------------------------------------------
# Auto-patcher: writes params into main.py
# ---------------------------------------------------------------------------

def patch_main_py(mu, sigma, A, labels, dry_run=False):
    """
    Locate and replace _MU, _SIGMA, _A arrays in main.py using regex.
    Creates a .bak backup before writing.
    """
    main_path = os.path.join(os.path.dirname(__file__), "main.py")
    if not os.path.exists(main_path):
        print(f"  [PATCH] main.py not found at {main_path} — skipping auto-patch.")
        return False

    with open(main_path, "r", encoding="utf-8") as f:
        src = f.read()

    def arr_to_py(arr, name, comments):
        lines = [f"    {name} = np.array(["]
        for i, row in enumerate(arr):
            vals = ", ".join(f"{v:.8f}" for v in row)
            comment = f"  # {comments[i]}" if i < len(comments) else ""
            lines.append(f"        [{vals}],{comment}")
        lines.append("    ], dtype=float)")
        return "\n".join(lines)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    mu_block    = arr_to_py(mu, "_MU", labels) + f"\n    # Auto-patched {ts}"
    sigma_block = arr_to_py(sigma, "_SIGMA", labels) + f"\n    # Auto-patched {ts}"

    a_lines = [f"    _A = np.array(["]
    for i, row in enumerate(A):
        vals = ", ".join(f"{v:.6f}" for v in row)
        a_lines.append(f"        [{vals}],   # {labels[i]}")
    a_lines.append("    ], dtype=float)")
    a_lines.append(f"    # Auto-patched {ts}")
    a_block = "\n".join(a_lines)

    # Patterns: match the _MU = np.array([...]) blocks inside the class
    mu_pattern    = r"(_MU\s*=\s*np\.array\(\[)(.*?)(\],\s*dtype=float\))"
    sigma_pattern = r"(_SIGMA\s*=\s*np\.array\(\[)(.*?)(\],\s*dtype=float\))"
    a_pattern     = r"(_A\s*=\s*np\.array\(\[)(.*?)(\],\s*dtype=float\))"

    def replace_block(src, pattern, new_inner):
        m = re.search(pattern, src, re.DOTALL)
        if not m:
            return src, False
        # Build replacement keeping same indentation
        replacement = f"    {new_inner}"
        return src[:m.start()] + replacement + src[m.end():], True

    mu_body    = arr_to_py(mu, "_MU", labels).strip()
    sigma_body = arr_to_py(sigma, "_SIGMA", labels).strip()
    a_body     = a_block.strip()

    patched, ok1 = replace_block(src, mu_pattern, mu_body)
    patched, ok2 = replace_block(patched, sigma_pattern, sigma_body)
    patched, ok3 = replace_block(patched, a_pattern, a_body)

    if not all([ok1, ok2, ok3]):
        print(f"  [PATCH] Regex match failed (ok1={ok1} ok2={ok2} ok3={ok3}). "
              f"Manual paste required — see hmm_params.json.")
        return False

    if dry_run:
        print("  [PATCH] Dry-run — not writing main.py. Pass --patch to apply.")
        return True

    bak = main_path + ".bak"
    with open(bak, "w", encoding="utf-8") as f:
        f.write(src)
    with open(main_path, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"  [PATCH] main.py updated. Backup at {bak}")
    return True


# ---------------------------------------------------------------------------
# Main calibration runner
# ---------------------------------------------------------------------------

def run_single(symbol: str, interval: str = "15m", years_back: int = 1,
               use_cache: bool = True):
    """Calibrate for one symbol. Returns result dict or None on failure."""
    print(f"\n{'='*60}")
    print(f"  Calibrating {symbol} | {interval} | {years_back}yr")
    print(f"{'='*60}")

    df = fetch_data(symbol, interval, years_back, use_cache)
    if df.empty or len(df) < 500:
        print(f"  [FAIL] Insufficient data for {symbol}. Need ≥500 bars.")
        return None

    X, valid_mask = build_feature_matrix(df, symbol=symbol)
    print(f"  Observations: {len(X):,} (after NaN removal)")

    # Walk-forward first (uses its own internal fit)
    print("  Running walk-forward OOS validation...")
    wf = walk_forward_test(X)
    print(f"  OOS consistency: {wf.get('oos_consistency', 'N/A')} "
          f"[{wf.get('interpretation', '')}]")

    # Full fit
    print(f"  Fitting GaussianHMM(5 states, diag cov, 300 iter)...")
    try:
        model = fit_hmm(X)
    except Exception as e:
        print(f"  [FAIL] HMM fit error: {e}")
        return None

    order  = order_states(model)
    labels = ["RANGE", "COMPRESSION", "TREND", "VOLATILE", "SQUEEZE"]
    mu, sigma, A, pi = extract_params(model, order)

    print(f"\n  Calibrated means (MU):")
    for i, lab in enumerate(labels):
        print(f"    {lab:10s}: atr%={mu[i,0]:.5f}  |z|={mu[i,1]:.3f}  "
              f"tape={mu[i,2]:.2f}  rank={mu[i,3]:.3f}  |zret|={mu[i,4]:.3f}  fr={mu[i,5]:.3f}")

    print(f"\n  Transition matrix:")
    for i, lab in enumerate(labels):
        row = "  ".join(f"{v:.4f}" for v in A[i])
        print(f"    {lab:10s} -> [{row}]")

    # Validation
    val_passed, val_report = validate_params(mu, sigma, A, labels)
    print(f"\n  Physics validation: {'PASS' if val_passed else 'FAIL'}")
    for k, v in val_report.items():
        flag = ""
        if k.startswith("bhattacharyya"):
            flag = " [OK]" if float(v) >= BHATTACHARYYA_MIN else " [FAIL] (too low)"
        print(f"    {k}: {v}{flag}")

    # Hallucination rate
    hall_rate = compute_hallucination_rate(X, model, order, labels)
    hall_ok   = hall_rate <= VOLATILE_HALLUCINATION_MAX
    print(f"\n  VOLATILE hallucination rate: {hall_rate:.1%} "
          f"({'OK' if hall_ok else 'HIGH - params will over-classify VOLATILE'})")

    # Edge estimate
    edge = compute_expected_edge(mu, sigma, A, labels)
    print(f"\n  Expected edge estimate:")
    print(f"    Gross edge:  {edge['gross_edge']:.4%}")
    print(f"    Net of fees: {edge['net_edge']:.4%}  "
          f"({'SUFFICIENT' if edge['edge_sufficient'] else 'INSUFFICIENT'})")
    print(f"    Stationary distribution: "
          f"RANGE={edge['stationary_dist'][0]:.1%}  "
          f"TREND={edge['stationary_dist'][1]:.1%}  "
          f"VOLATILE={edge['stationary_dist'][2]:.1%}")

    overall_ok = val_passed and hall_ok and edge["edge_sufficient"]
    print(f"\n  Overall: {'EDGE-SUFFICIENT - safe to deploy' if overall_ok else 'NOT SUFFICIENT - do not deploy'}")

    return {
        "symbol":         symbol,
        "interval":       interval,
        "years_back":     years_back,
        "n_obs":          len(X),
        "mu":             mu.tolist(),
        "sigma":          sigma.tolist(),
        "A":              A.tolist(),
        "pi":             pi.tolist(),
        "labels":         labels,
        "validation":     val_report,
        "hallucination":  round(hall_rate, 4),
        "edge":           edge,
        "walk_forward":   wf,
        "overall_ok":     bool(overall_ok),
        "generated_at":   datetime.now(timezone.utc).isoformat(),
        "start":          str(df.index.min()),
        "end":            str(df.index.max()),
    }


def run_multi(interval: str = "15m", years_back: int = 1,
              use_cache: bool = True, patch: bool = False):
    """Run calibration for BTC + ETH + SOL and produce ensemble."""
    results = []
    for sym in SYMBOLS:
        r = run_single(sym, interval, years_back, use_cache)
        if r is not None:
            results.append(r)

    if not results:
        print("\n[FAIL] No symbols calibrated successfully.")
        return

    # Ensemble
    print(f"\n{'='*60}")
    print(f"  ENSEMBLE — combining {len(results)} symbols")
    print(f"{'='*60}")
    mu_ens, sigma_ens, A_ens = ensemble_params(results)
    labels = results[0]["labels"]

    val_passed, val_report = validate_params(mu_ens, sigma_ens, A_ens, labels)
    edge = compute_expected_edge(mu_ens, sigma_ens, A_ens, labels)
    # B-04 FIX: Include hallucination gate in ensemble validation.
    # Previously hall_ok was computed per-symbol but dropped from the
    # ensemble gate check, allowing high-hallucination ensembles to ship.
    hall_rate_max = max(r["hallucination"] for r in results)
    hall_ok = hall_rate_max <= VOLATILE_HALLUCINATION_MAX

    print(f"  Ensemble validation: {'PASS' if val_passed else 'FAIL'}")
    print(f"  Ensemble net edge:   {edge['net_edge']:.4%} "
          f"({'SUFFICIENT' if edge['edge_sufficient'] else 'INSUFFICIENT'})")
    print(f"  Max hallucination:   {hall_rate_max:.2%} "
          f"({'OK' if hall_ok else 'HIGH'}) (<= {VOLATILE_HALLUCINATION_MAX:.0%})")

    overall_ok = val_passed and edge["edge_sufficient"] and hall_ok

    # Build output
    start_ts = min(r["start"] for r in results)
    end_ts   = max(r["end"]   for r in results)
    output = {
        "mu":        mu_ens.tolist(),
        "sigma":     sigma_ens.tolist(),
        "transmat":  A_ens.tolist(),
        # F-06 FIX: Include calibrated initial-state distribution pi
        "pi":        ensemble_pi(results) if all("pi" in r for r in results) else [0.50, 0.30, 0.20],
        "labels":    labels,
        "meta": {
            "mode":           "multi_symbol_ensemble",
            "symbols":        [r["symbol"] for r in results],
            "interval":       interval,
            "years_back":     years_back,
            "feature_schema": list(FEATURE_SCHEMA_V2),  # F-01: schema identity for main.py validation
            "total_obs":      sum(r["n_obs"] for r in results),
            "start":          start_ts,
            "end":            end_ts,
            "generated_at":   datetime.now(timezone.utc).isoformat(),
            "overall_ok":     bool(overall_ok),
            "net_edge":       edge["net_edge"],
            "hallucination":  max(r["hallucination"] for r in results),
            "bhattacharyya_min": min(
                val_report.get("bhattacharyya_compression_trend", 0),
                val_report.get("bhattacharyya_trend_volatile", 0),
                val_report.get("bhattacharyya_range_compression", 0),
            ),
        },
        "per_symbol": results,
        "validation": val_report,
        "edge":       edge,
    }

    out_path = os.path.join(os.path.dirname(__file__), "hmm_params.json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Saved -> {out_path}")

    _write_report(output, results)

    # Emit paste-able code block for manual review
    _print_paste_block(mu_ens, sigma_ens, A_ens, labels)

    if overall_ok:
        print("\n  Edge confirmed — attempting auto-patch of main.py...")
        patch_main_py(mu_ens, sigma_ens, A_ens, labels, dry_run=not patch)
    else:
        print("\n  ⛔  Edge NOT confirmed. main.py NOT patched.")
        print("      Collect more data (--years 2) or review regime separation.")

    return output


def _print_paste_block(mu, sigma, A, labels):
    """Print the exact arrays to paste into main.py."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"\n{'='*60}")
    print(f"  PASTE BLOCK — copy into _HMMRegimeClassifier in main.py")
    print(f"  Generated: {ts}")
    print(f"{'='*60}")

    print("    _MU = np.array([")
    for i, lab in enumerate(labels):
        vals = ", ".join(f"{v:.8f}" for v in mu[i])
        print(f"        [{vals}],   # {lab}")
    print("    ], dtype=float)")

    print("\n    _SIGMA = np.array([")
    for i, lab in enumerate(labels):
        vals = ", ".join(f"{v:.8f}" for v in sigma[i])
        print(f"        [{vals}],   # {lab}")
    print("    ], dtype=float)")

    print("\n    _A = np.array([")
    for i, lab in enumerate(labels):
        vals = ", ".join(f"{v:.6f}" for v in A[i])
        print(f"        [{vals}],   # {lab}")
    print("    ], dtype=float)")


def _write_report(output, per_symbol):
    """Write human-readable audit report."""
    lines = []
    meta  = output["meta"]
    edge  = output["edge"]
    val   = output["validation"]

    lines.append("HMM CALIBRATION AUDIT REPORT")
    lines.append("=" * 60)
    lines.append(f"Generated: {meta['generated_at']}")
    lines.append(f"Mode:      {meta['mode']}")
    lines.append(f"Symbols:   {', '.join(meta['symbols'])}")
    lines.append(f"Interval:  {meta['interval']}")
    lines.append(f"Period:    {meta['start'][:10]} -> {meta['end'][:10]}")
    lines.append(f"Obs count: {meta['total_obs']:,}")
    lines.append("")
    lines.append("EDGE SUFFICIENCY")
    lines.append(f"  Gross expected edge:  {edge['gross_edge']:.4%}")
    lines.append(f"  Round-trip fee cost:  {ROUND_TRIP_COST:.4%}")
    lines.append(f"  Net edge:             {edge['net_edge']:.4%}")
    lines.append(f"  Sufficient (≥0.30%):  {meta['overall_ok']}")
    lines.append("")
    lines.append("REGIME SEPARATION (Bhattacharyya distance, min required 0.40)")
    lines.append(f"  RANGE vs COMPRESSION: {val['bhattacharyya_range_compression']:.4f}")
    lines.append(f"  COMPRESSION vs TREND: {val['bhattacharyya_compression_trend']:.4f}  (mandatory)")
    lines.append(f"  RANGE vs TREND:       {val['bhattacharyya_range_trend']:.4f}")
    lines.append(f"  TREND vs VOLATILE:    {val['bhattacharyya_trend_volatile']:.4f}  (mandatory)")
    lines.append(f"  VOLATILE vs SQUEEZE:  {val['bhattacharyya_volatile_squeeze']:.4f}")
    # B-02 FIX: Dynamically identify which pair(s) failed
    failed_pairs = []
    if val['bhattacharyya_compression_trend'] < BHATTACHARYYA_MIN:
        failed_pairs.append("COMPRESSION/TREND")
    if val['bhattacharyya_trend_volatile'] < BHATTACHARYYA_MIN:
        failed_pairs.append("TREND/VOLATILE")
    lines.append(f"  Separation gate:    {'PASS' if val['separation_ok'] else 'FAIL — ' + ', '.join(failed_pairs)}")
    lines.append("")
    lines.append("HALLUCINATION")
    lines.append(f"  Max across symbols: {meta['hallucination']:.1%}  "
                 f"(limit: {VOLATILE_HALLUCINATION_MAX:.0%})")
    lines.append("")
    lines.append("PER-SYMBOL WALK-FORWARD")
    for r in per_symbol:
        wf = r.get("walk_forward", {})
        lines.append(f"  {r['symbol']}: OOS consistency = "
                     f"{wf.get('oos_consistency', 'N/A')}  [{wf.get('interpretation', '')}]")
    lines.append("")
    lines.append("READINESS VERDICT")
    lines.append("  DEPLOY" if meta["overall_ok"] else "  NOT READY")
    lines.append("")
    lines.append("ACTION REQUIRED IF NOT READY")
    lines.append("  1. Collect >= 2 years of data (--years 2)")
    lines.append("  2. Check Bhattacharyya distances — if TREND vs VOLATILE < 0.40,")
    lines.append("     the feature set cannot separate them. Add funding rate as f5.")
    lines.append("  3. If hallucination rate high, the VOLATILE state boundary is too")
    lines.append("     diffuse — clip atr_pct more aggressively (reduce to 0.02).")

    report_path = os.path.join(os.path.dirname(__file__),
                               "hmm_calibration_report.txt")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"  Report -> {report_path}")


# ---------------------------------------------------------------------------
# Daemon mode
# ---------------------------------------------------------------------------

def run_daemon(interval: str, years_back: int, patch: bool):
    """Re-calibrate daily at 02:00 UTC."""
    import schedule
    print("[Daemon] Scheduled daily re-calibration at 02:00 UTC. Ctrl-C to stop.")
    schedule.every().day.at("02:00").do(
        run_multi, interval=interval, years_back=years_back,
        use_cache=False, patch=patch
    )
    while True:
        schedule.run_pending()
        time.sleep(60)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="BossBot HMM calibration — Physics Dept. upgrade"
    )
    parser.add_argument("--symbol",   default="BTCUSDT",
                        help="Single symbol (default BTCUSDT)")
    parser.add_argument("--interval", default="15m")
    parser.add_argument("--years",    type=int, default=1,
                        help="Years of history to fetch (recommend 1–2)")
    parser.add_argument("--multi",    action="store_true",
                        help="Calibrate BTC+ETH+SOL and produce ensemble")
    parser.add_argument("--no-cache", action="store_true",
                        help="Force fresh data from Binance (ignore local cache)")
    parser.add_argument("--patch",    action="store_true",
                        help="If edge confirmed, auto-patch _MU/_SIGMA/_A in main.py")
    parser.add_argument("--daemon",   action="store_true",
                        help="Run as daily re-calibration daemon (requires schedule)")
    args = parser.parse_args()

    use_cache = not args.no_cache

    if args.daemon:
        try:
            import schedule
        except ImportError:
            print("Install schedule: pip install schedule")
            sys.exit(1)
        run_daemon(args.interval, args.years, args.patch)
    elif args.multi:
        run_multi(args.interval, args.years, use_cache=use_cache, patch=args.patch)
    else:
        result = run_single(args.symbol, args.interval, args.years, use_cache)
        if result:
            out_path = os.path.join(os.path.dirname(__file__), "hmm_params.json")
            single_output = {
                "mu":       result["mu"],
                "sigma":    result["sigma"],
                "transmat": result["A"],
                "labels":   result["labels"],
                "meta": {
                    "symbol":       result["symbol"],
                    "interval":     result["interval"],
                    "years_back":   result["years_back"],
                    "observations": result["n_obs"],
                    "start":        result["start"],
                    "end":          result["end"],
                    "generated_at": result["generated_at"],
                    "overall_ok":   result["overall_ok"],
                    "net_edge":     result["edge"]["net_edge"],
                },
            }
            with open(out_path, "w") as f:
                json.dump(single_output, f, indent=2)
            print(f"\nSaved -> {out_path}")
            _print_paste_block(
                np.array(result["mu"]),
                np.array(result["sigma"]),
                np.array(result["A"]),
                result["labels"],
            )
            if result["overall_ok"] and args.patch:
                patch_main_py(
                    np.array(result["mu"]),
                    np.array(result["sigma"]),
                    np.array(result["A"]),
                    result["labels"],
                )
