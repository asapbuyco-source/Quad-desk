import json, urllib.request, urllib.parse

PROJECT_ID = "quantdesk-6bcd0"
API_KEY = "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/botTrades"

# Stale records confirmed closed by operator
STALE_IDS = [
    "28cizzXiYOyA",
    "2H9ZdFokMT69",
    "2TksuNXjk5Bk",
    "9bgQWzlLhBqm",
    "DMM40ZAztD2r",
    "E3VZaR9wDZVI",
]

import time
now_ms = int(time.time() * 1000)

for tid in STALE_IDS:
    url = f"{BASE}/{tid}?updateMask.fieldPaths=status&updateMask.fieldPaths=result&updateMask.fieldPaths=exit_ts_ms&updateMask.fieldPaths=note&key={API_KEY}"
    body = json.dumps({
        "fields": {
            "status": {"stringValue": "CLOSED"},
            "result": {"stringValue": "MANUAL_CLOSE"},
            "exit_ts_ms": {"integerValue": str(now_ms)},
            "note": {"stringValue": "Stale record — operator confirmed no open position on exchange (Aug 22 audit)"},
        }
    }).encode()
    req = urllib.request.Request(url, data=body, method="PATCH", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"OK  {tid}")
    except Exception as e:
        print(f"ERR {tid}: {e}")
