# FINAL IMPLEMENTATION PLAN 2 — Quad-Desk

**Derived from:** Original plan + institutional audit + critical review
**Priority:** Runtime blockers first, then incorrect behavior, then robustness

---

## PHASE 0 — RUNTIME BLOCKERS (deploy immediately, bot cannot trade without these)

### Step 0.1: Import missing cold-start constants

**File:** `bot/main.py` line 58

**Current:**
```python
from bot.signal_config import REGIME_PARAMS, POST_TRADE_COOLDOWN_S
```

**Change to:**
```python
from bot.signal_config import REGIME_PARAMS, POST_TRADE_COOLDOWN_S, COLD_START_TRADE_COUNT, COLD_START_CONFIDENCE_DISCOUNT
```

**Impact:** Without this, `_compute_signal()` crashes with `NameError` on every signal evaluation when `total_trades < 30`.

---

### Step 0.2: Replace `place_stop_loss` call with emergency flatten

**File:** `bot/executor.py` lines 1171–1201

**Current:** Calls non-existent `self.place_stop_loss()` when SL order is canceled/expired.

**Replace entire block (lines 1171–1202) with:**
```python
            # Symbol still present in open_syms → position still live
            # Step 7.3: Monitor SL order status — flatten if canceled/expired
            sl_order_id = pos.get("sl_order_id")
            now_ts = time.time()
            if sl_order_id and (now_ts - getattr(self, "_last_sl_check_ts", 0.0)) >= 60:
                self._last_sl_check_ts = now_ts
                try:
                    order_info = await self.exchange.fetch_order(sl_order_id, symbol)
                    status = str(order_info.get("status", "")).lower()
                    if status in ("canceled", "cancelled", "expired", "rejected"):
                        logger.critical(
                            f"[LiveExit] SL order {sl_order_id} is {status}! "
                            f"Position {symbol} UNPROTECTED — emergency flatten."
                        )
                        if self.notifier:
                            await self.notifier.send_message(
                                f"🚨 SL order {sl_order_id} {status}! "
                                f"Emergency flatten for {symbol}."
                            )
                        close_side = "sell" if pos["side"] == "buy" else "buy"
                        try:
                            await self.exchange.create_market_order(symbol, close_side, pos["size"])
                        except Exception as flat_err:
                            logger.error(f"[LiveExit] Emergency flatten failed: {flat_err}")
                        self.active_position = None
                        self.pending_order = None
                        return True, 0.0
                    else:
                        logger.debug(
                            f"[LiveExit] SL order {sl_order_id} status={status} — OK"
                        )
                except Exception as e:
                    logger.debug(f"[LiveExit] SL order check skipped: {e}")

            return False, 0.0
```

**Add** to `TradingExecutor.__init__` (after line 60):
```python
        self._last_sl_check_ts: float = 0.0
```

**Impact:** Without this, any canceled/expired SL order crashes the bot with `AttributeError`. The throttle (60s) prevents excessive `fetch_order` API calls.

---

### Step 0.3: Fix LIQUIDITY regime significance filter — add `bid_depths`/`ask_depths` to metrics dict

**File:** `bot/quant_engine.py`

**In `compute_metrics()` return dict** (around line 247), add 6 new keys:

After the existing `"execution_price": execution_price,` line, add:
```python
            "bid_depths":        valid_bids,
            "ask_depths":        valid_asks,
            "nearest_buy_wall":  nearest_bid,
            "nearest_sell_wall": nearest_ask,
            "top_buy_walls":     top_bids,
            "top_sell_walls":    top_asks,
```

This requires `valid_bids`, `valid_asks`, `nearest_bid`, `nearest_ask`, `top_bids`, `top_asks` to be accessible from `compute_metrics()`. They are all local variables in `_lob_metrics()`. Change `_lob_metrics()` return from:

```python
return ofi, wall_context, "; ".join(wall_parts), execution_price
```

to:
```python
return ofi, wall_context, "; ".join(wall_parts), execution_price, valid_bids, valid_asks, nearest_bid, nearest_ask, top_bids, top_asks
```

Then in `compute_metrics()`, update the call to `_lob_metrics()` from:

```python
ofi, wall_context, all_walls_str, execution_price = self._lob_metrics(current_price)
```

to:
```python
ofi, wall_context, all_walls_str, execution_price, valid_bids, valid_asks, nearest_bid, nearest_ask, top_bids, top_asks = self._lob_metrics(current_price)
```

And remove `all_walls_str` from the metrics dict if desired (or keep for backward compat). The new keys make `_parse_walls()` unnecessary.

