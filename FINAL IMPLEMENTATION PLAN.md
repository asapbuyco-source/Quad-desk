# Quad-Desk — Final Implementation Plan

**Effective Date:** 29 April 2026
**Status:** APPROVED FOR EXECUTION
**Pre-Requisite:** All changes deployed sequentially. No batched deployments. Each step is verified on testnet for 4 hours minimum before proceeding.

---

## PHASE 0 — OBSERVABILITY (Deploy First, Before Any Logic Changes)

### Step 0.1: Add per-gate rejection counters to execution_loop

File: `bot/main.py` — `execution_loop()`

Add a dict `gate_stats` to `BOT_STATS`:
```python
"gate_stats": {
    "regime_liquidity_override": 0,
    "regime_neutral_conf": 0,
    "strategy_no_edge": 0,
    "htf_blocked": 0,
    "funding_blocked": 0,
    "bayesian_below_threshold": 0,
    "ulis_veto": 0,
    "ulis_alignment_fail": 0,
    "confidence_below_regime_min": 0,
    "candle_gate_expired": 0,
    "cooldown_active": 0,
    "daily_loss_halt": 0,
    "drawdown_halt": 0,
    "startup_lockout": 0,
    "fee_check_failed": 0,
    "invalid_geometry": 0,
    "micro_confirms_failed": 0,
    "sweep_confirms_failed": 0,
    "mean_rev_z_failed": 0,
    "mean_rev_slope_failed": 0,
    "signal_passed_all_gates": 0,
    "total_cycles": 0,
}
```

Increment the relevant counter at each rejection point in `_compute_signal()` and `execution_loop()`. Log a summary every 30 minutes:
```python
if int(time.time()) % 1800 < ANALYSIS_INTERVAL:
    logger.info(f"[GateStats] {stats['gate_stats']}")
```

### Step 0.2: Add aggTrade health monitoring

File: `bot/data_feed.py` — `run()` method, after WS message handling loop

Add a class variable `_last_trade_ts: float = 0.0` to `BinanceDataFeed`. In `_handle_message`, when an `@aggTrade` message is received, set `self._last_trade_ts = time.time()`.

In `execution_loop`, before metrics computation:
```python
trade_count = len(feed.state.recent_trades)
trade_age = time.time() - feed._last_trade_ts if feed._last_trade_ts > 0 else 9999
if trade_count < 5 or trade_age > 30:
    logger.warning(f"[Health] AggTrade feed degraded: {trade_count} trades in buffer, "
                   f"last trade {trade_age:.0f}s ago")
```

### Step 0.3: Fix funding rate fetch to run independently

File: `bot/data_feed.py`

Remove the inline `asyncio.create_task(self._fetch_funding_rate())` from the WS message handler (line ~279).

In `bot/main.py` `main()`, add a dedicated task:
```python
tasks = [
    asyncio.create_task(feed.run(), name="data_feed"),
    asyncio.create_task(execution_loop(feed, quant, executor, BOT_STATS), name="exec_loop"),
    asyncio.create_task(heartbeat.run_heartbeat(BOT_STATS), name="heartbeat"),
    asyncio.create_task(feed.feed_health_monitor(notifier=executor.notifier), name="feed_health_monitor"),
    asyncio.create_task(funding_rate_loop(feed), name="funding_rate"),
]
```

New async function in `bot/main.py`:
```python
async def funding_rate_loop(feed):
    await asyncio.sleep(120)  # Wait for WS to connect
    while feed.is_running:
        await feed._fetch_funding_rate()
        await asyncio.sleep(60)
```

### Step 0.4: Add current mid-price from order book

File: `bot/main.py` — `execution_loop()`

After `current_price = feed.state.candles[-1]["close"]`, add:
```python
best_bid = max(feed.state.bids.keys()) if feed.state.bids else current_price
best_ask = min(feed.state.asks.keys()) if feed.state.asks else current_price
execution_price = (best_bid + best_ask) / 2 if (feed.state.bids and feed.state.asks) else current_price
```

Pass `execution_price` to `executor.execute_signal()` as the price parameter instead of `metrics["price"]`. Keep `current_price` (candle close) for signal computation and SL/TP geometry. In `execute_signal`, use `execution_price` for fill estimation and minimum notional checks; use `current_price` for SL/TP calculation.

---

## PHASE 1 — DATA PIPELINE FIXES (Deploy after Phase 0 verified)

