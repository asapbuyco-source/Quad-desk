import asyncio
import json
import logging
import time
import websockets
import httpx
from collections import deque

logger = logging.getLogger(__name__)


class MarketState:
    def __init__(self, symbol: str):
        self.symbol = symbol.upper()
        self.candles: deque = deque(maxlen=200)
        # Keep all trades received; prune old ones in add_trade
        self.recent_trades: deque = deque(maxlen=5000)
        # Order Book snapshot { price_float: size_float }
        self.bids: dict = {}
        self.asks: dict = {}
        # Running cumulative volume delta
        self.cvd: float = 0.0
        # Binance USDM funding rate — fetched periodically via REST.
        # Positive = longs pay shorts (crowded long → bearish pressure).
        # Negative = shorts pay longs (crowded short → bullish squeeze).
        self.funding_rate: float = 0.0
        self._reconnect_event: asyncio.Event = asyncio.Event()

    # ------------------------------------------------------------------
    # Candle management
    # ------------------------------------------------------------------
    def add_candle(self, c_data: dict, is_final: bool):
        """Add or update the current live candle. Only keep the last MAX_CANDLES."""
        candle = {
            'time': c_data['t'] / 1000,
            'open': float(c_data['o']),
            'high': float(c_data['h']),
            'low':  float(c_data['l']),
            'close': float(c_data['c']),
            'volume': float(c_data['v'])
        }
        if is_final:
            # Closed candle — always append
            self.candles.append(candle)
        else:
            # Live candle — replace if same timestamp, otherwise append
            if self.candles and self.candles[-1]['time'] == candle['time']:
                self.candles[-1] = candle
            else:
                self.candles.append(candle)

    # ------------------------------------------------------------------
    # Trade tape
    # ------------------------------------------------------------------
    def add_trade(self, t_data: dict):
        price = float(t_data['p'])
        size = float(t_data['q'])
        is_buyer_maker = t_data['m']
        # If buyer is maker they were resting → the *seller* aggressed → SELL tape
        side = 'SELL' if is_buyer_maker else 'BUY'

        trade = {
            'price': price,
            'size': size,
            'usd_volume': price * size,
            'side': side,
            'time': t_data['T']  # Binance millisecond timestamp
        }
        self.recent_trades.append(trade)

        # Update CVD
        delta = size if side == 'BUY' else -size
        self.cvd += delta

        # Prune trades older than 60 seconds using wall-clock time
        now_ms = time.time() * 1000
        while self.recent_trades and (now_ms - self.recent_trades[0]['time']) > 60_000:
            self.recent_trades.popleft()

    # ------------------------------------------------------------------
    # Order book
    # ------------------------------------------------------------------
    def update_depth(self, depth_data: dict):
        """Full snapshot of the top-20 levels."""
        raw_b = depth_data.get('b', depth_data.get('bids', []))
        raw_a = depth_data.get('a', depth_data.get('asks', []))
        self.bids = {float(p): float(q) for p, q in raw_b}
        self.asks = {float(p): float(q) for p, q in raw_a}
        # Remove levels with zero quantity (Binance sends these as deletes)
        self.bids = {p: q for p, q in self.bids.items() if q > 0}
        self.asks = {p: q for p, q in self.asks.items() if q > 0}


