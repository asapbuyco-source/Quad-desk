"""Fine sweep + exhaustion filter impact at high Z."""
import sys
import numpy as np

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"

print(f"{symbol} — fine Z sweep + exhaustion filter impact:")
print(f"{'Z_thr':>6} | {'gates':>5} | {'Trades':>6} | {'WR%':>5} | {'PF':>5} | {'NetPnL':>8} | {'MaxDD%':>6}")
print("-" * 70)

orig_thr = bt.REGIME_PARAMS["RANGE"]["z_threshold"]
# Back up exhaustion logic reference: it's inline in run_symbol, so we
# emulate "relaxed exhaustion" by testing with higher threshold only.
for t in [1.50, 1.55, 1.60, 1.65, 1.70, 1.75, 1.80]:
    bt.REGIME_PARAMS["RANGE"]["z_threshold"] = t
    trades, equity, peak, _ = bt.run_symbol(symbol)
    if not trades:
        print(f"{t:6.2f} |      |      0 |   - |    - |      $0 |      -")
        continue
    wins = [x for x in trades if x["pnl"] > 0]
    wr = len(wins) / len(trades) * 100
    gw = sum(x["pnl"] for x in wins)
    gl = abs(sum(x["pnl"] for x in trades if x["pnl"] <= 0))
    pf = gw / max(gl, 1e-9)
    pnl = sum(x["pnl"] for x in trades)
    dd = (peak - equity) / peak * 100
    print(f"{t:6.2f} | full | {len(trades):6d} | {wr:5.1f} | {pf:5.2f} | ${pnl:7.2f} | {dd:6.1f}")

bt.REGIME_PARAMS["RANGE"]["z_threshold"] = orig_thr
print(f"\n(orig threshold restored: {orig_thr})")