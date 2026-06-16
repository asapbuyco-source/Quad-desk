# Engineering Vol Audit Validation And Implementation Plan

Source document: `C:\Users\pc\Downloads\Engineering_Vol_Audit_Report.pdf`  
Validation date: 2026-06-16  
Repo checked: `Quad-desk`

## Executive Assessment

The PDF is useful, but it is not fully current with this codebase. The strongest valid findings are around microstructure spoof resistance, RV/IV windowing, SQUEEZE routing, TREND time exits, and execution retry placement. The RSI finding is materially stale because current `bot/main.py` already has a TREND exhaustion gate. The TP-requeue finding is directionally right but technically wrong: the retry function is no longer heartbeat-only, yet the current main-loop call appears nested under the exit path, so it likely does not retry during normal open-position cycles.

## Finding Validation

| ID | PDF claim | Verdict | Evidence | Notes |
| --- | --- | --- | --- | --- |
| T-01 | TREND `time_exit_sec=1800` truncates winners at 2 candles | Valid | `bot/signal_config.py:140-151` | Base exit is 1800s, hard cap 3600s. `executor.check_time_exit()` can defer low-profit exits, but this is still short for the TREND mandate. |
| T-02 | RSI extremes are fully suppressed in TREND | Mostly stale | `bot/main.py:2609-2663` | The generic RSI halt is suppressed, but a TREND-specific exhaustion gate now blocks late longs/shorts unless z-ret, OFI, CVD delta, and tape confirm continuation. Consider strengthening, not creating from scratch. |
| V-01 | SQUEEZE params unreachable | Valid | `bot/signal_config.py:191-218`, `bot/main.py:651-694`, `bot/main.py:1036-1055` | `SQUEEZE` params exist, but HMM labels are only `RANGE/TREND/VOLATILE`; `amihud_rank` and `t_kinetic` are explicitly excluded from the HMM observation vector. `REGIME_ALIAS` maps literal `SQUEEZE` to `LIQUIDITY`, so the `SQUEEZE` params are not naturally selected. |
| V-02 | RV/IV discriminant uses a 30s tick window | Valid | `bot/quant_engine.py:132-169` | Recent trades are filtered to `<30_000ms`, with stale fallback if fewer than 5 prices. The tests also lock in this behavior. |
| S-01 | No cancel-velocity/order-lifetime tracker | Valid | `bot/data_feed.py:108-117`, `bot/quant_engine.py:819-837` | Depth state stores current top-20 books and total-depth deltas only. No per-price cancellation rate, trade-matched cancellation, order lifetime histogram, or ghost-wall flag exists. |
| S-02 | No Hawkes/self-excitation ignition monitor | Valid | `rg` found no implementation; tape metrics are volume-window based in `bot/quant_engine.py` | Current tape/CVD can identify aggression but not self-exciting burst-and-decay manipulation. |
| J-01 | 15s polling loop creates intrabar latency | Partly valid | `bot/main.py:104`, `bot/main.py:3250-3259` | Default interval is 15s and candle-close event is event-driven. The claim is true for mid-candle changes, but the bot already has zero-latency candle-close wakeups. |
| J-02 | SL/TP placement is sequential | Valid | `bot/executor.py:1397-1483` | Futures entry places SL first, activates position, then places TP. This protects downside before TP, but it is not atomic/OCO-style and can leave SL-only exposure. |
| J-03 | Failed TP requeue is heartbeat-only / up to 60s | Claim stale, bug still valid | `bot/executor.py:2404-2480`, `bot/main.py:3472-3481` | `attempt_tp_requeue()` says it is called every analysis cycle, but the current call is inside `if exited:`. That likely means no retry while the position remains open. Move it to the open-position path before/after exit checks. |

## Implementation Plan

### Phase 0 - Test Harness And Guardrails

1. Add focused regression tests before changing behavior:
   - `tests/test_quant_engine.py`: RV/IV supports configurable windows and uses 120s during high-vol mode.
   - `tests/test_data_feed.py` or new `tests/test_microstructure.py`: depth updates compute cancel velocity and ghost-wall flags.
   - `tests/test_executor.py`: TP requeue is invoked while a position remains open.
   - `tests/test_signal_config.py`: `SQUEEZE` params are reachable through a deterministic router.

2. Add a small fixture builder for depth snapshots and recent aggTrades so microstructure tests are deterministic and do not need network access.

### Phase 1 - Immediate Safety Fixes

1. Fix TP requeue placement:
   - Move `await executor.attempt_tp_requeue()` out of the `if exited:` branch in `bot/main.py`.
   - Run it once per active-position cycle when live and `requeue_tp_attempts > 0`.
   - Keep it before expensive reconciliation work so failed TP attachment is retried quickly.

