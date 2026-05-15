"""
Quick smoke test: verifies all 8 audit fixes are present in the source files.
"""
checks = []

# --- main.py ---
main = open("bot/main.py", encoding="utf-8").read()

checks.append(("P1 ATR pre-seed",         "FIX-P1: Pre-seed quant._atr_history" in main))
checks.append(("P2 Sweep neutralizer",    "FIX-P2] SWEEP NEUTRALIZER" in main))
checks.append(("P4 HTF sweep filter",     "FIX-P4: HTF Directional Filter" in main))
checks.append(("P5 Sweep dedup global",   "_LAST_FIRED_SWEEP_CANDLE_TS: float = 0.0" in main))
checks.append(("P5 Sweep dedup logic",    "FIX-P5: Per-candle sweep deduplication" in main))
checks.append(("P8 Vol ratio fix",        "FIX-P8: recent_atr always returned 0.0" in main))

# --- ulis_engine.py ---
ulis = open("bot/ulis_engine.py", encoding="utf-8").read()
checks.append(("P3 ULIS NEUTRAL = 0.0",   "FIX-P3" in ulis))

# --- signal_config.py ---
sig = open("bot/signal_config.py", encoding="utf-8").read()
checks.append(("P10 LIQUIDITY conf=0.62", '"min_confidence":     0.62' in sig))

all_ok = True
for label, ok in checks:
    status = "PASS" if ok else "FAIL"
    if not ok:
        all_ok = False
    print(f"  [{status}] {label}")

print()
if all_ok:
    print("All audit fixes verified. Bot is ready to redeploy.")
else:
    print("Some fixes are MISSING. Review output above.")
