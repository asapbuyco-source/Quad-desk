import re

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/hmm_calibrate.py', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Update fetch_data
fetch_target = """    print(f"  [OK] {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    try:
        df.to_pickle(cache_file)"""

fetch_replacement = """    print(f"  [OK] {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    
    # Fetch funding rate
    print(f"  [FETCH] {symbol} Funding Rate...")
    fr_list = []
    fr_cur = start_ms
    while fr_cur < end_ms:
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/fundingRate",
            params={"symbol": symbol, "startTime": fr_cur, "endTime": end_ms, "limit": 1000},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch: break
        fr_list.extend(batch)
        fr_cur = int(batch[-1]['fundingTime']) + 1
        if len(batch) < 1000: break
    if fr_list:
        import pandas as pd
        fr_df = pd.DataFrame(fr_list)
        fr_df['time'] = pd.to_datetime(fr_df['fundingTime'].astype(int), unit='ms')
        fr_df['funding_rate'] = fr_df['fundingRate'].astype(float)
        fr_df.set_index('time', inplace=True)
        # Keep only funding_rate and drop duplicates if any
        fr_df = fr_df[~fr_df.index.duplicated(keep='last')][['funding_rate']]
        df = df.join(fr_df, how='left')
        df['funding_rate'] = df['funding_rate'].ffill().fillna(0.0)
    else:
        df['funding_rate'] = 0.0

    try:
        df.to_pickle(cache_file)"""

if fetch_target in text:
    text = text.replace(fetch_target, fetch_replacement)
else:
    print("Failed to match fetch_data")

# 2. Update build_feature_matrix docstring
doc_target = """      f4: |z_ret|                     — NEW: log-return velocity
    \"\"\""""
doc_replacement = """      f4: |z_ret|                     — NEW: log-return velocity
      f5: funding_rate                — Funding rate scaled
    \"\"\""""
if doc_target in text:
    text = text.replace(doc_target, doc_replacement)
else:
    print("Failed to match docstring")

# 3. Update build_feature_matrix
build_target = """    X = np.column_stack([
        np.clip(atr_pct[start_idx:],  0.0, 0.03),   # f0
        np.clip(abs_z[start_idx:],    0.0, 4.0),     # f1
        tape_bin[start_idx:],                        # f2
        np.clip(atr_rank[start_idx:], 0.0, 1.0),    # f3
        np.clip(abs_zr[start_idx:],   0.0, 4.0),    # f4  ← NEW velocity feature
    ])"""
build_replacement = """    funding_rate = df['funding_rate'].values.astype(float)

    X = np.column_stack([
        np.clip(atr_pct[start_idx:],  0.0, 0.03),   # f0
        np.clip(abs_z[start_idx:],    0.0, 4.0),     # f1
        tape_bin[start_idx:],                        # f2
        np.clip(atr_rank[start_idx:], 0.0, 1.0),    # f3
        np.clip(abs_zr[start_idx:],   0.0, 4.0),    # f4  ← NEW velocity feature
        np.clip(funding_rate[start_idx:] * 1000, -2.0, 2.0), # f5: funding rate
    ])"""
if build_target in text:
    text = text.replace(build_target, build_replacement)
else:
    print("Failed to match build_feature_matrix")

# 4. Fix output print for labels
print_target = """print(f"    {lab:10s}: atr%={mu[i,0]:.5f}  |z|={mu[i,1]:.3f}  "
              f"tape={mu[i,2]:.2f}  rank={mu[i,3]:.3f}  |zret|={mu[i,4]:.3f}")"""
print_replacement = """print(f"    {lab:10s}: atr%={mu[i,0]:.5f}  |z|={mu[i,1]:.3f}  "
              f"tape={mu[i,2]:.2f}  rank={mu[i,3]:.3f}  |zret|={mu[i,4]:.3f}  fr={mu[i,5]:.3f}")"""
if print_target in text:
    text = text.replace(print_target, print_replacement)
else:
    print("Failed to match print")

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/hmm_calibrate.py', 'w', encoding='utf-8') as f:
    f.write(text)

print("hmm_calibrate.py patched!")
