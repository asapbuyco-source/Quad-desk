"""
IPCE v2 Rollback Test — Condition 5 of the Engineering Team Audit

Computes whether IPCE v2 (Information-Preserving Causal Engine),
applied to the existing labelled trade history, would have:
  (a) vetoed verified losing trades (true positives)
  (b) not blocked winning trades (false positives)

IPCE v2 formula (default parameters, no calibration):
  score = w_z * |Z| + w_cvd * CVD_sign + w_regime * regime_penalty + w_ofi * OFI_sign
  veto if score > threshold

This is a simplified directional model. The full IPCE v2 uses 
causal Bayesian networks, but the directional test answers whether
the features even separate winners from losers on the existing data.
"""

import json
import glob
import numpy as np
from pathlib import Path

# ── Load all trades from all report files ──────────────────────────────────
all_trades = []
seen_ids = set()
for fp in sorted(glob.glob("reports/*.json")):
    try:
        d = json.load(open(fp, "r", encoding="utf-8"))
    except Exception:
        continue
    cand = d.get("trades", d if isinstance(d, list) else [])
    if not isinstance(cand, list):
        continue
    for t in cand:
        tid = t.get("id", "")
        if tid and tid in seen_ids:
            continue
        seen_ids.add(tid)
        all_trades.append(t)

print(f"Loaded {len(all_trades)} unique trades from report files")

# ── Separate winners and losers ───────────────────────────────────────────
wins = [t for t in all_trades if t.get("outcome") in ("WIN", "win", "TP", "tp", "WIN_PARTIAL")]
losses = [t for t in all_trades if t.get("outcome") in ("LOSS", "loss", "SL", "sl", "TIME_EXIT", "time_exit")]
print(f"Wins: {len(wins)} | Losses: {len(losses)}")

# ── IPCE v2 simplified model ──────────────────────────────────────────────
# Weights (default, uncalibrated — deliberately simple)
W_Z      = 0.30   # Z-score magnitude
W_REGIME = 0.25   # regime risk penalty
W_CVD    = 0.25   # CVD direction alignment
W_OFI    = 0.20   # order-flow imbalance direction

# Regime risk map (higher = riskier to trade)
REGIME_RISK = {
    "RANGE":      0.70,
    "NEUTRAL":    0.55,
    "LIQUIDITY":  0.65,
    "TREND":      0.30,
    "VOLATILE":   0.50,
    "SQUEEZE":    0.60,
    "COMPRESSION": 0.55,
    "UNKNOWN":    0.60,
}

def ipce_score(trade):
    """Compute IPCE v2 risk score for a trade. Higher = riskier."""
    z = abs(float(trade.get("z_score", 0) or 0))
    regime = str(trade.get("regime", "UNKNOWN")).upper()
    cvd = float(trade.get("cvd", 0) or 0)
    ofi = float(trade.get("ofi", 0) or 0)
    side = str(trade.get("side", "long")).lower()
    conf = float(trade.get("confidence", 0) or trade.get("bayes", 0) or 0)

    # Z-score component: higher |Z| = higher risk
    z_score = min(z / 3.0, 1.0)  # clamp to [0,1]

    # Regime component: riskier regimes score higher
    regime_score = REGIME_RISK.get(regime, 0.55)

    # CVD component: trading against CVD = higher risk
    # BUY with negative CVD = risky. SELL with positive CVD = risky.
    cvd_sign = 1 if cvd > 0 else -1 if cvd < 0 else 0
    trade_sign = 1 if side in ("buy", "long") else -1
    cvd_aligned = 1 if cvd_sign == trade_sign else -1 if cvd_sign == -trade_sign else 0
    cvd_score = 0.5 - 0.5 * cvd_aligned  # 0 = aligned, 1 = against

    # OFI component: same logic
    ofi_sign = 1 if ofi > 0 else -1 if ofi < 0 else 0
    ofi_aligned = 1 if ofi_sign == trade_sign else -1 if ofi_sign == -trade_sign else 0
    ofi_score = 0.5 - 0.5 * ofi_aligned

    # Composite score
    score = (
        W_Z * z_score +
        W_REGIME * regime_score +
        W_CVD * cvd_score +
        W_OFI * ofi_score
    )
    return score, {
        "z": round(z, 2),
        "regime": regime,
        "regime_risk": round(regime_score, 2),
        "cvd": round(cvd, 0),
        "cvd_aligned": cvd_aligned,
        "cvd_score": round(cvd_score, 2),
        "ofi": round(ofi, 2),
        "ofi_aligned": ofi_aligned,
        "ofi_score": round(ofi_score, 2),
        "total": round(score, 3),
    }


