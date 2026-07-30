"""
Fetch all bot trades from Firestore and run IPCE v2 rollback test.
Uses Firestore REST API with the project's API key.
"""
import json
import urllib.request
import urllib.parse
import sys
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────
PROJECT_ID = "quantdesk-6bcd0"
API_KEY = "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg"
COLLECTION = "botTrades"
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/{COLLECTION}"

def fetch_all_trades():
    """Fetch all CLOSED trades from Firestore via REST API."""
    all_trades = []
    next_page = BASE_URL
    page = 0
    
    while next_page and page < 20:
        page += 1
        url = f"{next_page}?key={API_KEY}" if "?" not in next_page else f"{next_page}&key={API_KEY}"
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            print(f"Error fetching page {page}: {e}")
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
                "exit_ts_ms": int(fv("exit_ts_ms", 0) or 0),
            }
            all_trades.append(trade)
        
        next_page = data.get("nextPageToken")
        if next_page:
            next_page = f"{BASE_URL}?pageToken={next_page}"
        print(f"  Page {page}: {len(docs)} docs, total={len(all_trades)}")
    
    return all_trades


if __name__ == "__main__":
    print("Fetching trades from Firestore...")
    trades = fetch_all_trades()
    print(f"\nTotal fetched: {len(trades)} trades")
    
    # Save the raw data
    out_path = Path("reports/firestore_trades.json")
    out_path.parent.mkdir(exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(trades, f, indent=2, default=str)
    print(f"Saved to {out_path}")
    
    # Quick summary
    closed = [t for t in trades if t["result"] in ("WIN", "LOSS")]
    wins = [t for t in closed if t["result"] == "WIN"]
    losses = [t for t in closed if t["result"] == "LOSS"]
    open_t = [t for t in trades if t["result"] not in ("WIN", "LOSS")]
    
    total_pnl = sum(t["pnl"] for t in closed)
    print(f"\nClosed trades: {len(closed)} ({len(wins)}W / {len(losses)}L)")
    print(f"Win rate: {len(wins)/max(len(closed),1)*100:.1f}%")
    print(f"Total PnL: ${total_pnl:.2f}")
    print(f"Open: {len(open_t)}")
    
    # Run IPCE test
    print("\n\nStarting IPCE analysis...")
    exec(open("ipce_rollback_test.py").read().replace(
        'reports/*.json',
        'reports/firestore_trades.json'
    ))