### Step 1.1: Increase recent_trades buffer and extend pruning window

File: `bot/data_feed.py`

Line 17: Change `deque(maxlen=5000)` to `deque(maxlen=50000)`.

Line 77: Change pruning window from 60_000ms to 300_000ms:
```python
while self.recent_trades and (now_ms - self.recent_trades[0]['time']) > 300_000:
```

### Step 1.2: Fix wall data routing — pass structured data instead of string round-trip

File: `bot/quant_engine.py` — `compute_metrics()` return dict

Add two new keys to the metrics dict:
```python
"nearest_buy_wall": nearest_bid,   # float or None
"nearest_sell_wall": nearest_ask,   # float or None
"top_buy_walls": top_bids,          # list of (price, size) tuples
"top_sell_walls": top_asks,         # list of (price, size) tuples
```

File: `bot/main.py` — `_detect_regime()`, `_detect_liquidity_sweep()`, `_risk_engine()`

Change these functions to accept `metrics` dict directly and read `nearest_buy_wall` / `nearest_sell_wall` instead of parsing the `allWalls` string. Remove the `_parse_walls()` function.

File: `bot/main.py` — `_detect_liquidity_sweep()`

Change wall source from `buy_walls[0]` / `sell_walls[0]` (which were size-sorted, not distance-sorted) to `metrics["nearest_buy_wall"]` / `metrics["nearest_sell_wall"]` (which are distance-sorted, i.e. closest to current price).

### Step 1.3: Fix LIQUIDITY regime over-triggering

File: `bot/main.py` — `_detect_regime()`, lines 540-549

Change the wall proximity threshold:
```python
WALL_PROXIMITY = max(0.3 * atr_val / price, 0.003)
```
Was: `max(0.5 * atr_val / price, 0.001)`. At BTC $77K, old = $7.70 distance, new = ~$231 distance.

Add wall significance filter — only override HMM to LIQUIDITY if the nearest wall size is >= 3× the median order book level:
```python
median_level = statistics.median(list(valid_bids.values()) + list(valid_asks.values())) if (valid_bids and valid_asks) else 0
near_wall_size = 0
if near_wall == nearest_bid:
    near_wall_size = valid_bids.get(nearest_bid, 0)
elif near_wall == nearest_sell:
    near_wall_size = valid_asks.get(near_sell, 0)
if near_wall and near_wall_size >= median_level * 3 and (abs(price - near_wall) / price) <= WALL_PROXIMITY:
    # LIQUIDITY override
```

Add import: `import statistics` at top of file.

Add LIQUIDITY regime duration cap — if LIQUIDITY has been the regime for more than 3 consecutive cycles without a sweep confirmation, fall through to HMM:
```python
# Module-level counter
_liquidity_consecutive = 0

# Inside _detect_regime, after LIQUIDITY override:
global _liquidity_consecutive
if regime == "LIQUIDITY":
    _liquidity_consecutive += 1
    if _liquidity_consecutive > 3 and sweep is None:
        logger.info("[Regime] LIQUIDITY cap reached — falling through to HMM")
        _liquidity_consecutive = 0
        # Fall through to HMM classification
    else:
        return regime
else:
    _liquidity_consecutive = 0
```

Inject `sweep` parameter into `_detect_regime()` call in `_compute_signal()`.

---

## PHASE 2 — GATE REBALANCING (Deploy one at a time, 4 hours minimum between each)

### Step 2.1: Relax sweep confirmation from 3/3 to 2/3

File: `bot/main.py` — `_strategy_liquidity_sweep()`, lines 722-739

Change `confirms >= 3` to `confirms >= 2` in both the `BELOW_LOWS` and `ABOVE_HIGHS` branches.

**VERIFY ON TESTNET FOR 4 HOURS BEFORE PROCEEDING.** Check `gate_stats` for `sweep_confirms_failed` count reduction.

### Step 2.2: Reduce HMM confidence gate from 70% to 60%

File: `bot/main.py` — `_HMMRegimeClassifier.MIN_CONFIDENCE`, line 291

Change `MIN_CONFIDENCE = 0.70` to `MIN_CONFIDENCE = 0.60`.

**VERIFY ON TESTNET FOR 4 HOURS BEFORE PROCEEDING.**

### Step 2.3: Reduce LIQUIDITY min_confidence from 62% to 55%