class BinanceDataFeed:
    """
    Async WebSocket feed for Binance USDM Futures (Live or Testnet).

    Live endpoint:    wss://fstream.binance.com/stream?streams=...
    Testnet endpoint: wss://stream.binancefuture.com/stream?streams=...

    REST klines use fapi.binance.com/fapi/v1/klines (futures),
    NOT api.binance.com/api/v3/klines (spot).
    Using spot endpoints for a futures bot produces slightly different
    price/volume data and misses funding-rate-driven price divergence.
    """

    def __init__(self, symbol: str = "BTCUSDT", interval: str = "15m", testnet: bool = True):
        self.symbol = symbol.lower()
        self.interval = interval.lower()
        self.state = MarketState(symbol)

        # Binance USDM Futures endpoints (separate from Spot)
        if testnet:
            self.rest_url = "https://testnet.binancefuture.com"
            base_url = "wss://stream.binancefuture.com"
        else:
            # Live Futures — global endpoint, no regional block on Railway/USA
            self.rest_url = "https://fapi.binance.com"
            base_url = "wss://fstream.binance.com"

        streams = (
            f"{self.symbol}@kline_{self.interval}"
            f"/{self.symbol}@aggTrade"      # Futures uses aggTrade, not trade
            f"/{self.symbol}@depth20@100ms"
        )
        self.ws_url = f"{base_url}/stream?streams={streams}"
        self.is_running = False
        self._last_funding_fetch: float = 0.0   # epoch-seconds of last funding rate REST call
        self._last_kline_frame_ts: float = 0.0  # epoch-seconds of last kline WS frame received

    # ------------------------------------------------------------------
    # Message routing
    # ------------------------------------------------------------------
    async def _handle_message(self, raw: str):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.warning(f"JSON decode error: {e}")
            return

        if 'stream' not in payload:
            return  # Subscription confirmations etc.

        stream: str = payload['stream']
        data: dict = payload['data']

        try:
            if '@kline_' in stream:
                self.state.add_candle(data['k'], data['k']['x'])
                self._last_kline_frame_ts = time.time()  # P0-2: track freshness for health monitor
            elif '@aggTrade' in stream:
                # Futures aggTrade uses same fields as Spot trade (p, q, m, T)
                self.state.add_trade(data)
            elif '@depth' in stream:
                self.state.update_depth(data)
        except KeyError as e:
            logger.error(f"Missing key in {stream} payload: {e}")
        except Exception as e:
            logger.error(f"Error processing stream '{stream}': {e}", exc_info=True)

    # ------------------------------------------------------------------
    # Funding Rate Fetch (periodic, every 60 s)
    # ------------------------------------------------------------------
    async def _fetch_funding_rate(self):
        """
        Fetch the current funding rate from Binance USDM Futures REST.
        Endpoint: GET /fapi/v1/premiumIndex?symbol=BTCUSDT
        Runs every 60 s; independent signal used by ULIS engine.
        """
        url = f"{self.rest_url}/fapi/v1/premiumIndex"
        params = {"symbol": self.symbol.upper()}
        import os
        api_key = os.environ.get("BINANCE_API_KEY", "")
        headers = {"X-MBX-APIKEY": api_key} if api_key else {}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(url, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            rate = float(data.get("lastFundingRate", 0.0))
            self.state.funding_rate = rate
            logger.info(f"[DataFeed] Funding rate: {rate:+.6f} ({rate*100:+.4f}%)")
        except Exception as e:
            logger.warning(f"[DataFeed] Failed to fetch funding rate: {e}")

    # ------------------------------------------------------------------
    # REST API Prefetch
    # ------------------------------------------------------------------
    async def _fetch_historical_candles_rest(self):
        """Fetch 100 recent candles from Binance USDM Futures REST to warm up the Quant Engine."""
        # Futures klines live under /fapi/v1/klines, NOT /api/v3/klines (spot)
        url = f"{self.rest_url}/fapi/v1/klines"
        params = {
            "symbol": self.symbol.upper(),
            "interval": self.interval,
            "limit": 100
        }
        import os
        api_key = os.environ.get("BINANCE_API_KEY", "")
        headers = {"X-MBX-APIKEY": api_key} if api_key else {}

        # 3.3 FIX: Snapshot CVD before any mutation.
        # If REST fails (network drop, reconnect), we preserve the existing baseline
        # rather than resetting to 0.0 which would produce a false CVD delta spike.
        prev_cvd = self.state.cvd

        try:
            logger.info(f"[DataFeed] Fetching historical {self.interval} candles from {url}...")
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()

            # Reset CVD to re-anchor perfectly based on REST history (only on success)
            self.state.cvd = 0.0
            for k in data:
                # Binance REST returns an array of arrays
                # [openTime, open, high, low, close, volume, closeTime, qav, trades, taker_buy_base, taker_buy_quote, ...]
                c_data = {
                    't': int(k[0]),
                    'o': float(k[1]),
                    'h': float(k[2]),
                    'l': float(k[3]),
                    'c': float(k[4]),
                    'v': float(k[5]),
                }
                self.state.add_candle(c_data, is_final=True)

                # Rebuild CVD analytically
                taker_buy_base = float(k[9])
                vol = float(k[5])
                self.state.cvd += (2.0 * taker_buy_base) - vol

            logger.info(f"[DataFeed] Successfully loaded {len(self.state.candles)} historical candles. CVD rebuilt: {self.state.cvd:.0f}")
        except Exception as e:
            logger.warning(
                f"[DataFeed] Failed to prefetch historical candles ({e}). "
                f"Preserving existing CVD={prev_cvd:.0f} to avoid false delta spike."
            )
            self.state.cvd = prev_cvd  # restore — do not corrupt the signal



    # ------------------------------------------------------------------
    # Connection loop with exponential back-off
    # ------------------------------------------------------------------
    async def run(self):
        self.is_running = True
        retry_delay = 1

        # ALWAYS fill history before opening streaming connections to prevent the 51-interval delay
        await self._fetch_historical_candles_rest()

        while self.is_running:
            try:
                logger.info(f"[DataFeed] Connecting → {self.ws_url}")
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=30,
                    close_timeout=10
                ) as ws:
                    retry_delay = 1  # Reset back-off on successful connect
                    logger.info("[DataFeed] Connected ✓")
                    import asyncio as _asyncio
                    while self.is_running:
                        try:
                            msg = await _asyncio.wait_for(ws.recv(), timeout=120)
                            await self._handle_message(msg)
                        except _asyncio.TimeoutError:
                            logger.warning("[DataFeed] recv() timeout (120s) — connection may be frozen. Reconnecting...")
                            break
                        except websockets.exceptions.ConnectionClosedOK:
                            break
                    # Funding rate: fetch every 60 s without blocking the WS loop
                    now = time.time()
                    if now - self._last_funding_fetch >= 60.0:
                        self._last_funding_fetch = now
                        asyncio.create_task(self._fetch_funding_rate())
                    # Wait for reconnect signal if triggered by health monitor
                    if self.is_running:
                        await _asyncio.wait_for(self._reconnect_event.wait(), timeout=retry_delay + 5)
                        self._reconnect_event.clear()

            except websockets.exceptions.ConnectionClosedOK:
                logger.info("[DataFeed] Connection closed cleanly.")
            except websockets.exceptions.ConnectionClosed as e:
                logger.warning(f"[DataFeed] Connection dropped: {e}. Reconnecting in {retry_delay}s…")
            except OSError as e:
                logger.error(f"[DataFeed] Network error: {e}. Retrying in {retry_delay}s…")
            except Exception as e:
                logger.error(f"[DataFeed] Unexpected error: {e}", exc_info=True)

            if self.is_running:
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)

    async def feed_health_monitor(self, notifier=None):
        """
        P0-2 FIX: Feed health monitor — runs as an independent async task.
        Checks every 60s whether a kline WebSocket frame was received within
        3× the candle interval. If not (i.e. feed is frozen), sends a
        Telegram alert and forces a reconnect by briefly stopping the feed loop.
        """
        interval_secs = {
            "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600
        }.get(self.interval, 900)
        stale_threshold = interval_secs * 3.0

        # Give the feed 60s to warm up before monitoring
        await asyncio.sleep(60)

        while self.is_running:
            await asyncio.sleep(60)
            if not self.is_running:
                break

            # Skip check if feed just started (no frames yet)
            if self._last_kline_frame_ts == 0.0:
                continue

            age = time.time() - self._last_kline_frame_ts
            if age > stale_threshold:
                alert_msg = (
                    f"⚠️ [DataFeed] FEED STALE: no kline frame received for {age:.0f}s "
                    f"(threshold={stale_threshold:.0f}s). Forcing reconnect."
                )
                logger.error(alert_msg)
                if notifier:
                    try:
                        await notifier.send_message(alert_msg)
                    except Exception:
                        pass
                self._reconnect_event.set()
                self.is_running = False
                logger.info("[DataFeed] Feed health monitor triggered reconnect.")

    def stop(self):
        logger.info("[DataFeed] Stop requested.")
        self.is_running = False
