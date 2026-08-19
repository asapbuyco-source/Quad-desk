import json, urllib.request
from datetime import datetime, timezone

PROJECT_ID = "quantdesk-6bcd0"
API_KEY = "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg"
url = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/botTrades?key={API_KEY}"
req = urllib.request.Request(url)
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.loads(resp.read().decode())

docs = data.get("documents", [])
trades = []
for doc in docs:
    f = doc.get("fields", {})
    def fv(k, d=None):
        v = f.get(k, {})
        for t in ("stringValue", "integerValue", "doubleValue", "booleanValue"):
            if t in v:
                return v[t]
        return d
    ts = int(fv("ts_ms", 0) or 0)
    if ts > 0:
        trades.append({
            "ts": ts,
            "symbol": fv("symbol", "?"),
            "result": fv("result") or fv("status", "?"),
            "pnl": float(fv("pnl", 0) or 0),
            "entry": float(fv("entry_price", 0) or 0),
            "exit": float(fv("exit_price", 0) or 0),
            "side": fv("side", "?"),
            "verdict": fv("verdict", "?"),
            "regime": fv("regime", "?"),
            "z_score": float(fv("z_score", 0) or 0),
            "strategy": fv("strategy_type", "?"),
            "rsi": float(fv("rsi", 50) or 50),
            "conf": float(fv("confidence", 0) or 0),
            "size": float(fv("size", 0) or 0),
            "exit_ts": int(fv("exit_ts_ms", 0) or 0),
        })

trades.sort(key=lambda x: -x["ts"])

print("=== RECENT 10 TRADES ===")
for t in trades[:10]:
    entry = datetime.fromtimestamp(t["ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M")
    exit_t = datetime.fromtimestamp(t["exit_ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M") if t["exit_ts"] > 0 else "?"
    print(f"{entry} exit={exit_t} | {t['symbol']:>15} | {t['side']:>4} | {t['result']:>5} | ${t['pnl']:+.2f} | Z={t['z_score']:.2f} RSI={t['rsi']:.0f} | {t['regime']:<15} | {t['strategy']:<25} | conf={t['conf']:.0%} | entry={t['entry']} exit={t['exit']}")

print()
aug_cutoff = 1754000000000
recent = [t for t in trades if t["ts"] > aug_cutoff]
wins = [t for t in recent if t["result"] == "WIN"]
losses = [t for t in recent if t["result"] == "LOSS"]
total_pnl = sum(t["pnl"] for t in recent)
print(f"Recent (Aug+): {len(recent)} trades ({len(wins)}W/{len(losses)}L)")
print(f"Win rate: {len(wins)/max(len(recent),1)*100:.1f}%")
print(f"Total PnL: ${total_pnl:+.2f}")
if wins:
    print(f"Avg win: ${sum(t['pnl'] for t in wins)/len(wins):+.2f}")
if losses:
    print(f"Avg loss: ${sum(t['pnl'] for t in losses)/len(losses):+.2f}")
if wins and losses:
    profit_factor = abs(sum(t['pnl'] for t in wins) / sum(t['pnl'] for t in losses))
    print(f"Profit factor: {profit_factor:.2f}")
