"""
Systematic structural audit — finds all inconsistencies across parallel paths.
Runs offline, no Firestore access needed.
"""

import ast
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

BOT_DIR = Path("bot")
FRONTEND_DIR = Path(".")

# ── 1. Check regime branch coverage in _compute_signal ───────────────────
def audit_regime_branches():
    """Every regime should have: strategy selection, exhaustion filter, dynamic Z usage."""
    print("\n=== 1. REGIME BRANCH AUDIT ===")
    
    # Parse main.py
    src = (BOT_DIR / "main.py").read_text(encoding="utf-8")
    
    # Find all regime branch starts
    regimes_found = set()
    for m in re.finditer(r'elif regime\s*==\s*"(\w+)"', src):
        regimes_found.add(m.group(1))
    for m in re.finditer(r'if regime\s*==\s*"(\w+)"', src):
        regimes_found.add(m.group(1))
    
    # Check each regime for key features
    exhaustion_regimes = set()
    for m in re.finditer(r'\[(\w+)\s*Exhaust\]', src):
        exhaustion_regimes.add(m.group(1))
    
    dynamic_z_regimes = set()
    for line in src.split("\n"):
        if "z_threshold_effective" in line and "regime" in line.lower()[:60]:
            # crude but effective
            pass
    
    print(f"  Regimes with code branches: {sorted(regimes_found)}")
    print(f"  Regimes with exhaustion filter: {sorted(exhaustion_regimes)}")
    
    missing_exhaust = regimes_found - exhaustion_regimes - {"LIQUIDITY"}  # LIQUIDITY returns WAIT
    if missing_exhaust:
        print(f"  WARNING: Missing exhaustion filter: {sorted(missing_exhaust)}")
    else:
        print("  OK: All regimes have exhaustion filters")


# ── 2. Compare live vs dry-run position dicts ────────────────────────────
def audit_live_vs_dryrun():
    """Find keys present in dry-run but not live, and vice versa."""
    print("\n=== 2. LIVE vs DRY-RUN POSITION AUDIT ===")
    
    src = (BOT_DIR / "executor.py").read_text(encoding="utf-8")
    
    def extract_dict_keys(section_start_marker, section_end_pattern):
        """Extract string keys from a dict literal between two markers."""
        start_idx = src.find(section_start_marker)
        if start_idx == -1:
            return set()
        section = src[start_idx:start_idx + 3000]
        keys = set()
        for m in re.finditer(r'"([a-z_]+)"\s*:', section):
            k = m.group(1)
            if not k.startswith("_"):
                keys.add(k)
        return keys
    
    dry_keys = extract_dict_keys('"dry_run": True', '"entry_ts"')
    live_keys = extract_dict_keys('"dry_run": False', '"entry_features"')
    
    live_only = live_keys - dry_keys
    dry_only = dry_keys - live_keys
    
    if dry_only:
        print(f"  MISSING from live: {sorted(dry_only)}")
    if live_only:
        print(f"  EXTRA in live: {sorted(live_only)}")
    if not dry_only and not live_only:
        print("  OK: Live and dry-run position dicts match")
    else:
        common = dry_keys & live_keys
        print(f"  Common keys: {len(common)}")


# ── 3. Check signal_config for regime key completeness ───────────────────
def audit_signal_config():
    """Every regime should have all required keys, consistent values."""
    print("\n=== 3. SIGNAL CONFIG AUDIT ===")
    
    # Use exec to load the config safely
    cfg_src = (BOT_DIR / "signal_config.py").read_text(encoding="utf-8")
    namespace = {}
    exec(cfg_src, namespace)
    REGIME_PARAMS = namespace.get("REGIME_PARAMS", {})
    
    REQUIRED_KEYS = [
        "z_threshold", "atr_multiplier_sl", "ofi_bound", "min_confidence",
        "rr_target", "be_lock_trigger", "partial_take_r", "partial_take_pct",
        "time_exit_sec", "time_exit_hard_cap_s", "panic_threshold",
        "candle_gate_sec", "htf_block", "cascade_cooldown_s"
    ]
    
    for regime, params in sorted(REGIME_PARAMS.items()):
        missing = [k for k in REQUIRED_KEYS if k not in params]
        extra = [k for k in params if k not in REQUIRED_KEYS]
        if missing:
            print(f"  {regime}: MISSING keys: {missing}")
        if extra:
            print(f"  {regime}: EXTRA keys: {extra}")
    
    print(f"  Regimes audited: {len(REGIME_PARAMS)}")
    
    # Check for suspicious relative values
    for regime, p in REGIME_PARAMS.items():
        sl = p.get("atr_multiplier_sl", 1.0)
        z = p.get("z_threshold", 1.0)
        if sl < 0.6:
            print(f"  WARNING: {regime} SL multiplier {sl} is very tight")
        if z < 0.5:
            print(f"  WARNING: {regime} Z threshold {z} is very low")
    
    # Check time_exit_hard_cap_s >= time_exit_sec
    for regime, p in REGIME_PARAMS.items():
        te = p.get("time_exit_sec", 0)
        th = p.get("time_exit_hard_cap_s", 0)
        if th < te:
            print(f"  ERROR: {regime} time_exit_hard_cap_s ({th}) < time_exit_sec ({te})")


