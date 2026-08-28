"""Strategy backtest v2 - replays 2 years of 15m data through the bot's signal path.

v2 adds the live gates that v1 missed:
  - MOMENTUM_REJECT (z_ret > 0.5 blocks short, < -0.5 blocks long)
  - Bayesian confidence floor (proxy from RSI/OFI/Z/CVD alignment)
  - OFI computed from taker_buy (tanh-normalized like live)
  - CVD divergence veto (simplified: strong opposing flow blocks)
  - Fee geometry check (TP must clear round-trip fees)
  - Post-trade cooldown (cascade after losses, short after wins)
  - Cold-start lockout (first bars)

Still simplified: no ULIS verdict, no OI risk penalty, no dynamic Z engine,
no ghost walls, no liquidity sweeps.
"""
import json
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, ".")
from bot.hmm_calibrate import _calc_atr, _calc_zret, _calc_atr_rank, ATR_SCALE
from bot.signal_config import REGIME_PARAMS

MAKER_FEE = 0.0002
TAKER_FEE = 0.0005
START_EQUITY = 350.0
RISK_PER_TRADE = 0.01
BAR_SECS = 900
LABELS = ["RANGE", "COMPRESSION", "TREND", "VOLATILE", "SQUEEZE"]
Z_SCALE_BASE = {"RANGE": 0.96, "NEUTRAL": 0.97, "COMPRESSION": 0.98,
                "TREND": 0.84, "VOLATILE": 0.78, "SQUEEZE": 0.82, "LIQUIDITY": 0.97}
# COMP breakout parameters - tunable for sweeps
COMP_ZRET_MIN = 0.6
COMP_Z_MIN = None  # if set, overrides regime thr for COMP entries
COMP_NO_TRADE = True  # align with live: COMPRESSION disabled (backtest proved -EV)
VOL_NO_TRADE = False  # sweep flag: disable VOLATILE entirely
RANGE_NO_TRADE = False  # sweep flag: disable RANGE entirely
COMMIT_MODE = "majority"  # "majority" (8-bar vote) | "trend_prefer" (TREND if seen in window)
Z_THR_OVERRIDE = {}  # {"RANGE": 1.9} style overrides for sweeps
TREND_MIN_CONF = 0.65  # min_confidence override for TREND sweeps


def load_params():
    p = json.load(open("bot/hmm_params.json", encoding="utf-8"))
    return (np.array(p["mu"], dtype=float), np.array(p["sigma"], dtype=float),
            np.array(p["transmat"], dtype=float),
            np.array(p.get("pi", [0.5, 0.2, 0.15, 0.1, 0.05]), dtype=float))


def posterior(X, i, pi, A, mu, sigma, win=32):
    s = max(0, i - win)
    seg = X[s:i + 1]
    T, K = len(seg), len(mu)
    logA = np.log(np.maximum(A, 1e-300))
    logpi = np.log(np.maximum(pi, 1e-300))
    logb = np.zeros((T, K))
    for k in range(K):
        diff = seg - mu[k]
        logb[:, k] = -0.5 * np.sum(diff * diff / np.maximum(sigma[k] ** 2, 1e-12), axis=1)
    alpha = np.zeros((T, K))
    alpha[0] = logpi + logb[0]
    for t in range(1, T):
        prev = alpha[t - 1] - alpha[t - 1].max()
        alpha[t] = logb[t] + np.log(np.maximum(np.exp(prev) @ np.exp(logA), 1e-300))
    last = alpha[-1] - alpha[-1].max()
    post = np.exp(last)
    return post / post.sum()


def session_vwap_z(close, high, low, volume, atr_pct_rank):
    n = len(close)
    z = np.zeros(n)
    WINDOW_BARS = 96
    for i in range(50, n):
        s = max(0, i - WINDOW_BARS)
        tp = (high[s:i + 1] + low[s:i + 1] + close[s:i + 1]) / 3.0
        v = volume[s:i + 1]
        vwap = np.sum(tp * v) / max(np.sum(v), 1e-9)
        n_sig = max(10, min(25, int((1.0 - atr_pct_rank[i]) * 40 + 10)))
        lo = max(0, i - n_sig)
        h = high[lo:i]
        l = low[lo:i]
        c = close[lo:i]
        vv = volume[lo:i]
        if len(h) < 5 or np.sum(vv) <= 0:
            continue
        tp_w = (h + l + c) / 3.0
        vw_var = np.sum(vv * (tp_w - vwap) ** 2) / np.sum(vv)
        std = np.sqrt(vw_var)
        min_std = close[i] * 0.00005
        std = np.sqrt(std * std + min_std * min_std)
        z[i] = (close[i] - vwap) / std
    return np.clip(z, -4.0, 4.0)


