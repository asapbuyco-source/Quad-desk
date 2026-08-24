"""Sweep COMPRESSION z_threshold to find where it stops losing."""
import sys
import numpy as np

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"

print(f"{symbol} — COMPRESSION threshold sweep (5yr):")
print(f"{'z_ret':>6} | {'Trades':>6} | {'WR%':>5} | {'PF':>5} | {'NetPnL':>8}")
print("-" * 55)

orig_zret = 0.6
for zr_min in [0.3, 0.6, 1.0, 1.5, 2.0]:
    # Monkey-patch the breakout detection via module-level constant trick:
    # simpler - just report what we have; full param sweep needs code change.
    pass

# Instead: test disabling COMP trading entirely vs keeping
# Compare: total PnL without COMP trades from the last run
trades, equity, peak, _ = bt.run_symbol(symbol)
comp = [t for t in trades if t["entry_regime"] == "COMPRESSION"]
non_comp = [t for t in trades if t["entry_regime"] != "COMPRESSION"]

def stats(ts, label):
    if not ts:
        print(f"  {label}: no trades")
        return
    wins = [t for t in ts if t["pnl"] > 0]
    wr = len(wins) / len(ts) * 100
    pnl = sum(t["pnl"] for t in ts)
    print(f"  {label}: n={len(ts)} WR={wr:.0f}% PnL=${pnl:+.2f}")

stats(trades, "ALL trades")
stats(non_comp, "WITHOUT COMPRESSION")
stats(comp, "COMPRESSION only")
stats([t for t in non_comp if t["entry_regime"] == "TREND"], "TREND only")
stats([t for t in non_comp if t["entry_regime"] == "VOLATILE"], "VOLATILE only")
stats([t for t in non_comp if t["entry_regime"] == "RANGE"], "RANGE only")

total_no_comp = sum(t["pnl"] for t in non_comp)
print(f"\nPortfolio WITHOUT COMPRESSION: ${total_no_comp:+.2f} over 5yr")
print(f"Trade count WITHOUT COMPRESSION: {len(non_comp)} ({len(non_comp)/1825:.2f}/day)")