File: `bot/signal_config.py` — `REGIME_PARAMS["LIQUIDITY"]["min_confidence"]`, line 113

Change from `0.62` to `0.55`.

**VERIFY ON TESTNET FOR 4 HOURS BEFORE PROCEEDING.**

### Step 2.4: Add micro-confirms bypass for OFI+CVD alignment

File: `bot/main.py` — `_strategy_trend()`, around line 667

Change the micro_confirms gate:
```python
# BEFORE:
if micro_confirms < 2 and score < 3.0:
    return None

# AFTER:
ofi_cvd_aligned = (is_long and ofi > 0.15 and cvd > 0) or (not is_long and ofi < -0.15 and cvd < 0)
if micro_confirms < 2 and score < 3.0 and not ofi_cvd_aligned:
    logger.info(f"[TrendStrategy] score={score:+.2f} rejected (micro_confirms={micro_confirms}/3, OFI+CVD not aligned)")
    return None
```

**VERIFY ON TESTNET FOR 4 HOURS BEFORE PROCEEDING.**

### Step 2.5: Add mild confidence boost for ULIS NEUTRAL verdict

File: `bot/main.py` — `_apply_ulis_gate()`, around line 961

Change ULIS NEUTRAL confidence_boost from 0.0 to +0.03:
```python
elif verdict == "NEUTRAL":
    confidence_boost = 0.03  # Was 0.0 — mild "no objection" nudge
```

**VERIFY ON TESTNET FOR 4 HOURS BEFORE PROCEEDING.**

---

## PHASE 3 — RISK ENGINE FIXES (Deploy after Phase 2 produces ≥2 trades/hour on testnet)

### Step 3.1: Add daily reset for drawdown halt

File: `bot/main.py` — `execution_loop()`, inside the midnight reset block (~line 1451)

Add:
```python
if stats.get("drawdown_halt"):
    stats["drawdown_halt"] = False
    stats["session_pnl"] = 0.0
    logger.warning("[RiskEngine] New day — drawdown halt LIFTED, session PnL reset.")
```

Also, add `"session_pnl": 0.0` to the `BOT_STATS` dict initialisation (~line 139) to ensure it exists from the start.

### Step 3.2: Add minimum account size warning at startup

File: `bot/main.py` — `execution_loop()`, after `ACCOUNT_SIZE` is fetched (~line 1403)

Add:
```python
EQUITY_MIN_TRADEABLE = 200.0  # Minimum USD for reliable single-pair BTC/USDT futures trading
if ACCOUNT_SIZE < EQUITY_MIN_TRADEABLE:
    logger.warning(
        f"[RiskEngine] ⚠️ Account ${ACCOUNT_SIZE:.2f} below recommended minimum "
        f"(${EQUITY_MIN_TRADEABLE:.0f}). Trade sizing may fail or be suboptimal. "
        f"Consider increasing deposit."
    )
    if executor.notifier:
        await executor.notifier.send_message(
            f"⚠️ Low Equity Warning: ${ACCOUNT_SIZE:.2f} (min recommended: ${EQUITY_MIN_TRADEABLE:.0f})"
        )
```

### Step 3.3: Fix consecutive loss halt — reduce from 3 losses in a row to 3 losses within 30 minutes

File: `bot/signal_config.py`

Change `CONSECUTIVE_LOSS_HALT = 3` to `CONSECUTIVE_LOSS_HALT = 3` (keep value, but change semantics in `main.py`).

File: `bot/main.py` — execution_loop, the consecutive loss tracking block (~line 1579)

Change from tracking absolute consecutive to tracking within a rolling window:
```python
# Replace the simple counter with a timestamp-based check
loss_times = stats.get("loss_times", [])
now = time.time()
loss_times = [t for t in loss_times if now - t < 1800]  # Keep only last 30 min
if pnl < 0:
    loss_times.append(now)
stats["loss_times"] = loss_times

if len(loss_times) >= 3:
    stats["cooldown_until"] = time.time() + 1800
    stats["loss_times"] = []
    # ... existing halt message ...
```

This prevents the bot from being permanently halted if losses are spaced hours apart.

---

## PHASE 4 — OFI PIPELINE TUNING (Deploy after Phase 3 stable)

### Step 4.1: Adjust OFI EWMA parameters conservatively

File: `bot/quant_engine.py` — `_lob_metrics()`, lines ~484-492

