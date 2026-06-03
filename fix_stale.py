path = r'c:\Users\pc\Desktop\projects\Quad-desk\bot\main.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: tighten multiplier
old1 = 'if _last_candle_age > _interval_secs * 2.5:'
new1 = 'if _last_candle_age > _interval_secs * 1.5:  # FIX-STALE: tightened from 2.5x to 1.5x'
assert old1 in content, "OLD1 NOT FOUND"
content = content.replace(old1, new1, 1)

# Fix 2: update threshold log message
old2 = 'f">{_interval_secs * 2.5:.0f}s threshold). "'
new2 = 'f">{_interval_secs * 1.5:.0f}s threshold). "'
assert old2 in content, "OLD2 NOT FOUND"
content = content.replace(old2, new2, 1)

# Fix 3: add reconnect event before REST fetch
old3 = '                asyncio.create_task(feed._fetch_historical_candles_rest())\n                continue  # skip \u2014 data is stale'
new3 = (
    '                # FIX-STALE: Force WS reconnect so dead socket is replaced.\n'
    '                # Previously only REST was fetched, leaving the dead socket open.\n'
    '                feed.state._reconnect_event.set()\n'
    '                asyncio.create_task(feed._fetch_historical_candles_rest())\n'
    '                continue  # skip \u2014 data is stale'
)
assert old3 in content, f"OLD3 NOT FOUND"
content = content.replace(old3, new3, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("All 3 replacements applied successfully.")