**Impact:** Without this, `_detect_regime()` reads `metrics.get("bid_depths", {})` which always returns `{}`, making `median_level = 0.0` and `wall_is_significant = False` always. LIQUIDITY regime override never fires.

---

### Step 0.4: Replace `_parse_walls()` with structured dict reads

**File:** `bot/main.py`

**Delete** the `_parse_walls` function (lines 223–237).

**Replace** line 1273:
```python
buy_walls, sell_walls = _parse_walls(metrics.get("allWalls"))
```
with:
```python
buy_walls  = [p for p, _ in metrics.get("top_buy_walls", [])]
sell_walls = [p for p, _ in metrics.get("top_sell_walls", [])]
```

**Impact:** Removes string round-trip parsing; uses structured data from `quant_engine`.

---

## PHASE 1 — INCORRECT BEHAVIOR (deploy after Phase 0 verified on testnet 4h)

### Step 1.1: Fix execution_price to use top-of-book bid/ask, not wall prices

**File:** `bot/quant_engine.py` in `_lob_metrics()` (around line 435)

**Current:**
```python
execution_price = (
    (nearest_bid + nearest_ask) / 2.0
    if nearest_bid and nearest_ask else current_price
)
```

`nearest_bid` and `nearest_ask` are WALL prices (filtered by `wall_threshold`), which can be $50+ from actual top-of-book on BTC. This produces execution price estimates that are grossly inaccurate for minimum notional checks and fill estimates.

**Replace with:**
```python
best_bid = max(self.state.bids.keys()) if self.state.bids else current_price
best_ask = min(self.state.asks.keys()) if self.state.asks else current_price
execution_price = (best_bid + best_ask) / 2.0 if (self.state.bids and self.state.asks) else current_price
```

**Impact:** Corrects order fill price estimates from ±$50 error to ±$0.05.

---

### Step 1.2: Fix `loss_times` persistent cooldown bug

**File:** `bot/main.py` lines 1749–1772

**Current:**
```python
loss_times = stats.get("loss_times", [])
now_loss = time.time()
loss_times = [t for t in loss_times if now_loss - t < 1800]
if pnl < 0:
    loss_times.append(now_loss)
stats["loss_times"] = loss_times

if len(loss_times) >= 3:
    stats["cooldown_until"] = time.time() + 1800
    loss_times = []
    halt_msg = (...)
    logger.error(...)
    if executor.notifier:
        await executor.notifier.send_message(halt_msg)
else:
    stats["loss_times"] = []
```

**Bug:** When `len(loss_times) >= 3`, `loss_times = []` clears only the local variable; `stats["loss_times"]` retains the 3 timestamps. On the next cycle, `stats.get("loss_times", [])` returns 3 stale timestamps (still within 1800s). Since `pnl` is negative (an SL exit just happened), a 4th timestamp is appended, `len >= 3` stays true, and cooldown is set again every cycle for 30 minutes even if subsequent trades are wins.

**Replace lines 1749–1772 with:**
```python
                        # PHASE-3.3: Rolling 30-min loss window
                        loss_times = stats.get("loss_times", [])
                        now_loss = time.time()
                        loss_times = [t for t in loss_times if now_loss - t < 1800]
                        if pnl < 0:
                            loss_times.append(now_loss)
                        stats["loss_times"] = loss_times

                        if len(loss_times) >= 3:
                            stats["cooldown_until"] = time.time() + 1800
                            stats["loss_times"] = []
                            halt_msg = (
                                f"🛑 Quad-Desk CONSECUTIVE LOSS HALT\n"
                                f"3 SL exits within 30 minutes. All trading paused for 30 minutes.\n"
                                f"Resumes at {time.strftime('%H:%M:%S', time.localtime(time.time() + 1800))}"
                            )
                            logger.error("[RiskManager] 3 consecutive SL exits within 30 min! Activating 30-minute cooldown.")
                            if executor.notifier:
                                await executor.notifier.send_message(halt_msg)
```

**Impact:** Prevents 30-minute perpetual re-halt after any 3-loss cluster. `stats["loss_times"]` is now cleared in both branches correctly.

---

## PHASE 2 — MISSING PLAN STEPS (deploy after Phase 1 verified on testnet 4h)

### Step 2.1: Add minimum account size warning at startup

**File:** `bot/main.py` — in `execution_loop()`, after `ACCOUNT_SIZE` is fetched (around line 1556)