2. Extend TREND hold policy:
   - Raise `REGIME_PARAMS["TREND"]["time_exit_sec"]` from `1800` to `5400`.
   - Set `time_exit_hard_cap_s` to at least `7200` or `10800`, depending on appetite.
   - Keep `executor.check_time_exit()` fee/profit deferral logic.
   - Add tests asserting TREND config differs from short-cycle regimes.

3. Strengthen, not replace, TREND exhaustion protection:
   - Keep the existing gate at `bot/main.py:2628-2663`.
   - Add RSI divergence inputs if available: `rsi_prev`, `rsi_prev2`, `zScore_ret`, and recent price slope.
   - Block late trend entries when RSI is extreme and momentum/tape are decelerating.

### Phase 2 - Microstructure Spoof Resistance

1. Add per-price depth tracking in `MarketState`:
   - Store previous bid/ask maps plus update timestamps.
   - For each update, compute size decreases by price level.
   - Cross-check nearby aggTrade fills over the same interval; classify unmatched fast disappearance as cancellation, not executed liquidity.

2. Emit ghost-wall metrics:
   - `ghost_wall_side`, `ghost_wall_price`, `ghost_cancel_rate`, `ghost_wall_active_until`.
   - Keep a short TTL, e.g. 5-15s, so one spoof event does not poison the regime for minutes.

3. Wire ghost-wall metrics into signal logic:
   - Reduce OFI weight or neutralize OFI when the nearest wall is flagged ghost.
   - Prevent `LIQUIDITY` hard override when the nearest significant wall is ghosted.
   - Log the reason in `analysis` so live decisions are auditable.

4. Add an ignition monitor:
   - Maintain recent aggTrade timestamps/sides/sizes.
   - Start with a robust burst detector before full Hawkes: rolling 500ms/5s arrival-rate z-score plus decay condition.
   - Later upgrade to exponential-kernel Hawkes if the simple detector proves useful in replay.
   - Veto TREND entries for 30-60s after ignition unless independent CVD/OFI continuation evidence persists.

### Phase 3 - Regime And Volatility Routing

1. Make SQUEEZE params reachable without pretending the current HMM is 4-state:
   - Add a deterministic router after HMM classification:
     - candidate when `atr_pct_rank >= 0.80`, `amihud_rank >= 0.80`, `abs(zScore) < 1.0`, and tape is `SCREAMING`.
     - return `"SQUEEZE"` only when confidence/confirmation passes.
   - Keep the 3-state HMM until calibrated data supports a true 4-state model.

2. Expand RV/IV windowing:
   - Add `RV_IV_WINDOW_MS_NORMAL = 30_000` and `RV_IV_WINDOW_MS_VOL = 120_000`.
   - Use the longer window when ATR rank is high, recent tape is sparse, or current regime is `VOLATILE`.
   - Update tests so sparse 30s data can still use a valid 120s tick sample before falling back to candle closes.

### Phase 4 - Execution Latency And Atomicity

1. Adaptive polling:
   - Keep candle-close event wakeup.
   - Use 2-5s timeout in `TREND`, `VOLATILE`, `LIQUIDITY`, and `SQUEEZE`.
   - Use 15-30s in stable `RANGE` with no active position.

2. SL/TP attachment:
   - Confirm Binance USDM support through CCXT for reduce-only close orders.
   - If no native OCO is available for futures, implement a local bracket manager:
     - place SL first as today,
     - place TP immediately after,
     - monitor user-data fills,
     - cancel the opposing order on fill,
     - alert and retry if either leg is missing.
   - Add explicit alert severity for "SL-only position".

## Suggested Work Order

1. TP requeue placement and tests.
2. TREND time-exit config and tests.
3. RV/IV configurable window and tests.
4. SQUEEZE deterministic router and tests.
5. Cancel-velocity ghost-wall tracker and OFI/liquidity gating.
6. Ignition burst detector.
7. Adaptive polling and bracket-manager hardening.

## Risk Notes

Do not jump straight to a 4-state HMM. The code comments explicitly say SQUEEZE was considered but not implemented in the emission/transition matrices. A deterministic SQUEEZE router is lower-risk and reversible. Likewise, start with a testable burst-decay ignition detector before adding a more complex Hawkes estimator.

## Full Fix Execution Plan

This is the build checklist for all accepted and partly accepted audit findings.

### Milestone A - Fast Safety Patch

Estimated effort: 0.5-1 day.

#### A1. Fix TP Requeue While Position Is Open

Files:

- `bot/main.py`
- `bot/executor.py`
- `tests/test_executor.py`

Steps:

