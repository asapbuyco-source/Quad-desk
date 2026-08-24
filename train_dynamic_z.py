"""Train the Dynamic Z Engine from backtest data.

Runs the backtest at a low threshold to collect ALL candidate trades with
their entry Z, feeds them to dynamic_z_engine.seed_from_history(), and lets
the engine's mean-variance optimizer find the optimal Z per regime.

The trained thresholds are then usable by the live bot immediately.
"""
import sys

sys.path.insert(0, ".")
import backtest_strategy as bt

from bot.dynamic_z_engine import dynamic_z_engine

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


def train():
    orig = bt.REGIME_PARAMS["RANGE"]["z_threshold"]
    bt.REGIME_PARAMS["RANGE"]["z_threshold"] = 1.65  # collect trades at the proven-profitable floor

    all_seeds = []
    for sym in SYMBOLS:
        trades, _, _, _ = bt.run_symbol(sym)
        for t in trades:
            z = t.get("entry_z", 0.0)
            all_seeds.append((t["entry_regime"], z, t["pnl"]))
        print(f"{sym}: {len(trades)} trades collected")

    bt.REGIME_PARAMS["RANGE"]["z_threshold"] = orig

    print(f"\nSeeding Dynamic Z Engine with {len(all_seeds)} trades...")
    dynamic_z_engine.seed_from_history(all_seeds)

    print("\nTrained thresholds (get_threshold vs static defaults):")
    for regime in ["RANGE", "NEUTRAL", "COMPRESSION", "TREND", "VOLATILE", "SQUEEZE"]:
        static = bt.REGIME_PARAMS.get(regime, {}).get("z_threshold", 1.0)
        learned = dynamic_z_engine.get_threshold(regime, static)
        print(f"  {regime:12s}: static={static:.2f} -> trained={learned:.2f}")


if __name__ == "__main__":
    train()