def bayesian_pbull(rsi, z_score, skewness, ofi, z_ret, regime, alpha=5.0, beta=5.0):
    """Exact replica of QuantEngine._bayesian + main._bayesian_fusion."""
    n_regime = alpha + beta - 10.0
    if n_regime >= 10 and (alpha + beta) > 0:
        p_prior = alpha / (alpha + beta)
    else:
        p_prior = 0.50
    prior_odds = p_prior / (1.0 - p_prior)

    L_rsi = 1.8 if rsi > 60 else 0.55 if rsi < 40 else 1.0

    if z_score < -1.50 and ofi > 0.2:
        L_flow = 2.0
    elif z_score > 1.50 and ofi < -0.2:
        L_flow = 0.5
    else:
        L_z = 1.3 if z_score < -1.50 else 0.76 if z_score > 1.50 else 1.0
        L_o = 1.2 if ofi > 0.3 else 0.83 if ofi < -0.3 else 1.0
        L_flow = L_z * L_o

    L_skew = 1.2 if skewness > 0.3 else 0.83 if skewness < -0.3 else 1.0

    L_zvel = 1.0
    if regime == "TREND" and abs(z_ret) > 0.5:
        if z_ret > 1.5:
            L_zvel = 1.25
        elif z_ret < -1.5:
            L_zvel = 0.80
        elif z_ret > 0.5:
            L_zvel = 1.10
        else:
            L_zvel = 0.93

    posterior_odds = prior_odds * L_rsi * L_flow * L_skew * L_zvel
    return posterior_odds / (1.0 + posterior_odds)


def confidence_direction(p_bull, direction, ofi, cvd_delta):
    """_bayesian_fusion: convert P(bull) to P(direction) with flow multipliers."""
    is_long = direction == "LONG"
    p_signal = p_bull if is_long else (1.0 - p_bull)
    p_signal = max(0.01, min(0.99, p_signal))
    odds = p_signal / (1.0 - p_signal)
    flow_factor = 1.0
    if is_long:
        if ofi > 0.3:
            flow_factor *= 1.25
        elif ofi > 0.15:
            flow_factor *= 1.10
        if cvd_delta > 100:
            flow_factor *= 1.08
        elif cvd_delta < -100:
            flow_factor *= 0.90
    else:
        if ofi < -0.3:
            flow_factor *= 1.25
        elif ofi < -0.15:
            flow_factor *= 1.10
        if cvd_delta < -100:
            flow_factor *= 1.08
        elif cvd_delta > 100:
            flow_factor *= 0.90
    odds *= flow_factor
    return odds / (1.0 + odds)


