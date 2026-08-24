"""Sweep RANGE Z threshold to find break-even."""
import sys
import numpy as np

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
thresholds = [0.80, 0.90, 1.00, 1.10, 1.20, 1.30, 1.50, 1.75, 2.00]

orig = bt.REGIME_PARAMS["RANGE"]["z_threshold"]
print(f"{symbol} — RANGE Z threshold sweep (2yr, real gates):")
print(f"{'Z_thr':>6} | {'Trades':>6} | {'WR%':>5} | {'PF':>5} | {'NetPnL':>8} | {'MaxDD%':>6}")
print("-" * 60)
for t in thresholds:
    bt.REGIME_PARAMS["RANGE"]["z_threshold"] = t
    trades, equity, peak, _ = bt.run_symbol(symbol)
    if not trades:
        print(f"{t:6.2f} |      0 |   - |    - |      $0 |      -")
        continue
    wins = [x for x in trades if x["pnl"] > 0]
    wr = len(wins) / len(trades) * 100
    gw = sum(x["pnl"] for x in wins)
    gl = abs(sum(x["pnl"] for x in trades if x["pnl"] <= 0))
    pf = gw / max(gl, 1e-9)
    pnl = sum(x["pnl"] for x in trades)
    dd = (peak - equity) / peak * 100
    print(f"{t:6.2f} | {len(trades):6d} | {wr:5.1f} | {pf:5.2f} | ${pnl:7.2f} | {dd:6.1f}")
bt.REGIME_PARAMS["RANGE"]["z_threshold"] = orig