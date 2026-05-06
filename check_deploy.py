import ast, sys, re

ERRORS = []

def get_functions(path):
    with open(path, encoding='utf-8') as f:
        src = f.read()
    tree = ast.parse(src)
    return {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

def grep(path, pattern):
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    return [(i+1, l.rstrip()) for i, l in enumerate(lines) if re.search(pattern, l)]

print('=' * 60)
print('  Minimax 2.7 Hotfix Pre-Deploy Check')
print('=' * 60)

print()
print('[1] Core functions...')
main_fns = get_functions('bot/main.py')
qe_fns   = get_functions('bot/quant_engine.py')
hb_fns   = get_functions('bot/heartbeat.py')
for filepath, fn, fn_set in [
    ('bot/main.py',         '_apply_cvd_divergence_gate', main_fns),
    ('bot/main.py',         '_compute_signal',            main_fns),
    ('bot/quant_engine.py', '_cvd_divergence',            qe_fns),
    ('bot/quant_engine.py', '_save_state',                qe_fns),
    ('bot/heartbeat.py',    'get_db',                     hb_fns),
]:
    ok = fn in fn_set
    if not ok:
        ERRORS.append('MISSING: ' + filepath + '::' + fn)
    print(('  OK   ' if ok else '  ERR  ') + filepath + '::' + fn)

print()
print('[2] Hotfix patterns...')

# Check STOP order type is used (not STOP_LIMIT)
hits = grep('bot/executor.py', r'type="STOP"')
if hits:
    print('  OK   SL order type = STOP (Binance USDM correct type)')
else:
    ERRORS.append('MISSING: STOP order type in executor.py')
    print('  ERR  STOP order type not found in executor.py')

# Check STOP_MARKET fallback exists
hits = grep('bot/executor.py', r'STOP_MARKET.*sl_side|sl_side.*STOP_MARKET')
if hits:
    print('  OK   STOP_MARKET fallback branch exists')
else:
    ERRORS.append('MISSING: STOP_MARKET fallback in executor.py')
    print('  ERR  STOP_MARKET fallback not found')

# Check STOP_LIMIT is removed
hits = grep('bot/executor.py', r'type="STOP_LIMIT"')
if not hits:
    print('  OK   STOP_LIMIT correctly removed from executor')
else:
    ERRORS.append('BAD: STOP_LIMIT still present in executor at line ' + str(hits[0][0]))
    print('  ERR  STOP_LIMIT still present at line ' + str(hits[0][0]))

# Orphan backoff
for pat, desc in [
    (r'_orphan_flatten_attempts', 'Orphan backoff counter'),
    (r'_last_orphan_flatten_ts',  'Orphan backoff timestamp'),
    (r'standing down for',        'Orphan backoff log message'),
    (r'flatten_err',              'Flatten error caught explicitly'),
]:
    hits = grep('bot/main.py', pat)
    if hits:
        print('  OK   ' + desc)
    else:
        ERRORS.append('MISSING: ' + desc + ' in main.py')
        print('  ERR  ' + desc + ' not found in main.py')

# aggTrade watchdog
for pat, desc in [
    (r'_aggtrade_watchdog_prev_count', 'aggTrade count-delta watchdog var'),
    (r'sub-stream DEAD',               'aggTrade dead detection log'),
    (r'_reconnect_event.set',          'aggTrade forces reconnect'),
]:
    hits = grep('bot/data_feed.py', pat)
    if hits:
        print('  OK   ' + desc)
    else:
        ERRORS.append('MISSING: ' + desc + ' in data_feed.py')
        print('  ERR  ' + desc + ' not found in data_feed.py')

print()
print('[3] Merge hazards still absent...')
hazards = [
    ('bot/executor.py',     r'type="STOP_LIMIT"',                           'STOP_LIMIT in executor'),
    ('bot/quant_engine.py', r'return ofi, wall_context, all_walls_str\s*$', '_lob_metrics 3-tuple regression'),
]
for filepath, pattern, desc in hazards:
    hits = grep(filepath, pattern)
    if not hits:
        print('  OK   ' + desc + ' (correctly absent)')
    else:
        ERRORS.append('HAZARD: ' + desc)
        print('  ERR  MERGE HAZARD: ' + desc + ' at line ' + str(hits[0][0]))

print()
print('[4] Firebase init before QuantEngine...')
init_lines  = grep('bot/main.py', r'heartbeat\.init_firebase|init_firebase\(\)')
quant_lines = grep('bot/main.py', r'QuantEngine\(')
if init_lines and quant_lines:
    il, ql = init_lines[0][0], quant_lines[0][0]
    if il < ql:
        print('  OK   init_firebase() at line ' + str(il) + ' before QuantEngine() at line ' + str(ql))
    else:
        ERRORS.append('ORDERING: Firebase init after QuantEngine')
        print('  ERR  Firebase init at ' + str(il) + ' is AFTER QuantEngine at ' + str(ql))

print()
print('=' * 60)
if ERRORS:
    print('  RESULT: ' + str(len(ERRORS)) + ' ERROR(S) -- DO NOT DEPLOY')
    for e in ERRORS:
        print('  [X] ' + e)
else:
    print('  RESULT: ALL CLEAR -- Safe to deploy Minimax 2.7.1')
print('=' * 60)
sys.exit(1 if ERRORS else 0)