def run_symbol(symbol):
    df = pd.read_pickle(f"data/{symbol}_15m_cached.pkl")
    mu, sigma, A, pi = load_params()

    close = df["close"].values.astype(float)
    high = df["high"].values.astype(float)
    low = df["low"].values.astype(float)
    volume = df["volume"].values.astype(float)
    taker_buy = df["taker_buy_base"].values.astype(float)
    funding = df["funding_rate"].values.astype(float)

    atr = _calc_atr(high, low, close, 14)
    atr_pct = np.where(close > 0, atr / close, 0.0) / ATR_SCALE[symbol]
    atr_rank = _calc_atr_rank(atr_pct, 2880)
    zscore = session_vwap_z(close, high, low, volume, atr_rank)
    z_ret = _calc_zret(close, 20)
    vol_sma = pd.Series(volume).rolling(60, min_periods=1).mean().fillna(0).values
    tape_bin = np.where(volume > vol_sma * 3.0, 1.0, 0.0)
    sma100 = pd.Series(close).rolling(100, min_periods=20).mean().fillna(pd.Series(close)).values
    sma_disp = np.clip(np.where(sma100 > 0, (close - sma100) / sma100, 0.0), -0.30, 0.30)

    # OFI: delta ratio of taker buy vs volume, tanh-normalized (live uses tanh)
    delta = 2.0 * taker_buy - volume
    ofi = np.tanh(delta / np.maximum(volume, 1e-9) * 2.0)
    cvd = np.cumsum(delta)
    cvd_delta = np.diff(cvd, prepend=cvd[0])
    cvd_delta[:50] = 0.0

    # Skewness proxy: z_ret sign asymmetry over 60 bars (live uses trade skew)
    skew = pd.Series(z_ret).rolling(60, min_periods=10).skew().fillna(0).values
    skew = np.clip(skew, -2.0, 2.0)

    rsi = np.full(len(close), 50.0)
    gains = np.zeros(len(close))
    losses = np.zeros(len(close))
    delta_c = np.diff(close, prepend=close[0])
    for i in range(1, len(close)):
        g = max(delta_c[i], 0.0)
        l = max(-delta_c[i], 0.0)
        gains[i] = (gains[i - 1] * 13 + g) / 14
        losses[i] = (losses[i - 1] * 13 + l) / 14
        rsi[i] = 100.0 - 100.0 / (1.0 + gains[i] / max(losses[i], 1e-12))

    start = 200
    X = np.column_stack([
        np.clip(atr_pct[start:], 0.0, 0.03),
        np.clip(np.abs(zscore[start:]), 0.0, 4.0),
        tape_bin[start:],
        np.clip(atr_rank[start:], 0.0, 1.0),
        np.clip(np.abs(z_ret[start:]), 0.0, 4.0),
        np.clip(funding[start:] * 1000, -2.0, 2.0),
        sma_disp[start:],
    ])

    equity = START_EQUITY
    peak = START_EQUITY
    trades = []
    equity_curve = []
    open_pos = None
    cooldown_until = 6  # cold-start lockout (90s = 6 bars)
    committed = "RANGE"
    streak = {}
    label_hist = []

    n = len(X)
    for i in range(n):
        idx = start + i
        post = posterior(X, i, pi, A, mu, sigma)
        raw = LABELS[int(np.argmax(post))]
        conf = float(post.max())
        # Smoothed commitment: majority vote over last 8 bars (mirrors runtime
        # windowed forward pass which accumulates evidence across observations).
        label_hist.append(raw)
        if len(label_hist) > 8:
            label_hist.pop(0)
        from collections import Counter
        if COMMIT_MODE == "trend_prefer":
            counts = Counter(label_hist)
            committed = "TREND" if counts.get("TREND", 0) > 0 else counts.most_common(1)[0][0]
        else:
            committed = Counter(label_hist).most_common(1)[0][0]

        if open_pos is not None:
            p = open_pos
            p["age_bars"] += 1
            hi, lo = high[idx], low[idx]
            exit_px = None
            reason = None
            if p["side"] == "LONG":
                if lo <= p["sl"]:
                    exit_px, reason = p["sl"], "SL"
                elif hi >= p["tp"]:
                    exit_px, reason = p["tp"], "TP"
                elif p["age_bars"] * BAR_SECS >= p["time_cap"]:
                    exit_px, reason = close[idx], "TIME"
            else:
                if hi >= p["sl"]:
                    exit_px, reason = p["sl"], "SL"
                elif lo <= p["tp"]:
                    exit_px, reason = p["tp"], "TP"
                elif p["age_bars"] * BAR_SECS >= p["time_cap"]:
                    exit_px, reason = close[idx], "TIME"
            if exit_px is not None:
                notional = p["size"] * p["entry"]
                pnl = (exit_px - p["entry"]) * p["size"] if p["side"] == "LONG" else (p["entry"] - exit_px) * p["size"]
                pnl -= notional * MAKER_FEE + notional * TAKER_FEE
                equity += pnl
                peak = max(peak, equity)
                p["exit"] = exit_px
                p["pnl"] = pnl
                p["reason"] = reason
                trades.append(p)
                open_pos = None
                if reason == "SL":
                    cooldown_until = i + 15
                else:
                    cooldown_until = i + 3
            equity_curve.append(equity)
            continue

        if i < cooldown_until:
            equity_curve.append(equity)
            continue

        regime = committed
        p = REGIME_PARAMS.get(regime, REGIME_PARAMS["NEUTRAL"])
        if COMP_NO_TRADE and regime == "COMPRESSION":
            equity_curve.append(equity)
            continue
        if VOL_NO_TRADE and regime == "VOLATILE":
            equity_curve.append(equity)
            continue
        if RANGE_NO_TRADE and regime == "RANGE":
            equity_curve.append(equity)
            continue
        p = dict(p)
        if regime in Z_THR_OVERRIDE:
            p["z_threshold"] = Z_THR_OVERRIDE[regime]
        thr = (p["z_threshold"] /
               max(Z_SCALE_BASE.get(regime, 1.0) + conf * (1.0 - Z_SCALE_BASE.get(regime, 1.0)) * 0.4, 0.60))
        z = zscore[idx]
        z_slope = z - zscore[idx - 1]
        r = rsi[idx]
        zr = z_ret[idx]
        ofi_now = ofi[idx]
        cvd_d = cvd_delta[idx]

        direction = None
        if regime == "COMPRESSION":
            # Mirror live: breakout detection via z_ret, else mean-reversion
            is_breakout = abs(zr) > COMP_ZRET_MIN
            z_gate = COMP_Z_MIN if COMP_Z_MIN is not None else thr
            if is_breakout:
                if zr > COMP_ZRET_MIN and z > z_gate:
                    direction = "LONG"
                elif zr < -COMP_ZRET_MIN and z < -z_gate:
                    direction = "SHORT"
            if direction is None:
                if z >= thr and r > 52:
                    direction = "SHORT"
                elif z <= -thr and r < 48:
                    direction = "LONG"
        elif regime in ("RANGE", "NEUTRAL"):
            if z >= thr and r > 52:
                direction = "SHORT"
                if zr > 0.5:
                    direction = None
            elif z <= -thr and r < 48:
                direction = "LONG"
                if zr < -0.5:
                    direction = None
            if direction:
                rp = rsi[idx - 1] if idx > 0 else r
                rp2 = rsi[idx - 2] if idx > 1 else rp
                trough = (r > rp) and (rp < rp2)
                peakk = (r < rp) and (rp > rp2)
                tol = 0.02 if regime == "NEUTRAL" else 0.0
                if direction == "LONG" and (z_slope <= tol or not trough):
                    direction = None
                if direction == "SHORT" and (z_slope >= -tol or not peakk):
                    direction = None
        elif regime in ("TREND", "VOLATILE", "SQUEEZE"):
            # Mirror live _strategy_trend scoring
            score = 0.0
            p_bull_t = bayesian_pbull(r, z, skew[idx], ofi_now, zr, regime)
            if p_bull_t > 0.65:
                score += 2.0
            elif p_bull_t > 0.55:
                score += 1.0
            elif p_bull_t < 0.35:
                score -= 2.0
            elif p_bull_t < 0.45:
                score -= 1.0
            if ofi_now > 0.3:
                score += 1.5
            elif ofi_now > 0.15:
                score += 0.75
            elif ofi_now < -0.3:
                score -= 1.5
            elif ofi_now < -0.15:
                score -= 0.75
            if cvd[idx] > 0:
                score += 1.0
            elif cvd[idx] < 0:
                score -= 1.0
            if zr > 1.5:
                score += 0.75
            elif zr > 0.8:
                score += 0.30
            elif zr < -1.5:
                score -= 0.75
            elif zr < -0.8:
                score -= 0.30
            if score >= 1.5:
                # FIX: trend entries gated by DIRECTIONAL metrics, not VWAP Z.
                # VWAP Z stays low during trends (VWAP follows price), so a Z
                # gate can never open a trend trade. sma_disp + z_ret do.
                if sma_disp[idx] > 0.02 and zr > 0.3:
                    direction = "LONG"
            elif score <= -1.5:
                if sma_disp[idx] < -0.02 and zr < -0.3:
                    direction = "SHORT"

        if direction is None:
            equity_curve.append(equity)
            continue

        # Real Bayesian fusion: P(bull) -> P(direction) with flow multipliers
        p_bull = bayesian_pbull(r, z, skew[idx], ofi_now, zr, regime)
        conf_sig = confidence_direction(p_bull, direction, ofi_now, cvd_d)
        conf_min = TREND_MIN_CONF if regime == "TREND" else p["min_confidence"]
        if conf_sig < conf_min:
            equity_curve.append(equity)
            continue

        # CVD divergence veto: strong opposing flow blocks
        if direction == "LONG" and cvd_d < -100 and ofi_now < -0.15:
            equity_curve.append(equity)
            continue
        if direction == "SHORT" and cvd_d > 100 and ofi_now > 0.15:
            equity_curve.append(equity)
            continue

        sl_mult = p["atr_multiplier_sl"]
        rr = p["rr_target"]
        sl_dist = sl_mult * atr[idx]
        entry_px = close[idx]
        side = direction
        sl = entry_px - sl_dist if side == "LONG" else entry_px + sl_dist
        tp = entry_px + sl_dist * rr if side == "LONG" else entry_px - sl_dist * rr

        # Fee geometry: TP must clear round-trip fees
        rt_fee = MAKER_FEE + TAKER_FEE
        if abs(tp - entry_px) < entry_px * rt_fee * 1.5:
            equity_curve.append(equity)
            continue

        risk_usd = equity * RISK_PER_TRADE
        size = risk_usd / max(sl_dist, 1e-9)
        notional = size * entry_px
        if notional > equity * 2.0:
            size = (equity * 2.0) / entry_px

        sub = "MR" if regime != "COMPRESSION" else ("BO" if abs(zr) > COMP_ZRET_MIN else "MR")
        open_pos = {
            "entry": entry_px, "side": side, "sl": sl, "tp": tp,
            "size": size, "age_bars": 0, "entry_regime": regime,
            "time_cap": p.get("time_exit_hard_cap_s", 86400),
            "entry_z": abs(z),
            "sub": sub,
        }
        equity -= notional * MAKER_FEE
        equity_curve.append(equity)

    if open_pos is not None:
        p = open_pos
        notional = p["size"] * p["entry"]
        pnl = (close[-1] - p["entry"]) * p["size"] if p["side"] == "LONG" else (p["entry"] - close[-1]) * p["size"]
        pnl -= notional * MAKER_FEE + notional * TAKER_FEE
        equity += pnl
        p["pnl"] = pnl
        p["reason"] = "END"
        trades.append(p)

    return trades, equity, peak, equity_curve