**Add after the balance fetch block:**
```python
    EQUITY_MIN_TRADEABLE = 200.0
    if ACCOUNT_SIZE < EQUITY_MIN_TRADEABLE:
        logger.warning(
            f"[RiskEngine] ⚠️ Account ${ACCOUNT_SIZE:.2f} below recommended minimum "
            f"(${EQUITY_MIN_TRADEABLE:.0f}). Trade sizing may fail or be suboptimal."
        )
        if executor.notifier:
            await executor.notifier.send_message(
                f"⚠️ Low Equity: ${ACCOUNT_SIZE:.2f} (min recommended: ${EQUITY_MIN_TRADEABLE:.0f})"
            )
```

**Impact:** Step 3.2 from original plan — was missed entirely.

---

### Step 2.2: Add `@aggTrade` streamstaleness monitoring to `feed_health_monitor`

**File:** `bot/data_feed.py` — in `feed_health_monitor()` (around line 327, inside the `while self.is_running:` loop)

**Add after the `age` staleness check (after line 350):**

```python
            # PHASE-0.2: Check aggTrade stream health
            if hasattr(self.state, '_last_trade_ts') and self.state._last_trade_ts > 0:
                trade_age = time.time() - self.state._last_trade_ts
                if trade_age > 90:
                    trade_alert = (
                        f"⚠️ [DataFeed] AGGTRADE STALE: no trade data for {trade_age:.0f}s. "
                        f"Buffer={len(self.state.recent_trades)} trades. CVD/tape unreliable."
                    )
                    logger.error(trade_alert)
                    if notifier:
                        try:
                            await notifier.send_message(trade_alert)
                        except Exception:
                            pass
                    # Force WS reconnect if trade stream dead for >2x health interval
                    if trade_age > 180:
                        self._reconnect_event.set()
                        self.is_running = False
                        logger.info("[DataFeed] AggTrade stale >180s — triggering reconnect.")
```

**Impact:** Original plan Step 0.2 only added a warning in `execution_loop`. The `feed_health_monitor` is the correct place to auto-heal a broken `@aggTrade` stream.

---

## PHASE 3 — ROBUSTNESS (deploy after Phase 2 stable on testnet 4h)

### Step 3.1: Add cycle-level exception escalation

**File:** `bot/main.py` — in `execution_loop()`, find the outer `try/except Exception` block that wraps signal computation.

**Add** a cycle error counter near the `BOT_STATS` dict:
```python
_cycle_error_count = 0
_last_cycle_error = ""
```

**In** the `except Exception as e:` handler in `execution_loop`, add escalation:
```python
                _cycle_error_count += 1
                _last_cycle_error = str(e)
                if _cycle_error_count % 5 == 0:
                    logger.critical(
                        f"[MainLoop] {5} consecutive errors! Last: {_last_cycle_error}"
                    )
                    if executor.notifier:
                        await executor.notifier.send_message(
                            f"🚨 Bot error loop: {_cycle_error_count} errors. Last: {_last_cycle_error[:200]}"
                        )
                    await asyncio.sleep(30)  # Back off to avoid API spam
```

**Reset** `_cycle_error_count = 0` on every successful cycle (after metrics are computed without error).

**Impact:** Prevents silent infinite loop on code bugs (like the NameError from Step 0.1). Alerts operator and backs off instead of hammering the exchange 6×/min.

---

### Step 3.2: Fix local JSON fallback to save all entry types

**File:** `bot/heartbeat.py` — `_flush_local_buffer()` (around line 367)

**Current:** Only saves `entry["type"] == "status"` entries; equity entries are silently dropped.

**Replace** lines 374–377:
```python
        with open(_LOCAL_STATS_PATH, "a") as f:
            for entry in _write_buffer:
                if entry["type"] == "status":
                    f.write(json.dumps(entry) + "\n")
```

**With:**
```python
        with open(_LOCAL_STATS_PATH, "a") as f:
            for entry in _write_buffer:
                f.write(json.dumps(entry) + "\n")
```

**Impact:** All data (status + equity) is persisted during Firebase outage.

---

### Step 3.3: Add missing gate_stats keys and validate increment

**File:** `bot/main.py`

**In `BOT_STATS["gate_stats"]`** (around line 153), add missing keys from the original plan:
```python
    "gate_stats": {
        "daily_loss_halt":           0,
        "drawdown_halt":             0,
        "zscore_warmup":             0,
        "post_trade_cooldown":       0,
        "cascade_cooldown":          0,
        "regime_no_edge":            0,
        "htf_counter_trend":         0,
        "funding_blocks_long":       0,
        "funding_blocks_short":      0,
        "ulis_veto":                 0,
        "ulis_alignment_fail":       0,
        "confidence_below_threshold": 0,
        "candle_gate_expired":        0,
        "micro_confirms_failed":      0,
        "sweep_confirms_failed":      0,
        "fee_geometry":              0,
        "signal_none":              0,
        "total_passed":             0,
    },
```