Change:
```python
LAMBDA_EWMA = 0.94    # Was 0.97. Half-life: ~11 obs (~2.8 min) instead of ~23 obs (~5.7 min)
```

Change:
```python
ALPHA_SMOOTH = 0.35    # Was 0.30. Slightly faster signal response
```

Keep `mad_threshold` at `3.5 * 1.4826 * mad` — do NOT reduce to 2.5. The review correctly identifies that reducing MAD threshold lets noise through.

**VERIFY ON TESTNET FOR 8 HOURS.** Compare OFI value distribution before and after change. Ensure OFI > 0.15 fires at least 10% of cycles in trending markets.

### Step 4.2: Seed HMM observations from REST historical candles on startup

File: `bot/main.py` — after `await feed._fetch_historical_candles_rest()` succeeds

Add a function that pre-computes ATR%, |Z-score| estimates, and tape proxies from the 100 REST candles and feeds them as initial observations to `_hmm_classifier`:
```python
def _seed_hmm_from_history(candles, hmm_classifier):
    if len(candles) < 20:
        return
    closes = [c['close'] for c in candles]
    highs = [c['high'] for c in candles]
    lows = [c['low'] for c in candles]
    vols = [c['volume'] for c in candles]
    for i in range(20, len(candles)):
        window_closes = closes[max(0,i-50):i+1]
        atr_pct = (highs[i] - lows[i]) / closes[i] if closes[i] > 0 else 0.005
        z_approx = abs((closes[i] - sum(window_closes)/len(window_closes)) /
                       (np.std(window_closes) + 1e-9))
        tape = "NORMAL"
        hmm_classifier.classify(atr_pct, z_approx, tape, atr_pct_rank=0.5)
    logger.info(f"[HMM] Seeded with {len(candles)-20} historical observations.")
```

Call this in `main()` after feed warmup and quant engine initialization.

---

## PHASE 5 — BAYESIAN AND CONFIGURATION FIXES (Deploy after Phase 4)

### Step 5.1: Fix Bayesian prior cold-start

File: `bot/signal_config.py`

Add cold-start constants:
```python
COLD_START_TRADE_COUNT = 30
COLD_START_CONFIDENCE_DISCOUNT = 0.05
```

File: `bot/main.py` — `_compute_signal()`, after regime_p is loaded

Replace:
```python
regime_min_conf = regime_p["min_confidence"]
```

With:
```python
total_trades = sum(quant.get_regime_trade_counts().values())
cold_start_discount = COLD_START_CONFIDENCE_DISCOUNT if total_trades < COLD_START_TRADE_COUNT else 0.0
regime_min_conf = regime_p["min_confidence"] - cold_start_discount
```

### Step 5.2: Remove dead configuration variable

File: `bot/main.py` — line 87

`MIN_CONFIDENCE = float(os.environ.get("BOT_MIN_CONFIDENCE", "0.62"))` is displayed in the startup banner but never used as an actual gate. The active gate is `regime_p["min_confidence"]`. Either:

Option A (recommended): Wire `MIN_CONFIDENCE` as a floor:
```python
regime_min_conf = max(regime_p["min_confidence"] - cold_start_discount, MIN_CONFIDENCE * 0.8)
```

Option B: Remove `MIN_CONFIDENCE` from the startup banner and add a comment that per-regime thresholds are the active gates.

Choose Option A.

### Step 5.3: Fix sweep candle age gate — reduce from 30+ minutes to 2 candles

File: `bot/main.py` — `_compute_signal()`, lines 1197-1204

Change:
```python
max_sweep_age = 1800 + gate_sec
```

To:
```python
max_sweep_age = 900 + gate_sec  # Current candle duration + gate, NOT 1800+gate
```

Was 1800+45=1845 seconds (~30 minutes). Change to 900+45=945 seconds (~15 minutes = 1 full candle). A sweep from 2+ candles ago should not be actionable.

---

## PHASE 6 — FIREBASE AND INFRASTRUCTURE (Deploy independently)

### Step 6.1: Batch Firestore writes with exponential backoff

File: `bot/heartbeat.py`

Add a write buffer that aggregates stats updates and flushes every 5 minutes instead of every 15 seconds. On 429 error, exponential backoff: 30s, 60s, 120s, 300s, 300s...