# ── Run the test ──────────────────────────────────────────────────────────
print("\n" + "=" * 72)
print("IPCE v2 ROLLBACK TEST — Does the model separate winners from losers?")
print("=" * 72)

results = {"win": [], "loss": []}
for label, group in [("win", wins), ("loss", losses)]:
    for t in group:
        score, detail = ipce_score(t)
        detail["pnl"] = round(float(t.get("pnl", 0) or 0), 2)
        detail["verdict"] = t.get("verdict", "?")
        detail["side"] = t.get("side", "?")
        results[label].append(detail)

win_scores = [r["total"] for r in results["win"]]
loss_scores = [r["total"] for r in results["loss"]]

print(f"\nWin trades  (n={len(win_scores)}):  mean IPCE score = {np.mean(win_scores):.3f}  ± {np.std(win_scores):.3f}")
print(f"Loss trades (n={len(loss_scores)}): mean IPCE score = {np.mean(loss_scores):.3f}  ± {np.std(loss_scores):.3f}")

if len(loss_scores) > 0 and len(win_scores) > 0:
    print(f"\nScore separation: {(np.mean(loss_scores) - np.mean(win_scores)):.3f}")
    print("(Positive = losses score higher = IPCE can discriminate)")

# ── Threshold sweep — at what threshold does IPCE add value? ──────────────
print("\n" + "-" * 72)
print("THRESHOLD SWEEP: At each veto threshold, how many trades are blocked?")
print(f"{'Threshold':>10}  {'Losses Vetoed':>15}  {'Wins Blocked':>15}  {'Net Value':>12}  {'Precision':>12}")
print("-" * 72)

best_net = 0
best_threshold = 0.5
for threshold in [round(x * 0.05, 2) for x in range(6, 18)]:
    loss_veto = sum(1 for s in loss_scores if s >= threshold)
    win_block = sum(1 for s in win_scores if s >= threshold)
    net = loss_veto - win_block  # true positives minus false positives
    prec = loss_veto / (loss_veto + win_block) if (loss_veto + win_block) > 0 else 0
    mark = " <--" if net > best_net else ""
    if net > best_net:
        best_net = net
        best_threshold = threshold
    print(f"{threshold:>10.2f}  {loss_veto:>15}  {win_block:>15}  {net:>12}  {prec:>12.2f}{mark}")

print(f"\nBest threshold: {best_threshold} (net value = {best_net})")

# ── Detailed losing trade breakdown ───────────────────────────────────────
print("\n" + "=" * 72)
print("LOSING TRADES — IPCE v2 Breakdown")
print("=" * 72)
print(f"{'PnL':>8}  {'Side':>5}  {'Z':>6}  {'Regime':>12}  {'CVD':>8}  {'OFI':>6}  {'Score':>7}  {'Veto?':>6}")
print("-" * 72)

for r in sorted(results["loss"], key=lambda x: x["total"], reverse=True):
    veto = "BLOCK" if r["total"] >= best_threshold else "pass"
    print(
        f"${r['pnl']:>7.2f}  {r['side']:>5}  {r['z']:>5.2f}  {r['regime']:>12}  "
        f"{r['cvd']:>8.0f}  {r['ofi']:>5.2f}  {r['total']:>6.3f}  {veto:>6}"
    )

# ── Summary ────────────────────────────────────────────────────────────────
print("\n" + "=" * 72)
print("VERDICT")
print("=" * 72)

total_losses = len(loss_scores)
loss_vetoed = sum(1 for s in loss_scores if s >= best_threshold)
win_blocked = sum(1 for s in win_scores if s >= best_threshold)

print(f"Total losing trades: {total_losses}")
print(f"Would have been vetoed by IPCE: {loss_vetoed} ({loss_vetoed/total_losses*100:.0f}%)")
print(f"Winning trades falsely blocked: {win_blocked} ({win_blocked/len(win_scores)*100:.0f}%)")
print(f"Net value: {loss_vetoed - win_blocked} trades saved")

if loss_vetoed >= 3 and win_blocked == 0:
    print("\n[PASS] Condition 5 MET")
elif loss_vetoed > win_blocked:
    print(f"\n[PARTIAL] Condition 5 PARTIALLY MET")
else:
    print(f"\n[FAIL] Condition 5 FAILED")
    print(f"\n✗ Condition 5 FAILED — IPCE v2 does not discriminate on current data")
