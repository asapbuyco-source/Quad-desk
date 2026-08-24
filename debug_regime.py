"""Debug regime distribution in the backtest loop."""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, ".")
from backtest_strategy import load_params, posterior, LABELS

df = pd.read_pickle("data/BTCUSDT_15m_cached.pkl")
mu, sigma, A, pi = load_params()

# Quick feature build (subset needed for HMM)
close = df["close"].values.astype(float)
high = df["high"].values.astype(float)
low = df["low"].values.astype(float)
volume = df["volume"].values.astype(float)

import backtest_strategy as bt
atr_rank = np.full(len(close), 0.5)
# cheap atr
tr = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
atr = np.zeros(len(close))
if len(tr) >= 14:
    atr[14] = tr[:14].mean()
    for i in range(15, len(close)):
        atr[i] = (atr[i-1] * 13 + tr[i-1]) / 14
atr_pct = np.where(close > 0, atr / close, 0.0) / 1.0
for i in range(50, len(atr_pct), 96):
    w = atr_pct[max(0, i - 2880):i]
    if len(w):
        atr_rank[i] = np.mean(w <= atr_pct[i])
atr_rank = pd.Series(atr_rank).ffill().fillna(0.5).values

zscore = bt.session_vwap_z(close, high, low, volume, atr_rank)

start = 200
n_bars = len(close) - start
# Sample every bar for the last year only (speed)
year_start = len(df[df.index < "2026-08-01"]) - start
regimes = {"RANGE": 0, "COMPRESSION": 0, "TREND": 0, "VOLATILE": 0, "SQUEEZE": 0}
rally_regimes = {"RANGE": 0, "COMPRESSION": 0, "TREND": 0, "VOLATILE": 0, "SQUEEZE": 0}

committed = "RANGE"
streak = 0
commit_hist = []
for i in range(year_start, n_bars):
    idx = start + i
    post = posterior(X=None, i=i, pi=pi, A=A, mu=mu, sigma=sigma, win=32) if False else None
    # Need X - rebuild minimal
    break

print("Need full X rebuild - using validate approach instead")

# Simpler: use validate_hmm-style forward pass over last year
import json
params = json.load(open("bot/hmm_params.json", encoding="utf-8"))
mu2 = np.array(params["mu"], dtype=float)
sigma2 = np.array(params["sigma"], dtype=float)
A2 = np.array(params["transmat"], dtype=float)
pi2 = np.array(params.get("pi", [0.5]*5), dtype=float)

from bot.hmm_calibrate import _calc_zret, ATR_SCALE
z_ret = _calc_zret(close, 20)
vol_sma = pd.Series(volume).rolling(60, min_periods=1).mean().fillna(0).values
tape_bin = np.where(volume > vol_sma * 3.0, 1.0, 0.0)
sma100 = pd.Series(close).rolling(100, min_periods=20).mean().fillna(pd.Series(close)).values
sma_disp = np.clip(np.where(sma100 > 0, (close - sma100) / sma100, 0.0), -0.30, 0.30)
abs_z = np.abs(zscore)
funding = df["funding_rate"].values.astype(float)

X_all = np.column_stack([
    np.clip(atr_pct[start:], 0.0, 0.03),
    np.clip(abs_z[start:], 0.0, 4.0),
    tape_bin[start:],
    np.clip(atr_rank[start:], 0.0, 1.0),
    np.clip(abs_zr := np.abs(z_ret)[start:], 0.0, 4.0),
    np.clip(funding[start:] * 1000, -2.0, 2.0),
    sma_disp[start:],
])

times = df.index[start:]
aug_mask = times >= "2026-08-01"
rally_mask = times >= "2026-08-17"

counts_aug = {}
counts_rally = {}
for i in range(len(X_all)):
    if not aug_mask[i]:
        continue
    post = posterior(X_all, i, pi2, A2, mu2, sigma2, win=32)
    lab = LABELS[int(np.argmax(post))]
    counts_aug[lab] = counts_aug.get(lab, 0) + 1
    if rally_mask[i]:
        counts_rally[lab] = counts_rally.get(lab, 0) + 1

total_aug = sum(counts_aug.values())
total_rally = sum(counts_rally.values())
print(f"Aug 2026 raw labels ({total_aug} bars):")
for k, v in sorted(counts_aug.items(), key=lambda x: -x[1]):
    print(f"  {k}: {v} ({v/total_aug*100:.0f}%)")
print(f"Aug 17+ rally raw labels ({total_rally} bars):")
for k, v in sorted(counts_rally.items(), key=lambda x: -x[1]):
    print(f"  {k}: {v} ({v/total_rally*100:.0f}%)")