Add local JSON fallback: if 3 consecutive Firestore writes fail, switch to writing to `/tmp/quad_bot_trades.jsonl` for trade records and `/tmp/quad_bot_stats.json` for stats.

### Step 6.2: Add per-gate rejection summary logging

(Already covered by Step 0.1 — included here for completeness.)

### Step 6.3: Add daily performance telemetry log

File: `bot/main.py` — inside the midnight reset block

Add:
```python
logger.info(
    f"[DailyReport] Trades={stats.get('total_trades',0)} | "
    f"Daily PnL=${stats.get('daily_pnl',0):.2f} | "
    f"Session PnL=${stats.get('session_pnl',0):.2f} | "
    f"Drawdown=${ACCOUNT_SIZE*MAX_DRAWDOWN_PCT/100:.2f} | "
    f"Gate rejects={stats.get('gate_stats',{})}"
)
if executor.notifier:
    await executor.notifier.send_message(
        f"📊 Daily Report: {stats.get('total_trades',0)} trades | "
        f"PnL: ${stats.get('daily_pnl',0):.2f} | Session: ${stats.get('session_pnl',0):.2f}"
    )
```

---

## PHASE 7 — EXECUTION HARDENING (Deploy after bot is trading ≥2 trades/hour)

### Step 7.1: Add exchange-side position reconciliation on startup and every 5 minutes

File: `bot/executor.py` — `initialize()` method

After the boot position check, store any found positions:
```python
self._exchange_positions_cache = positions  # Store for later reconciliation
```

In `execution_loop`, add a periodic reconciliation every 300 seconds:
```python
if int(time.time()) % 300 < ANALYSIS_INTERVAL and not executor.dry_run:
    try:
        positions = await executor.exchange.fetch_positions()
        exchange_has_pos = any(abs(float(p.get("contracts",0) or p.get("positionAmt",0))) > 0.0001 for p in positions)
        bot_has_pos = executor.active_position is not None
        if exchange_has_pos and not bot_has_pos:
            logger.critical("[Reconciliation] EXCHANGE has open position but BOT does not. Manual intervention required.")
            await executor.notifier.send_error_alert("⚠️ Position mismatch: exchange open, bot closed.")
        elif not exchange_has_pos and bot_has_pos:
            logger.critical("[Reconciliation] BOT thinks position open but EXCHANGE does not. Clearing stale state.")
            executor.active_position = None
            executor.pending_order = None
    except Exception as e:
        logger.warning(f"[Reconciliation] Check failed: {e}")
```

### Step 7.2: Add partial fill handling

File: `bot/executor.py` — in `execute_signal()` after order placement (~line 875)

Add:
```python
filled = float(order.get('filled') or order.get('amount', 0) or fmt_size)
if filled < fmt_size * 0.95:
    logger.warning(f"[Executor] Partial fill detected: {filled:.6f}/{fmt_size:.6f}")
    if self.notifier:
        await self.notifier.send_error_alert(
            f"⚠️ Partial fill: {filled:.6f}/{fmt_size:.6f} on {side} {ex_symbol}"
        )
    # Adjust position size to actual fill
    fmt_size = filled
```

### Step 7.3: Add SL order status monitoring

File: `bot/executor.py` — in `check_position_exit()`

For live positions, every 60 seconds, poll the SL order status:
```python
if not self.dry_run and pos and pos.get("sl_order_id"):
    try:
        sl_status = await self.exchange.fetch_order(pos["sl_order_id"], pos["symbol"])
        if sl_status.get("status") in ("canceled", "cancelled", "expired"):
            logger.critical(f"[Executor] SL order {pos['sl_order_id']} is {sl_status['status']}! Flattening position.")
            await self.notifier.send_error_alert(
                f"🚨 SL order CANCELED/EXPIRED for {pos['side']} {pos['symbol']}. Emergency flatten."
            )
            close_side = "sell" if pos["side"] == "buy" else "buy"
            await self.exchange.create_market_order(pos["symbol"], close_side, pos["size"])
            self.active_position = None
            self.pending_order = None
            return True, 0.0
    except Exception as e:
        logger.warning(f"[Executor] SL status check failed: {e}")
```

---

## DEPLOYMENT SEQUENCE

