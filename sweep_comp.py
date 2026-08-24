"""Sweep COMPRESSION parameters: breakout z_ret + disable MR fallback test."""
import sys
import numpy as np

sys.path.insert(0, ".")
import backtest_strategy as bt

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"

def stats(trades, label):
    if not trades:
        print(f"  {label:34s}: no trades")
        return
    wins = [t for t in trades if t["pnl"] > 0]
    wr = len(wins) / len(trades) * 100
    gw = sum(t["pnl"] for t in wins)
    gl = abs(sum(t["pnl"] for t in trades if t["pnl"] <= 0))
    pf = gw / max(gl, 1e-9)
    pnl = sum(t["pnl"] for t in trades)
    print(f"  {label:34s}: n={len(trades):5d} WR={wr:4.0f}% PF={pf:4.2f} PnL=${pnl:+8.2f}")

print(f"{symbol} — COMPRESSION parameter sweep (5yr):")
print(f"{'zret_min':>8} | {'config':>10} | results")
print("-" * 75)

orig_zret = bt.COMP_ZRET_MIN
results = []
for zr_min in [0.6, 0.8, 1.0, 1.2, 1.5, 999]:
    label = "DISABLED" if zr_min == 999 else f"zret>={zr_min}"
    bt.COMP_ZRET_MIN = zr_min
    trades, equity, peak, _ = bt.run_symbol(symbol)

    comp_trades = [t for t in trades if t["entry_regime"] == "COMPRESSION"]
    other = [t for t in trades if t["entry_regime"] != "COMPRESSION"]
    total_pnl = sum(t["pnl"] for t in trades)
    comp_pnl = sum(t["pnl"] for t in comp_trades)
    wins = [t for t in comp_trades if t["pnl"] > 0]
    cwr = len(wins) / max(len(comp_trades), 1) * 100

    print(f"{label:>8} | {'':10s} | total n={len(trades):5d} PnL=${total_pnl:+8.2f} | "
          f"COMP: n={len(comp_trades):5d} WR={cwr:3.0f}% PnL=${comp_pnl:+7.2f}")
    results.append((zr_min, len(trades), total_pnl, len(comp_trades), comp_pnl))

bt.COMP_ZRET_MIN = orig_zret
best = max(results, key=lambda x: x[2])
print(f"\nBEST config: zret_min={best[0]} -> total PnL ${best[2]:+.2f} ({best[1]} trades)")