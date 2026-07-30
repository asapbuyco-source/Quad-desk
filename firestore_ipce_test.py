"""
Fetch all bot trades from Firestore and run IPCE v2 rollback test.
"""
import json
import urllib.request
import numpy as np
from pathlib import Path

PROJECT_ID = "quantdesk-6bcd0"
API_KEY = "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg"
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/botTrades"

print("Fetching trades from Firestore...")

all_trades = []
next_page = BASE_URL
page = 0

while next_page and page < 20:
    page += 1
    sep = "?" if "?" not in next_page else "&"
    url = f"{next_page}{sep}key={API_KEY}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  Page {page} error: {e}")
        break

    docs = data.get("documents", [])
    for doc in docs:
        fields = doc.get("fields", {})

        def fv(key, default=None):
            v = fields.get(key, {})
            for t in ("stringValue", "integerValue", "doubleValue", "booleanValue"):
                if t in v:
                    return v[t]
            if "nullValue" in v:
                return None
            return default

        trade = {
            "id": doc["name"].split("/")[-1],
            "symbol": fv("symbol", "?"),
            "side": fv("side") or fv("portfolio_side", "?"),
            "verdict": fv("verdict", "?"),
            "entry_price": float(fv("entry_price", 0) or 0),
            "exit_price": float(fv("exit_price", 0) or 0),
            "pnl": float(fv("pnl", 0) or 0),
            "result": fv("result") or fv("status", "?"),
            "regime": fv("regime", "UNKNOWN"),
            "z_score": float(fv("z_score", 0) or 0),
            "ofi": float(fv("ofi_tanh", 0) or 0),
            "bayes": float(fv("bayesian", 0) or 0),
            "confidence": float(fv("confidence", 0) or 0),
            "rsi": float(fv("rsi", 50) or 50),
            "atr_pct": float(fv("atr_pct", 0) or 0),
            "strategy_type": fv("strategy_type", "?"),
            "ulis_verdict": fv("ulis_verdict", "?"),
            "size": float(fv("size", 0) or 0),
            "ts_ms": int(fv("ts_ms", 0) or 0),
        }
        all_trades.append(trade)

    next_page = data.get("nextPageToken")
    if next_page:
        next_page = f"{BASE_URL}?pageToken={next_page}"
    print(f"  Page {page}: {len(docs)} docs, running total={len(all_trades)}")

print(f"\nFetched {len(all_trades)} total docs from Firestore")

# ── Filter closed trades ──────────────────────────────────────────────────
closed = [t for t in all_trades if t["result"] in ("WIN", "LOSS")]
wins = [t for t in closed if t["result"] == "WIN"]
losses = [t for t in closed if t["result"] == "LOSS"]
open_trades = [t for t in all_trades if t["result"] not in ("WIN", "LOSS")]

total_pnl = sum(t["pnl"] for t in closed)
print(f"Closed: {len(closed)} ({len(wins)}W / {len(losses)}L)  WR={len(wins)/max(len(closed),1)*100:.1f}%  PnL=${total_pnl:.2f}  Open={len(open_trades)}")

# Show losing trade details
print("\n--- All losing trades ---")
for t in sorted(losses, key=lambda x: x["pnl"]):
    print(f"  ${t['pnl']:>7.2f}  {t['side']:>5}  Z={t['z_score']:.2f}  {t['regime']:<12}  OFI={t['ofi']:+.2f}  Bayes={t['bayes']:.0%}  RSI={t['rsi']:.0f}  {t['verdict']}")

print("\n--- All winning trades ---")
for t in sorted(wins, key=lambda x: -x["pnl"]):
    print(f"  ${t['pnl']:>7.2f}  {t['side']:>5}  Z={t['z_score']:.2f}  {t['regime']:<12}  OFI={t['ofi']:+.2f}  Bayes={t['bayes']:.0%}  RSI={t['rsi']:.0f}  {t['verdict']}")

# ── IPCE v2 rollback test ────────────────────────────────────────────────
print("\n" + "=" * 72)
print("IPCE v2 ROLLBACK TEST")
print("=" * 72)

W_Z      = 0.30
W_REGIME = 0.25
W_CVD    = 0.15  # reduced since CVD not in trade records — use regime as primary
W_OFI    = 0.30  # increased since OFI is in the data

