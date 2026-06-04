import asyncio
import logging
import time
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
        
        # High impact USD events that cause chaotic liquidity vacuums
        self.target_events = ["CPI", "FOMC", "Non-Farm Employment", "NFP", "Federal Funds Rate"]

    async def run_calendar_loop(self):
        """
        Polls Forex Factory calendar every hour.
        Evaluates blackout window (±15 mins around high-impact USD events).
        """
        self.is_running = True
        url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
        
        while self.is_running:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    events = resp.json()
                    
                now = datetime.now(timezone.utc)
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
                logger.warning(f"[MacroShield] Failed to fetch ForexFactory calendar: {e}")
                # Fail-open: do not block trading if API is down
                self.is_calendar_blackout = False
                
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
                    # Filter out None values
                    valid_closes = [c for c in closes if c is not None]
                    
                    if len(valid_closes) >= 5:  # Need at least 1h of data (4x15m candles)
                        current_dxy = valid_closes[-1]
                        # Look back 4 candles (~1 hour)
                        dxy_1h_ago = valid_closes[-5]
                        
                        momentum_pct = (current_dxy - dxy_1h_ago) / dxy_1h_ago
                        
                        # Calculate scalar: +0.2% DXY move = ±0.15 scalar modification
                        # Cap the modification to ±0.15 max
                        scalar_mod = (momentum_pct / 0.002) * 0.15
                        scalar_mod = max(-0.15, min(0.15, scalar_mod))
                        
                        # Store base momentum internally. 
                        # We apply it contextually based on trade direction in get_dxy_scalar()
                        self._dxy_momentum_mod = scalar_mod
                        self.dxy_last_update = time.time()
                        
                        logger.debug(f"[MacroShield] DXY: {current_dxy:.2f} | 1h Mom: {momentum_pct:.2%} | Base Mod: {scalar_mod:+.3f}")
            except Exception as e:
                logger.warning(f"[MacroShield] Failed to fetch DXY from Yahoo Finance: {e}")
                
            await asyncio.sleep(60)

    def is_calendar_safe(self) -> bool:
        """Returns True if it's safe to trade (no high-impact news)."""
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
