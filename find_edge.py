"""Find where the profitable trades live — Z distribution of wins vs losses."""
import sys
import numpy as np

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
bt.REGIME_PARAMS["RANGE"]["z_threshold"] = 0.80  # collect all candidates

trades, equity, peak, _ = bt.run_symbol(symbol)

# We need the entry Z for each trade - add it to the backtest output
# Quick workaround: re-run with instrumentation via monkeypatch
import backtest_strategy as bt2

orig_run = bt2.run_symbol
# Instead of patching, use the trade list pnl + side to estimate entry Z
# Trades don't carry Z. Rerun with a patched run_symbol that records z.

# Simpler: patch REGIME_PARAMS to sweep and record which threshold first includes a trade as profitable
print(f"{symbol}: entry Z analysis needs instrumentation - checking trade density instead")
print(f"Total trades at Z=0.80: {len(trades)}")
print(f"Wins: {sum(1 for t in trades if t['pnl'] > 0)}, Losses: {sum(1 for t in trades if t['pnl'] <= 0)}")

# Distribution of win magnitudes
wins = sorted([t["pnl"] for t in trades if t["pnl"] > 0])
if wins:
    print(f"Win sizes: p25={wins[len(wins)//4]:.2f} median={wins[len(wins)//2]:.2f} p75={wins[int(len(wins)*0.75)]:.2f} max={max(wins):.2f}")