| Order | Step | Dependency | Testnet Verification |
|-------|-------|------------|---------------------|
| 1 | 0.1–0.4 | None | Verify gate_stats logs appear; verify execution_price differs from candle close; verify funding_rate updates every 60s |
| 2 | 1.1–1.3 | Phase 0 | Verify CVD is non-zero; verify walls are distance-sorted not size-sorted; verify LIQUIDITY regime fires <20% of cycles |
| 3 | 2.1 | Step 1.3 | Verify sweep signals produce trades; check `sweep_confirms_failed` counter drops |
| 4 | 2.2 | Step 2.1 | Verify HMM transitions faster; check `regime_neutral_conf` counter drops |
| 5 | 2.3 | Step 2.2 | Verify LIQUIDITY regime signals reach execution more often |
| 6 | 2.4 | Step 2.3 | Verify trend signals pass when OFI+CVD agree |
| 7 | 2.5 | Step 2.4 | Verify NEUTRAL ULIS verdict no longer penalises confidence |
| 8 | 3.1–3.3 | Phase 2 stable at ≥2 trades/hour | Verify drawdown resets daily; verify loss halt uses rolling 30min window |
| 9 | 4.1–4.2 | Phase 3 | Verify OFI values exceed ±0.15 more frequently; verify HMM seeds from history |
| 10 | 5.1–5.3 | Phase 4 | Verify cold-start trades appear within 5 minutes of boot |
| 11 | 6.1–6.3 | Any time | Verify Firebase 429 errors stop or reduce by 90%+ |
| 12 | 7.1–7.3 | Phase 2 stable at ≥2 trades/hour live | Verify position reconciliation runs cleanly |

---

## ROLLBACK CRITERIA

- If any step produces a **live loss rate >60% over 20 trades**, revert that step and the previous step.
- If **daily loss exceeds 6% of account equity** (2× the intended 3% cap), halt the bot and revert to the last known-good configuration.
- If **Firebase is down for >1 hour**, the local JSON fallback must be verified to be receiving trade records.
- If **trade frequency drops below 1 trade per 4 hours** after any step, revert that step.

---

## ITEMS EXPLICITLY REMOVED FROM ORIGINAL AUDIT

| Original Item | Reason for Removal |
|---------------|---------------------|
| P-01 batch gate changes | Replaced by sequential Steps 2.1–2.5 with 4-hour verification between each |
| P-08 multi-timeframe (5-min loop) | Using 15-minute candle data on a 5-minute interval produces duplicate signals — requires a separate WS subscription to `@kline_5m` and a second QuantEngine. Too complex for Phase 1. Revisit after account size ≥$500. |
| P-13 multi-pair expansion | $86 account cannot support multi-pair futures trading with minimum notional constraints. Revisit after account size ≥$500. |
| P-09 Beta(9,7) prior change | Beta(7,5) is acceptable with the cold-start discount in Step 5.1. Changing the prior introduces a different calibration problem. |
| P-14 dry-run slippage reduction | Cosmetic. Does not affect live trading. Revisit only if dry-run validation discrepancy is blocking testnet sign-off. |
| P-15 funding_mult TP symmetry | Mathematically unnecessary. Risk-reward ratio = TP_MULT regardless of SL width, because both numerator and denominator scale equally. Funding_mult widens the stop but preserves the RR ratio. |
| F-08 survival probability calculation (1.8%) | Statistically invalid — gates are conditionally correlated through shared metrics, not independent. Cannot multiply individual rejection rates. Replaced by empirical measurement via gate_stats counters. |
| "30-50 trades/day" target | Physical ceiling is 96 daily candles at 15m interval. With ~30% per-candle pass rate, expected is ~29 trades/day. Target corrected to **2-4 trades/hour initially, 20-30 trades/day steady state**. |

---

## ITEMS ADDED FROM CRITICAL REVIEW

| Step | Source | Addition |
|------|--------|----------|
| 0.4 | M-1 | Use order book mid-price for execution, not kline close |
| 1.2 | M-8 | Fix wall data routing — pass structured data, not string round-trip |
| 3.1 | M-5 | Drawdown halt must reset daily, not require manual restart |
| 3.2 | B-1 (review) | Add equity minimum warning at startup |
| 3.3 | B-1 (review) | Consecutive loss halt uses rolling 30-min window, not absolute count |
| 5.3 | M-3 | Sweep age gate reduced from 30+ minutes to 15 minutes |
| 6.1 | F-03 | Local JSON fallback for Firestore failures |
| 7.1–7.3 | F-11 | Exchange position reconciliation, partial fill handling, SL order monitoring |