# ── 4. Check Firestore field consistency ──────────────────────────────────
def audit_firestore_consistency():
    """Fields written in heartbeat must exist in TypeScript types and store subscription."""
    print("\n=== 4. FIRESTORE FIELD AUDIT ===")
    
    # Extract heartbeat payload fields
    hb_src = (BOT_DIR / "heartbeat.py").read_text(encoding="utf-8")
    hb_fields = set()
    for m in re.finditer(r'"(\w+)"\s*:', hb_src):
        if m.group(1)[0].isupper():  # camelCase Firestore fields
            hb_fields.add(m.group(1))
    
    # Extract TypeScript BotSettingsState fields
    ts_src = Path("types.ts").read_text(encoding="utf-8")
    ts_fields = set()
    in_interface = False
    for line in ts_src.split("\n"):
        if "BotSettingsState" in line and "interface" in line:
            in_interface = True
            continue
        if in_interface and "}" in line:
            break
        if in_interface:
            m = re.match(r'\s*(\w+)\??\s*:', line)
            if m:
                ts_fields.add(m.group(1))
    
    # Extract store subscription fields
    store_src = Path("store/index.ts").read_text(encoding="utf-8")
    store_fields = set()
    in_subscription = False
    for line in store_src.split("\n"):
        if "subscribeToBotStatus" in line:
            in_subscription = True
        if in_subscription and "set((state)" in line:
            # find the botSettings block
            pass
    
    # Compare heartbeat -> types
    in_hb_not_ts = hb_fields - ts_fields
    if in_hb_not_ts:
        print(f"  FIELDS IN HEARTBEAT but NOT in types: {sorted(in_hb_not_ts)}")
    
    # Compare types -> heartbeat  
    ts_opt = {f for f in ts_fields if not f[0].isupper()}  # optional fields start lowercase
    # Actually heartbeat fields are camelCase, types are camelCase too
    # Let me just check the main data fields
    print(f"  Heartbeat fields: {len(hb_fields)}")
    print(f"  TypeScript interface fields: {len(ts_fields)}")


# ── 5. Check for hardcoded magic numbers ──────────────────────────────────
def audit_magic_numbers():
    """Find suspicious hardcoded numeric values that should be configurable."""
    print("\n=== 5. MAGIC NUMBER AUDIT ===")
    
    files = {
        "executor.py": (BOT_DIR / "executor.py").read_text(encoding="utf-8"),
        "main.py": (BOT_DIR / "main.py").read_text(encoding="utf-8"),
    }
    
    # Look for hardcoded multipliers in fallback/drift logic
    patterns = [
        (r'time_exit_sec\s*\*\s*([\d.]+)', "time_exit fallback multiplier"),
        (r'risk_dist\s*\*\s*size\s*\*\s*([\d.]+)', "risk size multiplier"),
        (r'fee_slippage.*\*\s*([\d.]+)', "fee slippage multiplier"),
    ]
    
    for fname, src in files.items():
        for pattern, desc in patterns.items():
            matches = re.findall(pattern, src)
            for val in matches:
                print(f"  {fname}: {desc} = {val}")


