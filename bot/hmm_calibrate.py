"""
bot/hmm_calibrate.py
====================
Calibrates HMM emission parameters from historical data using hmmlearn's
GaussianHMM (Baum-Welch EM algorithm — respects temporal structure).

Usage:
    python -m bot.hmm_calibrate --symbol BTCUSDT --interval 15m --years 1

Output:
    Prints _MU and _SIGMA arrays to paste into _HMMRegimeClassifier in main.py.
    Also saves to bot/hmm_params.json for programmatic loading.
"""

import argparse
import json
import os
from datetime import datetime, timezone
import numpy as np

def _load_cached_candles(symbol: str, interval: str):
    path = os.path.join("data", f"{symbol.upper()}_{interval}_cached.pkl")
    if not os.path.exists(path):
        return None, path
    import pandas as pd
    df = pd.read_pickle(path)
    if not isinstance(df, pd.DataFrame) or df.empty:
        return None, path
    required = {"open", "high", "low", "close", "volume"}
    if not required.issubset(set(df.columns)):
        raise ValueError(f"Cached file {path} missing required columns: {sorted(required - set(df.columns))}")
    return df.copy(), path


def run_calibration(symbol: str = "BTCUSDT", interval: str = "15m", years_back: int = 1,
                    use_cache: bool = True):
    try:
        from hmmlearn import hmm as hmmlearn_hmm
    except ImportError:
        print("ERROR: hmmlearn not installed. Run: pip install hmmlearn")
        return

    from bot.backtest_hybrid import fetch_binance_candles, calc_atr, calc_vwap_zscore
    import pandas as pd

    source = "binance_rest"
    cache_path = None
    df = None
    if use_cache:
        df, cache_path = _load_cached_candles(symbol, interval)
        if df is not None:
            source = cache_path
            print(f"Loaded cached {symbol} {interval} data from {cache_path} ({len(df)} rows).")
    if df is None:
        print(f"Fetching {symbol} {interval} data ({years_back} years)...")
        df = fetch_binance_candles(symbol, interval=interval, years_back=years_back)
    if df.empty:
        print("No data fetched. Aborting.")
        return

    close = df['close'].values
    high  = df['high'].values
    low   = df['low'].values
    vol   = df['volume'].values

    atr = calc_atr(high, low, close, period=14)
    atr_pct = np.where(close > 0, atr / close, 0.0)
    zscore  = calc_vwap_zscore(df, period=20)
    abs_z   = np.abs(zscore)

    vol_sma = pd.Series(vol).shift(1).rolling(60, min_periods=1).mean().fillna(0).values
    tape_bin = np.where(vol > vol_sma * 3.0, 1.0, 0.0)

    atr_rank = np.zeros(len(close))
    window = 2880  # 30 days of 15m bars
    for i in range(50, len(close)):
        w = atr_pct[max(0, i - window):i]
        if len(w) > 0:
            atr_rank[i] = np.mean(w <= atr_pct[i])

    start = 50
    X = np.column_stack([
        np.clip(atr_pct[start:], 0.0, 0.03),
        np.clip(abs_z[start:],   0.0, 4.0),
        tape_bin[start:],
        np.clip(atr_rank[start:],0.0, 1.0),
    ])

    valid = np.all(np.isfinite(X), axis=1)
    X = X[valid]
    lengths = [len(X)]

    print(f"Fitting GaussianHMM on {len(X)} observations (3 states, covariance=diag)...")
    model = hmmlearn_hmm.GaussianHMM(
        n_components=3,
        covariance_type="diag",
        n_iter=200,
        tol=1e-4,
        random_state=42,
        verbose=False,
    )
    model.fit(X, lengths)

    order = np.argsort(model.means_[:, 0])
    labels = ["RANGE", "TREND", "VOLATILE"]

    mu_ordered    = model.means_[order].astype(float)
    covars_diag = model.covars_[order]  # shape: (3, 4, 4)
    n_f = covars_diag.shape[1]
    sigma_ordered = np.sqrt(covars_diag[:, range(n_f), range(n_f)]).astype(float)
    if (not np.all(np.isfinite(mu_ordered)) or
            not np.all(np.isfinite(sigma_ordered)) or
            np.any(sigma_ordered <= 0) or
            np.any(sigma_ordered[:, 0] > 0.05) or
            np.any(sigma_ordered[:, 1] > 5.0) or
            np.any(sigma_ordered[:, 2:] > 2.0)):
        raise RuntimeError(
            "Degenerate HMM calibration detected; refusing to overwrite bot/hmm_params.json. "
            "Use a longer data window (>=6 months), review features, or adjust n_components."
        )

    print("\n--- Calibrated parameters ---")
    print("_MU = np.array([")
    for i, label in enumerate(labels):
        vals = ", ".join(f"{v:.6f}" for v in mu_ordered[i])
        print(f"    [{vals}],  # {label}")
    print("], dtype=float)")

    print("\n_SIGMA = np.array([")
    for i, label in enumerate(labels):
        vals = ", ".join(f"{v:.6f}" for v in sigma_ordered[i])
        print(f"    [{vals}],  # {label}")
    print("], dtype=float)")

    print("\nTransition matrix:")
    print(np.array2string(model.transmat_[order][:, order], precision=4))

    start_ts = str(df.index.min()) if hasattr(df, "index") and len(df.index) else None
    end_ts = str(df.index.max()) if hasattr(df, "index") and len(df.index) else None
    output = {
        "mu":    mu_ordered.tolist(),
        "sigma": sigma_ordered.tolist(),
        "transmat": model.transmat_[order][:, order].tolist(),
        "labels": labels,
        "meta": {
            "symbol": symbol.upper(),
            "interval": interval,
            "years_back": years_back,
            "source": source,
            "observations": int(len(X)),
            "rows": int(len(df)),
            "start": start_ts,
            "end": end_ts,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    with open("bot/hmm_params.json", "w") as f:
        json.dump(output, f, indent=2)
    print("\nSaved to bot/hmm_params.json")
    report_path = f"bot/hmm_calibration_report_{symbol.upper()}_{interval}.txt"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("HMM CALIBRATION REPORT\n")
        f.write(f"Generated: {output['meta']['generated_at']}\n")
        f.write(f"Symbol: {symbol.upper()}\n")
        f.write(f"Interval: {interval}\n")
        f.write(f"Source: {source}\n")
        f.write(f"Rows: {len(df)}\n")
        f.write(f"Observations: {len(X)}\n")
        f.write(f"Start: {start_ts}\n")
        f.write(f"End: {end_ts}\n\n")
        f.write("Labels:\n")
        for label in labels:
            f.write(f"- {label}\n")
        f.write("\nMu:\n")
        f.write(np.array2string(mu_ordered, precision=6))
        f.write("\n\nSigma:\n")
        f.write(np.array2string(sigma_ordered, precision=6))
        f.write("\n\nTransition Matrix:\n")
        f.write(np.array2string(model.transmat_[order][:, order], precision=6))
        f.write("\n\nReadiness Note:\n")
        f.write("Use >=6 months of symbol-specific 15m data before mainnet sizing decisions.\n")
    print(f"Saved report to {report_path}")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol",   default="BTCUSDT")
    parser.add_argument("--interval", default="15m")
    parser.add_argument("--years",    type=int, default=1)
    parser.add_argument("--no-cache", action="store_true", help="Fetch from Binance instead of using data/*_cached.pkl")
    args = parser.parse_args()
    run_calibration(args.symbol, args.interval, args.years, use_cache=not args.no_cache)