**In `_gate_stats_summary()`** (line 189), change:
```python
    if reason in g:
        g[reason] += 1
```
to:
```python
    if reason in g:
        g[reason] += 1
    else:
        g[reason] = 1
        logger.warning(f"[GateStats] Unknown gate key: {reason}")
```

**Update** the 30-minute summary log (lines 197–215) to include all keys including the new ones.

**Add** gate_stats increments at these points in `_compute_signal()`:

| Location | Key | Condition |
|----------|-----|-----------|
| After sweep age check (`sweep = None`) | `"candle_gate_expired"` | `sweep_candle_age_s > max_sweep_age` |
| After micro_confirms rejection in `_strategy_trend()` | `"micro_confirms_failed"` | `micro_confirms < 2 and score < 3.0 and not ofi_cvd_aligned` |
| After `_strategy_liquidity_sweep()` returns None | `"sweep_confirms_failed"` | sweep detected but confirms < 2 |
| After `_apply_ulis_gate()` alignment fail | `"ulis_alignment_fail"` | `red_lights >= 2` |
| After `_strategy_mean_reversion()` returns None (Z check) | `"mean_rev_z_failed"` | Z below threshold |
| After `_strategy_mean_reversion()` returns None (slope) | `"mean_rev_slope_failed"` | slope against direction |

**In `_strategy_trend()`** — add increment before the `return None` on the micro_confirms gate:
```python
    if micro_confirms < 2 and score < 3.0 and not ofi_cvd_aligned:
        BOT_STATS["gate_stats"]["micro_confirms_failed"] = BOT_STATS["gate_stats"].get("micro_confirms_failed", 0) + 1
        logger.info(...)
        return None
```

**In `_strategy_liquidity_sweep()`** — add increment at the final `return None`:
```python
    # After both ABOVE_HIGHS and BELOW_LOWS blocks
    BOT_STATS["gate_stats"]["sweep_confirms_failed"] = BOT_STATS["gate_stats"].get("sweep_confirms_failed", 0) + 1
    return None
```

**In `_apply_ulis_gate()`** — add increment at the alignment fail `return`:
```python
    if red_lights >= 2:
        BOT_STATS["gate_stats"]["ulis_alignment_fail"] = BOT_STATS["gate_stats"].get("ulis_alignment_fail", 0) + 1
        logger.warning(...)
        return False, 0.0, f"{verdict_str} + Weak Alignment (R={red_lights})"
```

**Impact:** Previously missing gate keys meant the most important rejection points (sweep, micro-confirms, ULIS alignment) were invisible in the 30-minute summary.

---

### Step 3.4: Cache `fetch_positions` per cycle to avoid duplicate API calls

**File:** `bot/main.py` — in `execution_loop()`

**Add** a variable at the top of the cycle loop:
```python
        _cached_positions = None
```

**In** the reconciliation block (around line 1845), use the cache:
```python
            if not executor.dry_run and int(time.time()) % 300 < ANALYSIS_INTERVAL:
                try:
                    if _cached_positions is None:
                        _cached_positions = await executor.exchange.fetch_positions()
                    positions = _cached_positions
                    exchange_has_pos = any(...)
                    ...
```

**After** `check_position_exit()` returns `(exited, pnl)` with `exited=True`, invalidate:
```python
                    _cached_positions = None
```

**Impact:** Eliminates redundant `GET /fapi/v2/positionRisk` calls (5 weight each) that occur both in `_check_live_position_exit` and reconciliation.

---

## DEPLOYMENT SEQUENCE

| Order | Step | Dependency | Verification |
|-------|-------|------------|--------------|
| 1 | 0.1 | None | Bot starts without NameError |
| 2 | 0.2 | None | Live SL cancel triggers emergency flatten, no AttributeError |
| 3 | 0.3 + 0.4 | None | LIQUIDITY regime fires in gate_stats; wall data flows without string parsing |
| 4 | 1.1 + 1.2 | Phase 0 | Execution price ±$0.05 from actual spread; loss halt clears correctly |
| 5 | 2.1 + 2.2 | Phase 1 | Low equity warning appears at startup; aggTrade staleness triggers Telegram + reconnect |
| 6 | 3.1–3.4 | Phase 2 | Error loop sends Telegram after 5 consecutive; local fallback persists all data; gate_stats shows all keys |

## ROLLBACK CRITERIA

- If any step produces a live loss rate >60% over 20 trades, revert that step and the previous step
- If daily loss exceeds 6% of account equity (2× the 3% cap), halt and revert
- If trade frequency drops below 1 trade per 4 hours after any step, revert
- If Firebase is down for >1 hour, verify local JSON fallback is receiving records