1. Move `await executor.attempt_tp_requeue()` out of the `if exited:` branch in the open-position section of `bot/main.py`.
2. Run it once per active-position cycle when `executor.active_position` exists, `executor.dry_run` is false, and `requeue_tp_attempts > 0`.
3. Keep the retry before slow exchange reconciliation work.
4. Preserve `MAX_REQUEUE_ATTEMPTS` and existing alert behavior in `bot/executor.py`.
5. Add tests proving open live positions retry TP attachment without requiring an exit event.

Acceptance criteria:

- A live SL-only position retries TP attachment on the next analysis cycle.
- Dry-run and positions without pending TP requeue do not call the retry path.

#### A2. Extend TREND Time Exit

Files:

- `bot/signal_config.py`
- `tests/test_quant_engine.py` or new `tests/test_signal_config.py`

Steps:

1. Change `REGIME_PARAMS["TREND"]["time_exit_sec"]` from `1800` to `5400`.
2. Change `REGIME_PARAMS["TREND"]["time_exit_hard_cap_s"]` from `3600` to `10800`.
3. Keep `executor.check_time_exit()` fee/profit deferral logic unchanged.
4. Add tests asserting TREND has a longer base and hard-cap exit than RANGE, LIQUIDITY, VOLATILE, and NEUTRAL.

Acceptance criteria:

- TREND trades are no longer mechanically capped at 2 candles.
- Existing time-exit safety behavior remains intact.

### Milestone B - Regime And Volatility Patch

Estimated effort: 1-2 days.

#### B1. Make SQUEEZE Params Reachable

Files:

- `bot/main.py`
- `bot/signal_config.py`
- `bot/quant_engine.py`
- `tests/test_hmm_regime.py`
- new `tests/test_regime_routing.py` if needed

Steps:

1. Keep the HMM as a 3-state classifier for now.
2. Add a deterministic SQUEEZE router after HMM classification and before `REGIME_PARAMS` lookup.
3. Candidate conditions:
   - `atr_pct_rank >= 0.80`
   - `amihud_rank >= 0.80`
   - `abs(zScore) < 1.00`
   - `tapeSpeed == "SCREAMING"` or equivalent high-tape flag
   - no active ghost-wall flag
4. Require 2 consecutive confirmations before returning `"SQUEEZE"`.
5. Remove or change `REGIME_ALIAS["SQUEEZE"] = "LIQUIDITY"` so literal SQUEEZE does not silently discard SQUEEZE params.
6. Add metrics/logging for `squeeze_candidate`, `squeeze_confirms`, and `squeeze_reason`.
7. Test that SQUEEZE conditions route to `REGIME_PARAMS["SQUEEZE"]` and non-confirmed candidates do not.

Acceptance criteria:

- There is a live code path to `REGIME_PARAMS["SQUEEZE"]`.
- No uncalibrated 4-state HMM is introduced.

#### B2. Expand RV/IV Windowing

Files:

- `bot/quant_engine.py`
- `tests/test_quant_engine.py`

Steps:

1. Add optional `_rv_iv_discriminant()` parameters: `window_ms=30_000` and `min_ticks=5`.
2. In `compute_metrics()`, choose:
   - 30s window for normal conditions
   - 120s window for high ATR rank, VOLATILE candidate, or sparse recent tape
3. Return `rv_window_ms` and `rv_tick_count` in metrics.
4. Update tests so sparse 30s data can still use valid 120s tick data before falling back to candle returns.

Acceptance criteria:

- Normal 30s behavior remains unchanged.
- High-vol/sparse-tape cases do not unnecessarily degrade to candle fallback.

### Milestone C - Microstructure Spoof Resistance

Estimated effort: 3-5 days.

#### C1. Add Cancel-Velocity / Ghost-Wall Tracking

Files:

- `bot/data_feed.py`
- `bot/quant_engine.py`
- `bot/main.py`
- new `tests/test_microstructure.py`

Steps:

1. Extend `MarketState` with previous depth maps, previous depth timestamp, active ghost-wall records, and cancel-velocity events.
2. In `MarketState.update_depth()`, compare previous and current size per price level.
3. Match size decreases against nearby aggTrade fills during the same interval.
4. Classify unmatched fast disappearance as cancellation.
5. Add env-configurable defaults:
   - `BOT_GHOST_CANCEL_QTY=10.0`
   - `BOT_GHOST_CANCEL_WINDOW_MS=100`
   - `BOT_GHOST_WALL_TTL_S=10`
6. Surface metrics:
   - `ghost_wall_active`
   - `ghost_wall_side`
   - `ghost_wall_price`
   - `ghost_cancel_rate`
