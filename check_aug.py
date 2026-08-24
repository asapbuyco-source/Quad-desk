import pandas as pd

df = pd.read_pickle("data/BTCUSDT_15m_cached.pkl")
aug = df[(df.index >= "2026-08-01")]
print("August price path:")
daily = aug["close"].resample("1D").agg(["first", "max", "min", "last"])
for d, row in daily.iterrows():
    chg = (row["last"] / row["first"] - 1) * 100
    print(f"  {d.date()}: {row['first']:.0f} -> {row['last']:.0f} (H={row['max']:.0f} L={row['min']:.0f}) {chg:+.1f}%")

jul = df[(df.index >= "2026-07-01") & (df.index < "2026-08-01")]
print()
print(f"July range: {jul['close'].min():.0f} - {jul['close'].max():.0f}")
print(f"Aug range:  {aug['close'].min():.0f} - {aug['close'].max():.0f}")
print(f"Aug start: {aug['close'].iloc[0]:.0f}  Aug end: {aug['close'].iloc[-1]:.0f}")