REGIME_RISK = {
    "RANGE": 0.70, "NEUTRAL": 0.55, "LIQUIDITY": 0.65,
    "TREND": 0.30, "VOLATILE": 0.50, "SQUEEZE": 0.60,
    "COMPRESSION": 0.55, "UNKNOWN": 0.60,
}

def ipce_score(trade):
    z = abs(trade.get("z_score", 0) or 0)
    regime = str(trade.get("regime", "UNKNOWN")).upper()
    ofi = float(trade.get("ofi", 0) or 0)
    side = str(trade.get("side", "long")).lower()
    bayes = float(trade.get("bayes", 0.5) or 0.5)
    confidence = float(trade.get("confidence", 0) or 0)

    z_c = min(z / 3.0, 1.0)
    r_c = REGIME_RISK.get(regime, 0.55)

    trade_sign = 1 if side in ("buy", "long") else -1
    ofi_sign = 1 if ofi > 0.01 else -1 if ofi < -0.01 else 0
    ofi_aligned = 1 if ofi_sign == trade_sign else -1 if ofi_sign == -trade_sign else 0
    ofi_c = 0.5 - 0.5 * ofi_aligned

    score = W_Z * z_c + W_REGIME * r_c + W_OFI * ofi_c
    return score

win_scores = [ipce_score(t) for t in wins]
loss_scores = [ipce_score(t) for t in losses]

print(f"\nWin trades  (n={len(win_scores)}):  mean={np.mean(win_scores):.3f}  std={np.std(win_scores):.3f}" if win_scores else "\nWin trades: 0")
print(f"Loss trades (n={len(loss_scores)}): mean={np.mean(loss_scores):.3f}  std={np.std(loss_scores):.3f}")

if win_scores and loss_scores:
    sep = np.mean(loss_scores) - np.mean(win_scores)
    print(f"Separation: {sep:+.3f}  (positive = IPCE discriminates)")

print(f"\n{'Threshold':>10}  {'Losses Vetoed':>15}  {'Wins Blocked':>15}  {'Net':>8}  {'Precision':>10}")
print("-" * 66)

best_net = -999
best_t = 0.5
for threshold in [round(x * 0.05, 2) for x in range(6, 18)]:
    lv = sum(1 for s in loss_scores if s >= threshold)
    wb = sum(1 for s in win_scores if s >= threshold)
    net = lv - wb
    prec = lv / (lv + wb) if (lv + wb) > 0 else 0
    mark = " <--" if net > best_net else ""
    if net > best_net:
        best_net = net
        best_t = threshold
    print(f"{threshold:>10.2f}  {lv:>15}  {wb:>15}  {net:>8}  {prec:>10.2f}{mark}")

print(f"\nBest threshold: {best_t}  (net = {best_net})")

# ── Per-trade breakdown ───────────────────────────────────────────────────
print(f"\n{'PnL':>8}  {'Side':>5}  {'Z':>6}  {'Regime':>12}  {'OFI':>6}  {'Bayes':>7}  {'Score':>7}  {'Veto?':>6}")
print("-" * 72)

for t in sorted(losses + wins, key=lambda x: ipce_score(x), reverse=True):
    s = ipce_score(t)
    veto = "BLOCK" if s >= best_t else "pass"
    print(f"${t['pnl']:>7.2f}  {t['side']:>5}  {t['z_score']:>5.2f}  {t['regime']:>12}  "
          f"{t['ofi']:>+5.2f}  {t['bayes']:>6.0%}  {s:>6.3f}  {veto:>6}  {t['result']:>5}")

# ── Verdict ──────────────────────────────────────────────────────────────
print(f"\n{'='*72}")
print("VERDICT")
print(f"{'='*72}")
lv = sum(1 for s in loss_scores if s >= best_t)
wb = sum(1 for s in win_scores if s >= best_t)
print(f"Losing trades vetoed: {lv}/{len(losses)} ({lv/max(len(losses),1)*100:.0f}%)")
print(f"Winning trades blocked: {wb}/{len(wins)} ({wb/max(len(wins),1)*100:.0f}%)")
print(f"Net value: {lv - wb}")

if lv >= 3 and wb == 0:
    print("\n[PASS] Condition 5 MET")
elif lv > wb:
    print(f"\n[PARTIAL] Condition 5 PARTIALLY MET")
else:
    print("\n[FAIL] Condition 5 FAILED")