7. In `_detect_regime()`, prevent LIQUIDITY hard override from ghosted nearest walls.
8. In OFI calculation, neutralize or down-weight OFI during matching ghost-wall activity.
9. Test no-trade wall disappearance, real trade consumption, TTL expiry, and LIQUIDITY override suppression.

Acceptance criteria:

- Fast unmatched wall cancellation cannot force LIQUIDITY.
- OFI does not treat spoofed size disappearance as real institutional pressure.

#### C2. Add Momentum-Ignition Detector

Files:

- `bot/data_feed.py`
- `bot/quant_engine.py`
- `bot/main.py`
- `tests/test_microstructure.py`

Steps:

1. Start with a deterministic burst-decay detector before implementing full Hawkes.
2. Track rolling 500ms trade count/USD volume and a 5s baseline.
3. Mark ignition when:
   - arrival-rate z-score exceeds 3
   - side dominance exceeds 70%
   - burst rapidly decays or reverses within 5s
4. Add TTL metrics:
   - `ignition_detected`
   - `ignition_side`
   - `ignition_active_until`
   - default `BOT_IGNITION_TTL_S=60`
5. In `_compute_signal()`, veto TREND entries in the ignition direction while TTL is active unless later OFI/CVD/tape continuation remains strong.
6. Test burst-decay detection, sustained real trend flow, veto behavior, and expiry.

Acceptance criteria:

- The bot distinguishes sustained trend participation from short manipulation bursts.
- The first version is explainable and replay-testable.

### Milestone D - Execution Latency And Bracket Hardening

Estimated effort: 2-4 days.

#### D1. Adaptive Polling

Files:

- `bot/main.py`
- tests for interval helper if factored

Steps:

1. Add a helper that selects loop timeout:
   - active position: 2-5s
   - `TREND`, `VOLATILE`, `LIQUIDITY`, `SQUEEZE`: 2-5s
   - stable `RANGE` without active position: 15-30s
2. Keep candle-close event wakeup.
3. Use the adaptive timeout in `asyncio.wait_for(feed.state.candle_close_event.wait(), timeout=...)`.
4. Log interval changes only when the value changes.
5. Add env defaults:
   - `BOT_FAST_ANALYSIS_INTERVAL=3`
   - `BOT_SLOW_ANALYSIS_INTERVAL=30`

Acceptance criteria:

- Mid-candle high-risk regimes are evaluated faster.
- Quiet stable RANGE does not waste cycles.

#### D2. Local Bracket / OCO Hardening

Files:

- `bot/executor.py`
- `bot/main.py`
- `tests/test_executor.py`

Steps:

1. Keep SL-first placement as the minimum safe default.
2. Add explicit bracket fields to active positions:
   - `bracket_status`
   - `bracket_missing_leg`
   - `last_bracket_check_ts`
3. Set status to `SL_ONLY` if TP placement fails.
4. Requeue TP immediately and alert with clear wording: SL active, TP missing.
5. Use user-data stream fills to cancel the opposing order promptly.
6. Add a periodic bracket audit:
   - if one leg is missing unexpectedly, requeue or alert
   - if position is closed, cancel remaining reduce-only orders
7. Investigate Binance USDM/CCXT native batch or OCO alternatives before attempting atomic placement.
8. Test SL-only state, successful TP requeue to `BRACKETED`, and opposing-order cancellation after fill.

Acceptance criteria:

- SL-only exposure is explicit, retried, and visible.
- Opposing order cleanup remains reliable on live fills.

### Milestone E - Documentation And Rollout

Estimated effort: 0.5 day.

Files:

- `README.md`, `RUN_TESTS.md`, or new `docs/trading_signals.md`
- `.env.example`

Steps:

1. Document signal latency classes:
   - tick/sub-second: aggTrade, depth
   - cycle-level: OFI, CVD, tape, RV/IV
   - slow macro: Coinglass, funding, GEX, macro calendar
2. Document all new env vars:
   - `BOT_RV_IV_WINDOW_MS_NORMAL`
   - `BOT_RV_IV_WINDOW_MS_VOL`
   - `BOT_GHOST_CANCEL_QTY`
   - `BOT_GHOST_CANCEL_WINDOW_MS`
   - `BOT_GHOST_WALL_TTL_S`
   - `BOT_IGNITION_TTL_S`
   - `BOT_FAST_ANALYSIS_INTERVAL`
   - `BOT_SLOW_ANALYSIS_INTERVAL`
3. Add a dry-run/replay checklist covering:
   - normal trend
   - ghost wall cancellation
   - real wall consumed by trades
   - ignition burst and decay
   - SQUEEZE candidate
   - failed TP placement and requeue

Acceptance criteria:

- Operators know which signals are fast enough for intrabar decisions.
- New thresholds are visible and tunable without code edits.
