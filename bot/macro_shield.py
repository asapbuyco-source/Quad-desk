import asyncio
import logging
import os
import time
import numpy as np
from collections import deque
from datetime import datetime, timezone, timedelta
import httpx

logger = logging.getLogger("bot.macro_shield")

class MacroShield:
    """
    Independent macro-economic shield module.
    Runs asynchronously to Binance data and acts as a global risk manager.
    """
    def __init__(self):
        self.dxy_scalar = 1.0
        self.dxy_last_update = 0.0
        self.is_calendar_blackout = False
        self.next_event_time = None
        self.next_event_name = ""
        self.is_running = False
        
        self.target_events = ["CPI", "FOMC", "Non-Farm Employment", "NFP", "Federal Funds Rate"]
        self._calendar_events = []
        self._calendar_last_success = 0.0
        self._calendar_backoff_until = 0.0
        self._calendar_backoff_s = 600.0
        self._calendar_cache_ttl_s = float(os.environ.get("MACRO_CALENDAR_CACHE_TTL_S", "10800"))
        self._calendar_last_error_log = 0.0
        self._calendar_initial_delay_done = False
        
        self._dxy_ticks = deque(maxlen=200)
        self._btc_ticks = deque(maxlen=200)
        self._dxy_returns_5m = deque(maxlen=200)
        self._btc_returns_5m = deque(maxlen=200)
        self._dxy_atr = 0.0
        self._btc_atr = 0.0
        self._hy_corr: float = 0.0
        self._lead_lag_adj: float = 0.0
        self._te_gate_open: bool = True
        self._te_value: float = 0.0
        self._last_candle_ts: float = 0.0

    def _evaluate_calendar_events(self, events) -> None:
        now = datetime.now(timezone.utc)
        upcoming_usd_events = []

        for ev in events:
            if ev.get("country") != "USD" or ev.get("impact") != "High":
                continue
            title = ev.get("title", "")
            if not any(t.lower() in title.lower() for t in self.target_events):
                continue
            date_str = ev.get("date")
            try:
                ev_time = datetime.fromisoformat(date_str)
                if ev_time.tzinfo is None:
                    ev_time = ev_time.replace(tzinfo=timezone.utc)
                upcoming_usd_events.append((ev_time, title))
            except Exception:
                pass

        upcoming_usd_events.sort(key=lambda x: x[0])

        in_blackout = False
        next_event_name = ""
        next_event_time = None
        for ev_time, title in upcoming_usd_events:
            time_diff = (ev_time - now).total_seconds()

            if -900 <= time_diff <= 900:
                if not self.is_calendar_blackout:
                    logger.warning(f"[MacroShield] ENTERING CALENDAR BLACKOUT: {title}")
                in_blackout = True
                next_event_name = title
                next_event_time = ev_time
                break

            if time_diff > 900 and (next_event_time is None or ev_time < next_event_time):
                next_event_name = title
                next_event_time = ev_time

        if self.is_calendar_blackout and not in_blackout:
            logger.info("[MacroShield] CALENDAR BLACKOUT LIFTED. Resuming normal trading.")

        self.is_calendar_blackout = in_blackout
        self.next_event_name = next_event_name
        self.next_event_time = next_event_time

        if self.next_event_time:
            diff_hours = (self.next_event_time - now).total_seconds() / 3600
            if 0 < diff_hours < 2:
                logger.info(
                    f"[MacroShield] Upcoming High-Impact USD Event: "
                    f"{self.next_event_name} in {diff_hours:.1f}h"
                )

    async def run_calendar_loop(self):
        """
        Polls Forex Factory calendar every hour.
        Evaluates blackout window (±15 mins around high-impact USD events).
        """
        self.is_running = True
        url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
        
        while self.is_running:
            if not self._calendar_initial_delay_done:
                symbol = os.environ.get("BOT_SYMBOL", "")
                jitter_s = sum(ord(ch) for ch in symbol) % 90
                if jitter_s:
                    await asyncio.sleep(jitter_s)
                self._calendar_initial_delay_done = True

            try:
                now_ts = time.time()
                if now_ts < self._calendar_backoff_until:
                    if self._calendar_events:
                        self._evaluate_calendar_events(self._calendar_events)
                    await asyncio.sleep(min(600, max(60, self._calendar_backoff_until - now_ts)))
                    continue

                if (
                    self._calendar_events
                    and now_ts - self._calendar_last_success < self._calendar_cache_ttl_s
                ):
                    self._evaluate_calendar_events(self._calendar_events)
                    cache_remaining = self._calendar_cache_ttl_s - (now_ts - self._calendar_last_success)
                    await asyncio.sleep(min(600, max(60, cache_remaining)))
                    continue

                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    events = resp.json()
                self._calendar_events = events
                self._calendar_last_success = time.time()
                self._calendar_backoff_s = 600.0
                self._calendar_backoff_until = 0.0
                    
                now = datetime.now(timezone.utc)
                self.next_event_time = None
                self.next_event_name = ""
                upcoming_usd_events = []
                
                for ev in events:
                    if ev.get("country") == "USD" and ev.get("impact") == "High":
                        # Check if title matches our dangerous list
                        title = ev.get("title", "")
                        if any(t.lower() in title.lower() for t in self.target_events):
                            # ForexFactory times are often ISO8601
                            date_str = ev.get("date")
                            try:
                                ev_time = datetime.fromisoformat(date_str)
                                # Ensure timezone awareness
                                if ev_time.tzinfo is None:
                                    ev_time = ev_time.replace(tzinfo=timezone.utc)
                                upcoming_usd_events.append((ev_time, title))
                            except Exception:
                                pass
                
                # Sort events by time
                upcoming_usd_events.sort(key=lambda x: x[0])
                
                # Check blackout
                in_blackout = False
                for ev_time, title in upcoming_usd_events:
                    time_diff = (ev_time - now).total_seconds()
                    
                    # If within ±15 mins (900 seconds)
                    if -900 <= time_diff <= 900:
                        if not self.is_calendar_blackout:
                            logger.warning(f"[MacroShield] 🚨 ENTERING CALENDAR BLACKOUT: {title}")
                        in_blackout = True
                        self.next_event_name = title
                        self.next_event_time = ev_time
                        break
                    
                    # Track next event if it's in the future
                    if time_diff > 900 and (self.next_event_time is None or ev_time < self.next_event_time):
                        self.next_event_name = title
                        self.next_event_time = ev_time
                
                if self.is_calendar_blackout and not in_blackout:
                    logger.info("[MacroShield] 🟢 CALENDAR BLACKOUT LIFTED. Resuming normal trading.")
                    
                self.is_calendar_blackout = in_blackout

                # Log next event if close (within 2 hours)
                if self.next_event_time:
                    diff_hours = (self.next_event_time - now).total_seconds() / 3600
                    if 0 < diff_hours < 2:
                        logger.info(f"[MacroShield] Upcoming High-Impact USD Event: {self.next_event_name} in {diff_hours:.1f}h")

            except Exception as e:
                status_code = getattr(getattr(e, "response", None), "status_code", None)
                if status_code == 429:
                    self._calendar_backoff_s = min(max(self._calendar_backoff_s * 2, 1800.0), 21600.0)
                else:
                    self._calendar_backoff_s = min(max(self._calendar_backoff_s * 2, 600.0), 3600.0)
                self._calendar_backoff_until = time.time() + self._calendar_backoff_s

                if self._calendar_events and time.time() - self._calendar_last_success < 86400:
                    self._evaluate_calendar_events(self._calendar_events)
                else:
                    # Fail-open only when no usable calendar cache exists.
                    self.is_calendar_blackout = False

                if time.time() - self._calendar_last_error_log >= 1800:
                    logger.warning(
                        f"[MacroShield] Failed to fetch ForexFactory calendar: {e}. "
                        f"Backing off for {self._calendar_backoff_s / 60:.0f}m."
                    )
                    self._calendar_last_error_log = time.time()
                
            # Sleep 10 minutes between checks
            await asyncio.sleep(600)

    async def run_dxy_loop(self):
        """
        Polls Yahoo Finance for DXY (US Dollar Index) every 1 minute.
        Calculates 1-hour momentum and outputs a confidence scalar [0.85, 1.15].
        """
        self.is_running = True
        url = "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=15m&range=2d"
        headers = {"User-Agent": "Mozilla/5.0"}
        
        while self.is_running:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(url, headers=headers)
                    resp.raise_for_status()
                    data = resp.json()
                
                result = data.get("chart", {}).get("result", [])
                if result:
                    closes = result[0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
                    valid_closes = [c for c in closes if c is not None]
                    
                    if len(valid_closes) >= 5:
                        current_dxy = valid_closes[-1]
                        dxy_1h_ago = valid_closes[-5]
                        ts = time.time()
                        
                        self._dxy_ticks.append((current_dxy, ts))
                        if len(self._dxy_ticks) >= 2:
                            prev_price, _ = self._dxy_ticks[-2]
                            dt = ts - (self._dxy_ticks[-2][1] if len(self._dxy_ticks) > 1 else ts)
                            if dt > 0:
                                self._dxy_returns_5m.append(np.log(current_dxy / prev_price))
                        
                        momentum_pct = (current_dxy - dxy_1h_ago) / dxy_1h_ago
                        scalar_mod = (momentum_pct / 0.002) * 0.15
                        scalar_mod = max(-0.15, min(0.15, scalar_mod))
                        
                        self._dxy_momentum_mod = scalar_mod
                        self.dxy_last_update = time.time()
                        
                        self._compute_hy_covariance()
                        
                        logger.debug(f"[MacroShield] DXY: {current_dxy:.2f} | 1h Mom: {momentum_pct:.2%} | HY: {self._hy_corr:.3f} | TE: {self._te_value:.3f} bits")
            except Exception as e:
                logger.warning(f"[MacroShield] Failed to fetch DXY from Yahoo Finance: {e}")
                
            await asyncio.sleep(60)

    def on_btc_update(self, price: float, ts: float) -> None:
        self._btc_ticks.append((price, ts))
        if len(self._btc_ticks) >= 2:
            prev_price, prev_ts = self._btc_ticks[-2]
            dt = ts - prev_ts
            if dt > 0:
                self._btc_returns_5m.append(np.log(price / prev_price))
        if len(self._btc_ticks) >= 14:
            returns = list(self._btc_returns_5m)
            self._btc_atr = float(np.mean([abs(r) for r in returns[-14:]]))
        
        candle_ts_15m = int(ts // 900) * 900
        if candle_ts_15m != self._last_candle_ts and self._last_candle_ts > 0:
            self._compute_lead_lag()
            self._compute_transfer_entropy()
        self._last_candle_ts = candle_ts_15m

    def _compute_hy_covariance(self) -> None:
        if len(self._dxy_ticks) < 3 or len(self._btc_ticks) < 3:
            return
        
        dxy_list = list(self._dxy_ticks)
        btc_list = list(self._btc_ticks)
        
        dxy_returns = []
        for i in range(1, len(dxy_list)):
            dt = dxy_list[i][1] - dxy_list[i-1][1]
            if dt > 0:
                dxy_returns.append((dxy_list[i][0] - dxy_list[i-1][0]) / dxy_list[i-1][0])
        
        btc_returns = []
        for i in range(1, len(btc_list)):
            dt = btc_list[i][1] - btc_list[i-1][1]
            if dt > 0:
                btc_returns.append((btc_list[i][0] - btc_list[i-1][0]) / btc_list[i-1][0])
        
        if len(dxy_returns) < 3 or len(btc_returns) < 3:
            return
        
        min_len = min(len(dxy_returns), len(btc_returns))
        dxy_ret = np.array(dxy_returns[-min_len:])
        btc_ret = np.array(btc_returns[-min_len:])
        
        dxy_atr = float(np.mean([abs(r) for r in dxy_ret[-14:]])) if len(dxy_ret) >= 14 else 1e-9
        btc_atr = float(np.mean([abs(r) for r in btc_ret[-14:]])) if len(btc_ret) >= 14 else 1e-9
        
        hy_cov = float(np.sum(dxy_ret * btc_ret))
        norm_factor = dxy_atr * btc_atr
        
        if norm_factor > 0:
            self._hy_corr = hy_cov / norm_factor
            self._hy_corr = float(np.clip(self._hy_corr, -1.0, 1.0))

    def _compute_lead_lag(self) -> None:
        if len(self._dxy_returns_5m) < 6 or len(self._btc_returns_5m) < 6:
            return
        
        dxy_arr = np.array(list(self._dxy_returns_5m)[-60:])
        btc_arr = np.array(list(self._btc_returns_5m)[-60:])
        
        min_len = min(len(dxy_arr), len(btc_arr))
        dxy_arr = dxy_arr[-min_len:]
        btc_arr = btc_arr[-min_len:]
        
        if len(dxy_arr) < 6 or len(btc_arr) < 6:
            return
        
        lags = [1, 2, 3, 4, 5]
        best_lag = 0
        best_corr = 0.0
        
        for lag in lags:
            if lag >= len(dxy_arr) or lag >= len(btc_arr):
                continue
            corr = float(np.corrcoef(dxy_arr[lag:], btc_arr[:len(btc_arr)-lag])[0, 1])
            if abs(corr) > abs(best_corr):
                best_corr = corr
                best_lag = lag
        
        sign_hy = -1 if self._hy_corr < 0 else 1
        self._lead_lag_adj = float(np.clip(sign_hy * abs(best_corr) * 0.05, -0.05, 0.05))

    def _compute_transfer_entropy(self) -> None:
        try:
            from pyinform.transfer_entropy import transfer_entropy
        except ImportError:
            self._te_gate_open = True
            return
        
        min_len = min(len(self._dxy_returns_5m), len(self._btc_returns_5m))
        if min_len < 12:
            return
        
        dxy_arr = list(self._dxy_returns_5m)[-60:]
        btc_arr = list(self._btc_returns_5m)[-60:]
        
        if len(dxy_arr) < 12 or len(btc_arr) < 12:
            return
        
        def to_bins(arr, n_bins=8):
            hist, edges = np.histogram(arr, bins=n_bins)
            return [min(int(np.searchsorted(edges, v) - 1), n_bins - 1) for v in arr]
        
        dxy_bins = to_bins(dxy_arr)
        btc_bins = to_bins(btc_arr)
        
        te = transfer_entropy(dxy_bins, btc_bins)
        self._te_value = float(te) if not np.isnan(te) else 0.0
        
        if self._te_value > 0.10:
            self._te_gate_open = True
        elif self._te_value < 0.05:
            self._te_gate_open = False

    def get_macro_confidence_adj(self, direction: str) -> float:
        if not self._te_gate_open:
            return 0.0
        
        is_long = "BUY" in direction or "LONG" in direction
        
        hy_adj = 0.0
        if self._hy_corr < -0.5:
            hy_adj = -0.03 if is_long else 0.03
        elif self._hy_corr > -0.2:
            hy_adj = 0.03 if is_long else -0.03
        
        lag_adj = self._lead_lag_adj if not is_long else -self._lead_lag_adj
        
        return float(np.clip(hy_adj + lag_adj, -0.08, 0.08))

    def is_calendar_safe(self) -> bool:
        return not self.is_calendar_blackout

    def get_dxy_scalar(self, direction: str) -> float:
        """
        Returns a confidence multiplier [0.85, 1.15] based on DXY momentum.
        - Strong USD (DXY rallying) -> Bad for crypto longs, Good for crypto shorts.
        - Weak USD (DXY dropping) -> Good for crypto longs, Bad for crypto shorts.
        """
        if time.time() - self.dxy_last_update > 300:
            # Stale data (>5 mins old), default to 1.0 neutral
            return 1.0
            
        base_mod = getattr(self, "_dxy_momentum_mod", 0.0)
        
        # If DXY is RALLYING (base_mod > 0)
        # -> Crypto goes DOWN. So LONG scalar decreases, SHORT scalar increases.
        if "BUY" in direction or "LONG" in direction:
            scalar = 1.0 - base_mod
        else:
            scalar = 1.0 + base_mod
            
        # Ensure strict bounds
        return max(0.85, min(1.15, scalar))

# Global singleton
macro_shield = MacroShield()
