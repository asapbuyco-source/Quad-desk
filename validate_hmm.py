"""Offline HMM validation — replay 2 years of BTC through the calibrated classifier.
Proves the sma_disp feature fixes TREND blindness before any live candle."""
import json
import sys
import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

df = pd.read_pickle("data/BTCUSDT_15m_cached.pkl")
print(f"Loaded {len(df):,} bars: {df.index[0]} -> {df.index[-1]}")

close = df["close"].values.astype(float)
high = df["high"].values.astype(float)
low = df["low"].values.astype(float)
volume = df["volume"].values.astype(float)

sma100 = pd.Series(close).rolling(100, min_periods=20).mean().fillna(pd.Series(close)).values
sma_disp = np.clip(np.where(sma100 > 0, (close - sma100) / sma100, 0.0), -0.30, 0.30)

params = json.load(open("bot/hmm_params.json", encoding="utf-8"))
mu = np.array(params["mu"], dtype=float)
sigma = np.array(params["sigma"], dtype=float)
A = np.array(params["transmat"], dtype=float)
labels = params["labels"]
pi = np.array(params.get("pi", [0.5, 0.2, 0.15, 0.1, 0.05]), dtype=float)

from bot.hmm_calibrate import _calc_atr, _calc_vwap_zscore, _calc_zret, _calc_atr_rank, ATR_SCALE

atr = _calc_atr(high, low, close, period=14)
atr_pct = np.where(close > 0, atr / close, 0.0) / ATR_SCALE["BTCUSDT"]
abs_z = np.abs(_calc_vwap_zscore(close, high, low, volume, period=20))
abs_zr = np.abs(_calc_zret(close, period=20))
vol_sma = pd.Series(volume).rolling(60, min_periods=1).mean().fillna(0).values
tape_bin = np.where(volume > vol_sma * 3.0, 1.0, 0.0)
atr_rank = _calc_atr_rank(atr_pct, window=2880)
funding_rate = df["funding_rate"].values.astype(float)

start = 50
X = np.column_stack([
    np.clip(atr_pct[start:], 0.0, 0.03),
    np.clip(abs_z[start:], 0.0, 4.0),
    tape_bin[start:],
    np.clip(atr_rank[start:], 0.0, 1.0),
    np.clip(abs_zr[start:], 0.0, 4.0),
    np.clip(funding_rate[start:] * 1000, -2.0, 2.0),
    sma_disp[start:],
])
times = df.index[start:]

T, K = len(X), len(mu)
logA = np.log(np.maximum(A, 1e-300))
logpi = np.log(np.maximum(pi, 1e-300))
logb = np.zeros((T, K))
for k in range(K):
    diff = X - mu[k]
    logb[:, k] = -0.5 * np.sum(diff * diff / np.maximum(sigma[k] ** 2, 1e-12), axis=1)
logb[:, :] -= 0.5 * np.sum(np.log(2 * np.pi * np.maximum(sigma ** 2, 1e-12)))

alpha = np.zeros((T, K))
alpha[0] = logpi + logb[0]
for t in range(1, T):
    prev = alpha[t - 1] - alpha[t - 1].max()
    alpha[t] = logb[t] + np.log(np.maximum(np.exp(prev) @ np.exp(logA), 1e-300))

post = np.zeros((T, K))
for t in range(T):
    s = max(0, t - 30)
    seg = alpha[s:t + 1]
    seg = seg - seg.max(axis=1, keepdims=True)
    w = np.exp(seg).sum(axis=0)
    post[t] = w / max(w.sum(), 1e-12)

daily = pd.DataFrame({
    "time": times,
    "p_range": post[:, 0],
    "p_comp": post[:, 1],
    "p_trend": post[:, 2],
    "p_vol": post[:, 3],
    "p_sq": post[:, 4],
    "sma_disp": sma_disp[start:],
})
daily["regime"] = daily[["p_range", "p_comp", "p_trend", "p_vol", "p_sq"]].idxmax(axis=1)

print("\n=== MONTHLY REGIME DISTRIBUTION ===")
monthly = daily.groupby(daily["time"].dt.to_period("M"))["regime"].value_counts(normalize=True).unstack().fillna(0)
for m, row in monthly.iterrows():
    parts = "  ".join(f"{k}: {v * 100:4.0f}%" for k, v in row.items() if v > 0.03)
    print(f"  {m}: {parts}")

print("\n=== KEY EVENT CHECKS ===")
jul = daily[(daily["time"] >= "2026-07-01") & (daily["time"] < "2026-08-01")]
if len(jul):
    top = jul["regime"].value_counts().idxmax()
    pct = jul["regime"].value_counts().max() / len(jul) * 100
    ok = top in ("p_range", "p_comp")
    print(f"  Jul 2026 (flat chop):     dominant={top} ({pct:.0f}%)  {'PASS' if ok else 'FAIL'}")

early_aug = daily[(daily["time"] >= "2026-08-01") & (daily["time"] < "2026-08-17")]
if len(early_aug):
    top = early_aug["regime"].value_counts().idxmax()
    pct = early_aug["regime"].value_counts().max() / len(early_aug) * 100
    ok = top in ("p_range", "p_comp")
    print(f"  Aug 1-16 (real range):   dominant={top} ({pct:.0f}%)  {'PASS' if ok else 'FAIL'}")

rally = daily[daily["time"] >= "2026-08-17"]
if len(rally):
    top = rally["regime"].value_counts().idxmax()
    pct = rally["regime"].value_counts().max() / len(rally) * 100
    print(f"  Aug 17-22 (RALLY):       dominant={top} ({pct:.0f}%)  {'PASS' if top == 'p_trend' else 'FAIL'}")
    # strongest 3 days of the rally
    core = rally[rally["time"] >= "2026-08-19"]
    if len(core):
        top2 = core["regime"].value_counts().idxmax()
        pct2 = core["regime"].value_counts().max() / len(core) * 100
        print(f"  Aug 19-22 (parabolic):   dominant={top2} ({pct2:.0f}%)  {'PASS' if top2 == 'p_trend' else 'FAIL'}")

print("\n=== STABILITY ===")
daily["flips"] = (daily["regime"] != daily["regime"].shift(1)).astype(int)
flips = daily.groupby(daily["time"].dt.date)["flips"].sum().mean()
print(f"  Avg regime flips per day: {flips:.1f} (lower = more stable)")
