"""
bot/sensitivity_analysis.py
===========================
Runs the backtest across a parameter grid for REGIME_PARAMS thresholds.
Produces a CSV of (param, value, win_rate, net_pnl, total_trades) for analysis.

Usage:
    python -m bot.sensitivity_analysis

Output: bot/sensitivity_results.csv
"""

import csv
import copy
from bot.backtest_hybrid import fetch_binance_candles, backtest_hybrid, CONFIG
from bot.signal_config import REGIME_PARAMS

SWEEP = {
    "RANGE.z_threshold":       [0.80, 0.90, 1.06, 1.20, 1.40],
    "RANGE.atr_multiplier_sl": [0.90, 1.00, 1.14, 1.30, 1.50],
    "TREND.z_threshold":       [1.50, 1.75, 2.00, 2.25, 2.50],
    "TREND.min_confidence":    [0.60, 0.62, 0.65, 0.68, 0.70],
    "NEUTRAL.z_threshold":     [1.20, 1.35, 1.50, 1.65, 1.80],
}

def run():
    print("Fetching data...")
    df = fetch_binance_candles("BTCUSDT", interval="15m", years_back=1)
    if df.empty:
        print("No data. Aborting.")
        return

    baseline_cfg = copy.deepcopy(CONFIG)
    rows = []
    total = sum(len(v) for v in SWEEP.values())
    done = 0

    for param_key, values in SWEEP.items():
        regime, key = param_key.split(".")
        for val in values:
            test_cfg = copy.deepcopy(CONFIG)
            test_cfg[f"regime_{regime}_{key}"] = val
            trades, final_bal = backtest_hybrid(df, test_cfg, "BTCUSDT")
            if not trades:
                done += 1
                continue
            wins = sum(1 for t in trades if t['pnl'] > 0)
            net  = sum(t['pnl'] for t in trades)
            rows.append({
                "param": param_key, "value": val,
                "win_rate": round(wins / len(trades) * 100, 1),
                "net_pnl":  round(net, 2),
                "trades":   len(trades),
                "final_bal": round(final_bal, 2),
            })
            done += 1
            print(f"  [{done}/{total}] {param_key}={val}: trades={len(trades)} wr={rows[-1]['win_rate']}% net=${net:.2f}")

    with open("bot/sensitivity_results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["param","value","win_rate","net_pnl","trades","final_bal"])
        writer.writeheader()
        writer.writerows(rows)
    print("\nResults saved to bot/sensitivity_results.csv")

if __name__ == "__main__":
    run()
