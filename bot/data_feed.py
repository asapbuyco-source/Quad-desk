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
        self.recent_trades: deque = deque()
        # Order Book snapshot { price_float: size_float }
        self.bids: dict = {}
        self.asks: dict = {}
        # Running cumulative volume delta
        self.cvd: float = 0.0

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
        self.bids = {float(p): float(q) for p, q in depth_data['bids']}
        self.asks = {float(p): float(q) for p, q in depth_data['asks']}
        # Remove levels with zero quantity (Binance sends these as deletes)
        self.bids = {p: q for p, q in self.bids.items() if q > 0}
        self.asks = {p: q for p, q in self.asks.items() if q > 0}


class BinanceDataFeed:
    """
    Async WebSocket feed for Binance Spot (Live or Testnet).

    Testnet endpoint: wss://testnet.binance.vision/stream?streams=...
    Live endpoint:    wss://stream.binance.com:9443/stream?streams=...
    """

    def __init__(self, symbol: str = "BTCUSDT", interval: str = "15m", testnet: bool = True):
        self.symbol = symbol.lower()
        self.interval = interval.lower()
        self.state = MarketState(symbol)

        # FIX: Binance Testnet Spot uses a different base URL
        if testnet:
            self.rest_url = "https://testnet.binance.vision"
            base_url = "wss://testnet.binance.vision"
        else:
            # Using Binance.US to avoid HTTP 451 (Region Blocked) errors
            self.rest_url = "https://api.binance.us"
            base_url = "wss://stream.binance.us:9443"

        streams = (
            f"{self.symbol}@kline_{self.interval}"
            f"/{self.symbol}@trade"
            f"/{self.symbol}@depth20@100ms"
        )
        self.ws_url = f"{base_url}/stream?streams={streams}"
        self.is_running = False

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
            elif '@trade' in stream:
                self.state.add_trade(data)
            elif '@depth' in stream:
                self.state.update_depth(data)
        except KeyError as e:
            logger.error(f"Missing key in {stream} payload: {e}")
        except Exception as e:
            logger.error(f"Error processing stream '{stream}': {e}", exc_info=True)

    # ------------------------------------------------------------------
    # REST API Prefetch
    # ------------------------------------------------------------------
    async def _fetch_historical_candles_rest(self):
        """Fetch 100 recent candles to warm up the Quant Engine immediately."""
        url = f"{self.rest_url}/api/v3/klines"
        params = {
            "symbol": self.symbol.upper(),
            "interval": self.interval,
            "limit": 100
        }
        try:
            logger.info(f"[DataFeed] Fetching historical {self.interval} candles from {url}...")
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()

            # Reset CVD to re-anchor perfectly based on REST history
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
            
            logger.info(f"[DataFeed] Successfully loaded {len(self.state.candles)} historical candles.")
        except Exception as e:
            logger.warning(f"[DataFeed] Failed to prefetch historical candles: {e}")

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
                    while self.is_running:
                        msg = await ws.recv()
                        await self._handle_message(msg)

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

    def stop(self):
        logger.info("[DataFeed] Stop requested.")
        self.is_running = False
