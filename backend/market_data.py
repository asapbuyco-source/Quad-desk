import asyncio
import json
import logging
import aiohttp
from collections import deque, defaultdict
from typing import List, Dict, Optional, Any
from config import Config

logger = logging.getLogger("QuantDesk.Data")

class MarketDataService:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(MarketDataService, cls).__new__(cls)
            cls._instance.initialized = False
        return cls._instance

    def __init__(self):
        if self.initialized:
            return
        
        # Structure: self.store[symbol][interval] = deque()
        self.store: Dict[str, Dict[str, deque]] = defaultdict(lambda: defaultdict(lambda: deque(maxlen=Config.HISTORY_LIMIT)))
        
        # Lock for thread-safety during async reads/writes
        self.lock = asyncio.Lock()
        
        self.session: Optional[aiohttp.ClientSession] = None
        self.ws_task: Optional[asyncio.Task] = None
        self.running = False
        self.initialized = True

    async def start(self):
        """Initializes session and starts data ingestion tasks."""
        self.running = True
        # Set a reasonable timeout for external requests to prevent hanging
        timeout = aiohttp.ClientTimeout(total=10)
        self.session = aiohttp.ClientSession(timeout=timeout)
        
        logger.info(f"🚀 Starting Market Data Engine for {len(Config.SYMBOLS)} symbols")
        
        # 1. Start Backfill in BACKGROUND to avoid blocking server startup (Critical for Health Checks)
        asyncio.create_task(self._perform_initial_backfill())
        
        # 2. Start Async WebSocket Loop
        self.ws_task = asyncio.create_task(self._ws_loop())

    async def stop(self):
        """Graceful shutdown."""
        self.running = False
        if self.ws_task:
            self.ws_task.cancel()
            try:
                await self.ws_task
            except asyncio.CancelledError:
                pass
        
        if self.session:
            await self.session.close()
        logger.info("🛑 Market Data Engine Stopped")

    async def get_candles(self, symbol: str, interval: str, limit: int = 300) -> List[List[Any]]:
        """Returns a snapshot of current candles safely from memory."""
        symbol = symbol.upper()
        async with self.lock:
            if symbol in self.store and interval in self.store[symbol]:
                data = list(self.store[symbol][interval])
                return data[-limit:]
            return []

    async def _perform_initial_backfill(self):
        """Fetches history for all symbols/intervals."""
        logger.info("⏳ Starting background data backfill...")
        tasks = []
        for symbol in Config.SYMBOLS:
            for interval in Config.INTERVALS:
                tasks.append(self._backfill_single(symbol, interval))
        
        # Use return_exceptions=True to prevent one failure from stopping the rest
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("✅ Initial Backfill Complete")

    async def _backfill_single(self, symbol: str, interval: str):
        if not self.session: return
        try:
            url = f"{Config.REST_URL}/klines"
            params = {
                "symbol": symbol,
                "interval": interval,
                "limit": Config.HISTORY_LIMIT
            }
            
            async with self.session.get(url, params=params) as resp:
                if resp.status == 200:
                    raw_data = await resp.json()
                    # Format: [t, o, h, l, c, v]
                    formatted = []
                    for d in raw_data:
                        formatted.append([
                            int(d[0]), float(d[1]), float(d[2]), 
                            float(d[3]), float(d[4]), float(d[5])
                        ])
                    
                    async with self.lock:
                        self.store[symbol][interval].extend(formatted)
                else:
                    logger.warning(f"⚠️ Backfill failed for {symbol} {interval}: HTTP {resp.status}")
        except Exception as e:
            logger.error(f"❌ Error backfilling {symbol} {interval}: {str(e)}")

    async def _ws_loop(self):
        """Main WebSocket loop with auto-reconnect."""
        # Construct combined stream URL
        # Format: <symbol>@kline_<interval>
        streams = []
        for symbol in Config.SYMBOLS:
            for interval in Config.INTERVALS:
                streams.append(f"{symbol.lower()}@kline_{interval}")
        
        ws_url = f"{Config.WS_URL}/{'/'.join(streams)}"

        while self.running:
            try:
                if not self.session:
                    await asyncio.sleep(1)
                    continue

                async with self.session.ws_connect(ws_url) as ws:
                    logger.info(f"⚡ WebSocket Stream Connected ({len(streams)} streams)")
                    
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            await self._process_stream_data(data)
                        elif msg.type == aiohttp.WSMsgType.ERROR:
                            break
            except Exception as e:
                if self.running:
                    logger.warning(f"⚠️ WS Disconnected. Reconnecting in 5s... Error: {e}")
                    await asyncio.sleep(5)

    async def _process_stream_data(self, payload: dict):
        """Processes incoming kline updates."""
        if 'data' not in payload:
            return # Should utilize combined stream format

        data = payload['data']
        if data.get('e') != 'kline':
            return

        k = data['k']
        symbol = k['s']
        interval = k['i']
        
        # Internal format: [time, open, high, low, close, volume]
        candle = [
            k['t'],           # Time
            float(k['o']),    # Open
            float(k['h']),    # High
            float(k['l']),    # Low
            float(k['c']),    # Close
            float(k['v'])     # Volume
        ]

        async with self.lock:
            buffer = self.store[symbol][interval]
            
            # Initialize buffer if empty
            if len(buffer) == 0:
                buffer.append(candle)
                return

            last_stored_time = buffer[-1][0]
            incoming_time = candle[0]

            if incoming_time == last_stored_time:
                # Update current open candle
                buffer[-1] = candle
            elif incoming_time > last_stored_time:
                # Close previous, append new
                buffer.append(candle)

market_service = MarketDataService()