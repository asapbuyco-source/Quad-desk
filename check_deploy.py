"""Pre-deploy validation for Minimax 2.7"""
import ast, sys, re

ERRORS = []
WARNINGS = []

def get_functions(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    return {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

def grep(path, pattern):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    return [(i+1, l.rstrip()) for i, l in enumerate(lines) if re.search(pattern, l)]

print("=" * 60)
print("  Minimax 2.7 Pre-Deploy Check")
print("=" * 60)

# ── 1. Function presence ────────────────────────────────────────
print("\n[1/5] Checking required functions...")
main_fns = get_functions("bot/main.py")
qe_fns   = get_functions("bot/quant_engine.py")
hb_fns   = get_functions("bot/heartbeat.py")

checks = [
    ("bot/main.py",         "_apply_cvd_divergence_gate", main_fns),
    ("bot/main.py",         "_detect_regime",             main_fns),
    ("bot/main.py",         "_detect_liquidity_sweep",    main_fns),
    ("bot/main.py",         "_risk_engine",               main_fns),
    ("bot/main.py",         "_compute_signal",            main_fns),
    ("bot/quant_engine.py", "compute_metrics",            qe_fns),
    ("bot/quant_engine.py", "_lob_metrics",               qe_fns),
    ("bot/quant_engine.py", "_cvd_divergence",            qe_fns),
    ("bot/quant_engine.py", "_save_state",                qe_fns),
    ("bot/quant_engine.py", "_load_state",                qe_fns),
    ("bot/quant_engine.py", "update_win_rate",            qe_fns),
    ("bot/heartbeat.py",    "get_db",                     hb_fns),
    ("bot/heartbeat.py",    "init_firebase",              hb_fns),
]
for filepath, fn, fn_set in checks:
    if fn in fn_set:
        print(f"  OK   {filepath}::{fn}")
    else:
        ERRORS.append(f"MISSING function {filepath}::{fn}")
        print(f"  ERR  {filepath}::{fn}  ← MISSING")

# ── 2. Critical patterns present ───────────────────────────────
print("\n[2/5] Checking critical code patterns...")
pattern_checks = [
    # (file, pattern, must_exist, description)
    ("bot/data_feed.py",    r"_last_trade_ts.*time\.time\(\)",  True,  "aggTrade epoch fix (#1)"),
    ("bot/data_feed.py",    r"_aggtrade_msg_count",             True,  "aggTrade throughput counter (#1)"),
    ("bot/data_feed.py",    r"_cvd_was_reset.*=.*True",         True,  "CVD reconnect flag (#6)"),
    ("bot/quant_engine.py", r"_cvd_candle_snapshots",           True,  "CVD snapshot deque (#Phase3)"),
    ("bot/quant_engine.py", r"botState.*quantEngine",           True,  "Firestore state path (#3)"),
    ("bot/quant_engine.py", r"get_db\(\)",                      True,  "Firestore get_db call (#3)"),
    ("bot/quant_engine.py", r"QuantEngine-FSWrite",             True,  "Background thread name (#3)"),
    ("bot/main.py",         r"_apply_cvd_divergence_gate",      True,  "CVD gate call (Addition A)"),
    ("bot/main.py",         r"cvd_divergence_veto",             True,  "CVD veto stat tracking"),
    ("bot/main.py",         r"_cvd_candle_snapshots\.clear\(\)",True,  "CVD daily reset (Addition B)"),
    ("bot/main.py",         r"_interval_secs \* 2\.5",          True,  "Candle staleness guard (Addition C)"),
    ("bot/main.py",         r"emergency_flatten.*Orphan",       True,  "Orphan auto-close (#7)"),
    ("bot/main.py",         r"be_lock_trigger",                 True,  "be_lock_trigger in signal (Addition E)"),
    ("bot/main.py",         r"atr_at_entry",                    True,  "atr_at_entry in signal (Addition E)"),
    ("bot/main.py",         r"STOP_LIMIT",                      True,  "STOP_LIMIT in main signal"),
    ("bot/executor.py",     r"STOP_LIMIT",                      True,  "STOP_LIMIT in executor (#4)"),
    ("bot/executor.py",     r"atr_for_sl.*atr_at_entry",        True,  "ATR buffer for SL (#4)"),
    ("bot/main.py",         r"_last_was_sl.*else 120",          True,  "Split cooldown 120s (#5)"),
    # Merge hazards — bad patterns must NOT exist
    ("bot/main.py",         r"def _detect_regime\(metrics, buy_walls, sell_walls\):",  False, "MERGE HAZARD: detect_regime lost quant arg (#10)"),
    ("bot/main.py",         r"return \"ABOVE_HIGHS\"\s*$",      False, "MERGE HAZARD: liquidity_sweep 1-val return (#11)"),
    ("bot/quant_engine.py", r"return ofi, wall_context, all_walls_str\s*$", False, "MERGE HAZARD: _lob_metrics 3-tuple (#9)"),
]

for filepath, pattern, must_exist, desc in pattern_checks:
    hits = grep(filepath, pattern)
    found = len(hits) > 0
    if must_exist and found:
        print(f"  OK   {desc}")
    elif must_exist and not found:
        ERRORS.append(f"Missing pattern in {filepath}: {desc}")
        print(f"  ERR  {desc}  ← NOT FOUND in {filepath}")
    elif not must_exist and not found:
        print(f"  OK   {desc} (correctly absent)")
    else:
        # Found a pattern that must NOT exist
        for lineno, line in hits:
            ERRORS.append(f"BAD pattern in {filepath}:{lineno}: {desc}")
            print(f"  ERR  {desc}  ← FOUND at line {lineno}: {line[:80]}")

# ── 3. Return signature: _lob_metrics ──────────────────────────
print("\n[3/5] Checking _lob_metrics return tuple size...")
lob_hits = grep("bot/quant_engine.py", r"ofi, wall_context, all_walls_str, execution_price, valid_bids, valid_asks")
if lob_hits:
    print(f"  OK   _lob_metrics 10-tuple unpack found at line {lob_hits[0][0]}")
else:
    WARNINGS.append("Could not verify _lob_metrics 10-tuple unpack — check manually")
    print("  WARN _lob_metrics 10-tuple unpack not found — check compute_metrics()")

# ── 4. Firestore init order ─────────────────────────────────────
print("\n[4/5] Checking Firebase init order vs QuantEngine init...")
init_fb_lines   = grep("bot/main.py", r"heartbeat\.init_firebase|init_firebase\(\)")
quant_eng_lines = grep("bot/main.py", r"QuantEngine\(")
if init_fb_lines and quant_eng_lines:
    init_line  = init_fb_lines[0][0]
    quant_line = quant_eng_lines[0][0]
    if init_line < quant_line:
        print(f"  OK   init_firebase() at line {init_line} < QuantEngine() at line {quant_line}")
    else:
        ERRORS.append(f"init_firebase() at line {init_line} runs AFTER QuantEngine() at line {quant_line} — Firestore will not be ready for _load_state()")
        print(f"  ERR  init_firebase() at line {init_line} is AFTER QuantEngine() at line {quant_line}")
else:
    WARNINGS.append("Could not verify Firebase/QuantEngine init order")
    print("  WARN Could not locate both init lines in main.py")

# ── 5. Post-trade cooldown value ───────────────────────────────
print("\n[5/5] Checking post-TP cooldown is 120s (not 45s)...")
cooldown_hits = grep("bot/main.py", r"else 120|_cooldown.*120")
if cooldown_hits:
    print(f"  OK   TP cooldown 120s at line {cooldown_hits[0][0]}: {cooldown_hits[0][1].strip()}")
else:
    ERRORS.append("Post-TP cooldown 120s not found — still may be 45s")
    print("  ERR  Post-TP cooldown 120s not confirmed")

# ── Summary ─────────────────────────────────────────────────────
print("\n" + "=" * 60)
if ERRORS:
    print(f"  RESULT: {len(ERRORS)} ERROR(S) — DO NOT DEPLOY")
    for e in ERRORS:
        print(f"  ❌ {e}")
else:
    print(f"  RESULT: ALL CLEAR — safe to deploy")

if WARNINGS:
    print(f"\n  {len(WARNINGS)} warning(s):")
    for w in WARNINGS:
        print(f"  ⚠️  {w}")

print("=" * 60)
sys.exit(1 if ERRORS else 0)