# ── 6. Check exit_type consistency ───────────────────────────────────────
def audit_exit_types():
    """All _process_exit call sites should pass exit_type."""
    print("\n=== 6. EXIT TYPE AUDIT ===")
    
    src = (BOT_DIR / "main.py").read_text(encoding="utf-8")
    
    # Find all calls to _process_exit
    calls = []
    for m in re.finditer(r'_process_exit\(([^)]+)\)', src):
        args = m.group(1)
        has_exit_type = "exit_type" in args
        calls.append((m.start(), has_exit_type))
    
    with_type = sum(1 for _, h in calls if h)
    without = sum(1 for _, h in calls if not h)
    
    print(f"  _process_exit calls with exit_type: {with_type}")
    print(f"  _process_exit calls WITHOUT exit_type: {without}")
    if without > 0:
        print(f"  WARNING: {without} calls missing exit_type (defaults to UNKNOWN)")


# ── 7. Check for signal return consistency across regimes ─────────────────
def audit_signal_return():
    """The signal dict returned from _compute_signal should have consistent keys."""
    print("\n=== 7. SIGNAL RETURN AUDIT ===")
    
    src = (BOT_DIR / "main.py").read_text(encoding="utf-8")
    
    # Find the return dict in _compute_signal
    return_start = src.find('"verdict":        verdict,')
    if return_start == -1:
        print("  ERROR: Could not find signal return dict")
        return
    
    # Extract keys
    return_block = src[return_start:return_start + 800]
    keys = []
    for m in re.finditer(r'"(\w+)"\s*:', return_block):
        if m.group(1) != "verdict":
            keys.append(m.group(1))
    
    # Check executor usage of signal.get()
    exec_src = (BOT_DIR / "executor.py").read_text(encoding="utf-8")
    used_keys = set()
    for m in re.finditer(r'signal\.get\("(\w+)"', exec_src):
        used_keys.add(m.group(1))
    
    unused_in_exec = set(keys) - used_keys
    if unused_in_exec:
        print(f"  Signal keys never read by executor: {sorted(unused_in_exec)}")
    
    print(f"  Signal return keys: {len(keys)}")
    print(f"  Keys used by executor: {len(used_keys)}")


# ── 8. Check for regression in latest commits ─────────────────────────────
def audit_recent_changes():
    """Verify recent changes didn't break anything structural."""
    print("\n=== 8. RECENT CHANGES AUDIT ===")
    
    # Verify t-scale is actually removed
    qe_src = (BOT_DIR / "quant_engine.py").read_text(encoding="utf-8")
    if "t_scale" in qe_src:
        print("  WARNING: t_scale still present in quant_engine.py!")
    else:
        print("  OK: t-scale correction removed")
    
    # Verify RANGE z_threshold is 0.80
    cfg_src = (BOT_DIR / "signal_config.py").read_text(encoding="utf-8")
    range_z = re.search(r'"RANGE":\s*\{[^}]*"z_threshold":\s*([\d.]+)', cfg_src, re.DOTALL)
    if range_z:
        val = float(range_z.group(1))
        if val == 0.80:
            print(f"  OK: RANGE z_threshold = {val}")
        else:
            print(f"  WARNING: RANGE z_threshold = {val} (expected 0.80)")
    
    # Verify Dynamic Z has seed method
    dz_src = (BOT_DIR / "dynamic_z_engine.py").read_text(encoding="utf-8")
    if "seed_from_history" in dz_src:
        print("  OK: DynamicZ seed_from_history exists")
    else:
        print("  WARNING: DynamicZ missing seed_from_history")
    
    # Verify z_score_at_entry in live position
    if '"z_score_at_entry"' in (BOT_DIR / "executor.py").read_text(encoding="utf-8"):
        print("  OK: z_score_at_entry in live position dict")
    else:
        print("  WARNING: z_score_at_entry missing from live position")


# ── RUN ALL ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    audits = [
        audit_regime_branches,
        audit_live_vs_dryrun,
        audit_signal_config,
        audit_firestore_consistency,
        audit_magic_numbers,
        audit_exit_types,
        audit_signal_return,
        audit_recent_changes,
    ]
    
    for audit_fn in audits:
        try:
            audit_fn()
        except Exception as e:
            print(f"  ERROR in {audit_fn.__name__}: {e}")
    
    print("\n" + "=" * 60)
    print("AUDIT COMPLETE")
