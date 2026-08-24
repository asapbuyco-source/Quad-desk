import json, urllib.request
from datetime import datetime, timezone

PROJECT_ID = "quantdesk-6bcd0"
API_KEY = "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg"
url = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/botTrades?key={API_KEY}"
req = urllib.request.Request(url)
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.loads(resp.read().decode())

docs = data.get("documents", [])
opens = []
for doc in docs:
    f = doc.get("fields", {})
    def fv(k, d=None):
        v = f.get(k, {})
        for t in ("stringValue", "integerValue", "doubleValue", "booleanValue"):
            if t in v:
                return v[t]
        return d
    status = fv("status", fv("result", "?"))
    if status not in ("CLOSED", "WIN", "LOSS"):
        opens.append({
            "id": doc["name"].split("/")[-1],
            "symbol": fv("symbol", "?"),
            "side": fv("side", "?"),
            "entry": float(fv("entry_price", 0) or 0),
            "ts": int(fv("ts_ms", 0) or 0),
            "status": status,
        })

print(f"OPEN trades in Firestore: {len(opens)}")
for o in opens:
    d = datetime.fromtimestamp(o["ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M")
    print(f"  {o['id'][:12]} | {d} | {o['symbol']} | {o['side']} @ {o['entry']} | status={o['status']}")
