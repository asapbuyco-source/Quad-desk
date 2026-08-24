"""Diagnose VOLATILE trades — direction, timing, and what would fix them."""
import sys
from collections import defaultdict

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
bt.COMP_ZRET_MIN = 999  # disable COMP to isolate VOLATILE

trades, equity, peak, _ = bt.run_symbol(symbol)
vol = [t for t in trades if t["entry_regime"] == "VOLATILE"]

print(f"{symbol} — VOLATILE diagnostics ({len(vol)} trades):")
if not vol:
    print("  No VOLATILE trades")
    sys.exit()

def stats(ts, label):
    if not ts:
        print(f"  {label:30s}: no trades")
        return
    wins = [t for t in ts if t["pnl"] > 0]
    wr = len(wins) / len(ts) * 100
    pnl = sum(t["pnl"] for t in ts)
    print(f"  {label:30s}: n={len(ts):4d} WR={wr:3.0f}% PnL=${pnl:+7.2f}")

stats(vol, "ALL VOLATILE")
stats([t for t in vol if t["side"] == "LONG"], "LONG")
stats([t for t in vol if t["side"] == "SHORT"], "SHORT")

# By exit reason
for r in ["SL", "TP", "TIME"]:
    stats([t for t in vol if t["reason"] == r], f"Exit={r}")

# By year
from collections import defaultdict
import pandas as pd
by_year = defaultdict(list)
# entry index isn't a timestamp; approximate year by position in the series
n = len(trades)
for i, t in enumerate(vol):
    # rough year bucketing by trade sequence
    pass

print("\nNote: VOLATILE uses momentum routing - LONG needs z_ret>0.3 with score>=1.5")
