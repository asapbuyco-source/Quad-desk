"""Diagnose which trade subsets have positive EV in the backtest."""
import sys
from collections import defaultdict

sys.path.insert(0, ".")
from backtest_strategy import run_symbol

symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
trades, equity, peak, curve = run_symbol(symbol)

print(f"\n===== {symbol} — TRADE DIAGNOSTICS ({len(trades)} trades) =====")

def ev_stats(subset, label):
    if not subset:
        return
    wins = [t for t in subset if t["pnl"] > 0]
    losses = [t for t in subset if t["pnl"] <= 0]
    wr = len(wins) / len(subset) * 100
    gw = sum(t["pnl"] for t in wins)
    gl = abs(sum(t["pnl"] for t in losses))
    pf = gw / max(gl, 1e-9)
    ev = sum(t["pnl"] for t in subset) / len(subset)
    print(f"  {label:28s}: n={len(subset):5d}  WR={wr:5.1f}%  PF={pf:5.2f}  EV=${ev:+.3f}/trade")

ev_stats(trades, "ALL")
ev_stats([t for t in trades if t["side"] == "LONG"], "LONG")
ev_stats([t for t in trades if t["side"] == "SHORT"], "SHORT")
for reason in ["SL", "TP", "TIME"]:
    ev_stats([t for t in trades if t["reason"] == reason], f"Exit={reason}")

half = len(trades) // 2
ev_stats(trades[:half], "First half")
ev_stats(trades[half:], "Second half")
ev_stats(trades[:100], "First 100")
ev_stats(trades[100:], "Trades 101+")

# By entry regime - which regimes traded
by_regime = defaultdict(list)
for t in trades:
    by_regime[t["entry_regime"]].append(t)
for reg, ts in by_regime.items():
    ev_stats(ts, f"Regime={reg}")

# Size distribution - did equity blow up early?
sizes = [t["size"] * t["entry"] for t in trades]
print(f"\n  Notional: p10=${sorted(sizes)[len(sizes)//10]:.0f} median=${sorted(sizes)[len(sizes)//2]:.0f} p90=${sorted(sizes)[int(len(sizes)*0.9)]:.0f}")
print(f"  Equity start=$350 end=${equity:.2f}")
print(f"  Max DD: {(peak-equity)/peak*100:.1f}%")

# Per-trade pnl distribution
pnls = sorted(t["pnl"] for t in trades)
print(f"  PnL: p10=${pnls[len(pnls)//10]:+.2f} median=${pnls[len(pnls)//2]:+.2f} p90=${pnls[int(len(pnls)*0.9)]:+.2f}")