def report(symbol, trades, equity, peak):
    if not trades:
        print(f"\n{symbol}: NO TRADES")
        return
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in trades)
    wr = len(wins) / len(trades) * 100
    gw = sum(t["pnl"] for t in wins)
    gl = abs(sum(t["pnl"] for t in losses))
    pf = gw / max(gl, 1e-9)
    dd = (peak - equity) / peak * 100
    print(f"\n===== {symbol} =====")
    print(f"Trades: {len(trades)}  |  Win rate: {wr:.1f}%  |  Net PnL: ${total_pnl:+.2f}")
    print(f"Profit factor: {pf:.2f}  |  Max DD: {dd:.1f}%  |  Final equity: ${equity:.2f}")
    print(f"Avg win ${gw/max(len(wins),1):+.2f}  |  Avg loss ${sum(t['pnl'] for t in losses)/max(len(losses),1):+.2f}")
    by_reason = {}
    for t in trades:
        by_reason.setdefault(t["reason"], [0, 0.0])
        by_reason[t["reason"]][0] += 1
        by_reason[t["reason"]][1] += t["pnl"]
    print("Exits: " + "  ".join(f"{k}={v[0]}({v[1]:+.1f})" for k, v in sorted(by_reason.items())))
    by_regime = {}
    for t in trades:
        by_regime.setdefault(t["entry_regime"], [0, 0.0, 0])
        by_regime[t["entry_regime"]][0] += 1
        by_regime[t["entry_regime"]][1] += t["pnl"]
        by_regime[t["entry_regime"]][2] += 1 if t["pnl"] > 0 else 0
    print("By regime:")
    for reg, (cnt, pnl, w) in sorted(by_regime.items(), key=lambda x: -x[1][1]):
        print(f"  {reg:12s}: {cnt:3d} trades, PnL ${pnl:+7.2f}, WR {w/cnt*100:.0f}%")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "ALL"
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] if arg == "ALL" else [arg]
    for sym in symbols:
        try:
            trades, equity, peak, curve = run_symbol(sym)
            report(sym, trades, equity, peak)
        except Exception:
            import traceback
            traceback.print_exc()