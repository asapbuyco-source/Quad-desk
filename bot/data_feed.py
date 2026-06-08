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
        self.candles: deque = deque(maxlen=600)  # WARN-5: was 200, 600 = ~6h of 15m candles
        # Keep all trades received; prune old ones in add_trade
        self.recent_trades: deque = deque(maxlen=50000)
        # Order Book snapshot { price_float: size_float }
        self.bids: dict = {}
        self.asks: dict = {}
        # Running cumulative volume delta
        self.cvd: float = 0.0
        # Binance USDM funding rate — fetched periodically via REST.
        # Positive = longs pay shorts (crowded long → bearish pressure).
        # Negative = shorts pay longs (crowded short → bullish squeeze).
        self.funding_rate: float = 0.0
        self.basis: float = 0.0       # Futures mark price - Spot close
        self.mark_price: float = 0.0  # Latest Futures mark price
        self._reconnect_event: asyncio.Event = asyncio.Event()
        self.candle_close_event: asyncio.Event = asyncio.Event()  # NEW: Event-driven execution trigger
        self._last_trade_ts: float = time.time()   # epoch-seconds of last aggTrade received (P0-1 FIX: was 0.0 → time.time())
        self._last_closed_candle_ts: float = time.time()  # epoch-seconds of last CLOSED (final) candle
        self._cvd_was_reset: bool = False  # flag to suppress CVD delta spike after reconnect
        self._aggtrade_msg_count: int = 0  # P0-1 FIX: throughput counter for monitoring
        self._aggtrade_count_reset_ts: float = time.time()  # last reset for msg/min calculation
        self._aggtrade_watchdog_first_cycle: bool = True  # P2: skip first 60s window (not enough time to receive msgs)
        self.msgs_per_min: int = 0           # FIX-M10: current throughput for signal gate
        self.last_fired_sweep_candle_ts: float = 0.0  # FIX-C3: dedup guard for sweep detection
        self._trade_callback = None  # Optional[Callable[[float, float, bool], None]] for AmihudEngine

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
            self.candle_close_event.set()  # Trigger zero-latency execution
            self._last_closed_candle_ts = time.time()  # FIX: track real closed-candle arrival
            if getattr(self, "_seeding_complete", False):
                self._live_candle_count = getattr(self, "_live_candle_count", 0) + 1
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
        self._last_trade_ts = t_data['T'] / 1000.0
        self._aggtrade_msg_count += 1
        self.recent_trades.append(trade)

        # Update CVD
        delta = size if side == 'BUY' else -size
        self.cvd += delta

        # Prune trades older than 5 minutes using wall-clock time
        now_ms = time.time() * 1000
        while self.recent_trades and (now_ms - self.recent_trades[0]['time']) > 300_000:
            self.recent_trades.popleft()

        # AmihudEngine: fire per-trade callback (price, qty, is_taker)
        if self._trade_callback:
            try:
                self._trade_callback(price, size, not is_buyer_maker)
            except Exception:
                pass

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
            self.rest_url = "https://fapi.binance.com"
            base_url = "wss://fstream.binance.com"

        # FIX-A: Separate aggTrade stream to Spot WS (critical fix).
        # The fstream.binance.com multiplexed stream can silently drop aggTrade
        # while keeping kline alive, causing the watchdog to miss the dead sub-stream.
        # Solution: run aggTrade on the unrestricted Spot WebSocket independently.
        self.ws_url_futures = (
            f"{base_url}/stream?streams="
            f"{self.symbol}@kline_{self.interval}/"
            f"{self.symbol}@depth20@100ms"
        )
        self.ws_url_aggtrade = (
            f"wss://stream.binance.com/stream?streams={self.symbol}@aggTrade"
        )
        self.ws_url = self.ws_url_futures  # default for run()
        self.is_running = False
        self._rest_fetch_lock = asyncio.Lock()
        self._last_funding_fetch: float = 0.0   # epoch-seconds of last funding rate REST call
        self._funding_backoff_until: float = 0.0
        self._funding_backoff_s: float = 60.0
        self._funding_last_error_log: float = 0.0
        self._funding_poll_interval_s: float = 300.0
        self._last_kline_frame_ts: float = time.time()  # epoch-seconds of last kline WS frame received
        # H1 FIX: Persistent httpx client for REST API calls — reused across
        # _fetch_funding_rate and _fetch_historical_candles_rest.  Eliminates
        # TLS handshake overhead on every 60s funding poll.
        self._http: httpx.AsyncClient = None

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=10.0, limits=httpx.Limits(max_keepalive_connections=5, max_connections=10))
        return self._http

    async def _close_http(self):
        if self._http is not None:
            await self._http.aclose()
            self._http = None

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
        now = time.time()
        if now < self._funding_backoff_until:
            return
        if self._last_funding_fetch and (now - self._last_funding_fetch) < self._funding_poll_interval_s:
            return

        url = f"{self.rest_url}/fapi/v1/premiumIndex"
        params = {"symbol": self.symbol.upper()}
        import os
        api_key = os.environ.get("BINANCE_API_KEY", "")
        headers = {"X-MBX-APIKEY": api_key} if api_key else {}
        try:
            client = await self._get_http()
            resp = await client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            rate = float(data.get("lastFundingRate", 0.0))
            self.state.funding_rate = rate
            self._last_funding_fetch = time.time()
            self._funding_backoff_s = 60.0
            self._funding_backoff_until = 0.0
            # NEW: Track Futures-Spot basis for SL/TP price correction
            mark_price = float(data.get("markPrice", 0.0))
            index_price = float(data.get("indexPrice", 0.0))
            if mark_price > 0 and len(self.state.candles) > 0:
                spot_close = self.state.candles[-1]["close"]
                self.state.basis = mark_price - spot_close   # positive = Futures premium
                self.state.mark_price = mark_price
            else:
                self.state.basis = 0.0
                self.state.mark_price = mark_price
            logger.info(
                f"[DataFeed] Funding rate: {rate:+.6f} ({rate*100:+.4f}%) | "
                f"Basis: {getattr(self.state, 'basis', 0.0):+.2f}"
            )
        except Exception as e:
            msg = str(e)
            if "429" in msg or "Too Many Requests" in msg:
                self._funding_backoff_until = time.time() + self._funding_backoff_s
                self._funding_backoff_s = min(self._funding_backoff_s * 2, 1800.0)
            now = time.time()
            if now - self._funding_last_error_log >= 300:
                logger.warning(f"[DataFeed] Failed to fetch funding rate: {e}")
                self._funding_last_error_log = now

    async def funding_rate_loop(self):
        """
        PHASE-0.3: Standalone funding rate fetch loop.
        Runs independently of the WebSocket connection, polling every 60 s.
        Removes the funding fetch from inside the WS handler (which was
        silently dropped on reconnect without retry).
        """
        # Stagger multi-symbol deployments so BTC/ETH/SOL do not hit REST together.
        await asyncio.sleep(5 + (abs(hash(self.symbol)) % 20))
        while self.is_running:
            await self._fetch_funding_rate()
            try:
                await asyncio.sleep(self._funding_poll_interval_s)
            except asyncio.CancelledError:
                break

    # ------------------------------------------------------------------
    # REST API Prefetch
    # ------------------------------------------------------------------
    async def _fetch_historical_candles_rest(self):
        """Fetch 100 recent candles from Binance USDM Futures REST to warm up the Quant Engine."""
        async with self._rest_fetch_lock:
            # Futures klines live under /fapi/v1/klines, NOT /api/v3/klines (spot)
            url = f"{self.rest_url}/fapi/v1/klines"
            params = {
                "symbol": self.symbol.upper(),
                "interval": self.interval,
                "limit": 500  # was 100
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
                client = await self._get_http()
                resp = await client.get(url, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                # Reset CVD to re-anchor perfectly based on REST history (only on success)
                self.state.cvd = 0.0
                parsed_candles = []
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
                    parsed_candles.append({"close": float(k[4]), "high": float(k[2]), "low": float(k[3]), "volume": float(k[5]), "time": c_data['t'] / 1000.0})
                    self.state.add_candle(c_data, is_final=True)

                    # Rebuild CVD analytically
                    taker_buy_base = float(k[9])
                    vol = float(k[5])
                    self.state.cvd += (2.0 * taker_buy_base) - vol

                logger.info(f"[DataFeed] Successfully loaded {len(self.state.candles)} historical candles. CVD rebuilt: {self.state.cvd:.0f}")
                self.candles_seeded = True
                self.state._seeding_complete = True
                self.state._live_candle_count = 0
                return parsed_candles
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
        if not getattr(self, "candles_seeded", False):
            await self._fetch_historical_candles_rest()

        while self.is_running:
            try:
                # Re-seed if reconnect cleared candles_seeded flag
                if not getattr(self, "candles_seeded", False):
                    await self._fetch_historical_candles_rest()

                logger.info(f"[DataFeed] Connecting → {self.ws_url}")
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=30,
                    close_timeout=10
                ) as ws:
                    retry_delay = 1  # Reset back-off on successful connect
                    # C1 FIX: Do NOT reset CVD here. The aggTrade stream resumes from where
                    # it left off; setting cvd=0 creates a spurious delta spike on every
                    # reconnect. The REST prefetch already rebuilds the CVD baseline once
                    # at startup (candles_seeded=True after that); on reconnect the stream
                    # continues accumulating from its current value — no reset needed.
                    logger.info("[DataFeed] Connected ✓")
                    # PHASE-0.3: Fetch funding rate immediately on connection (before WS loop)
                    asyncio.create_task(self._fetch_funding_rate())
                    import asyncio as _asyncio
                    while self.is_running and not self.state._reconnect_event.is_set():
                        try:
                            msg = await _asyncio.wait_for(ws.recv(), timeout=60)
                            await self._handle_message(msg)
                        except _asyncio.TimeoutError:
                            logger.warning("[DataFeed] recv() timeout (60s) — connection may be frozen. Reconnecting...")
                            break
                        except websockets.exceptions.ConnectionClosedOK:
                            break
                    # Clear reconnect signal so the outer loop reconnects immediately
                    if self.state._reconnect_event.is_set():
                        self.state._reconnect_event.clear()
                        self._last_kline_frame_ts = time.time()
                        self.state._last_closed_candle_ts = time.time()
                        # FIX: Re-fetch historical candles on reconnect so the candle
                        # buffer is re-anchored from REST rather than continuing with
                        # whatever stale data was in the deque before the disconnect.
                        self.candles_seeded = False
                        logger.info('[DataFeed] Reconnect event consumed - reconnecting now. REST re-seed will follow.')

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

    # ------------------------------------------------------------------
    # FIX-A: Separate aggTrade WebSocket on Spot (resolves dead stream issue)
    # ------------------------------------------------------------------
    async def run_aggtrade(self):
        """
        Dedicated aggTrade stream on the unrestricted Spot WebSocket.
        Binance aggTrade is identical on Spot and Futures (documented parity).
        Running this separately from run() ensures aggTrade never goes silently
        dead while kline frames keep the futures socket alive.
        """
        self.is_running = True
        retry_delay = 1
        while self.is_running:
            try:
                logger.info(f"[DataFeed/aggTrade] Connecting → {self.ws_url_aggtrade}")
                async with websockets.connect(
                    self.ws_url_aggtrade,
                    ping_interval=20,
                    ping_timeout=30,
                    close_timeout=10
                ) as ws:
                    retry_delay = 1
                    logger.info("[DataFeed/aggTrade] Connected ✓")
                    import asyncio as _asyncio
                    while self.is_running:
                        try:
                            msg = await _asyncio.wait_for(ws.recv(), timeout=60)
                            await self._handle_message(msg)
                        except _asyncio.TimeoutError:
                            logger.warning("[DataFeed/aggTrade] recv() timeout — reconnecting...")
                            break
                        except websockets.exceptions.ConnectionClosedOK:
                            break
            except websockets.exceptions.ConnectionClosed as e:
                logger.warning(f"[DataFeed/aggTrade] Connection dropped: {e}. Retrying in {retry_delay}s…")
            except OSError as e:
                logger.error(f"[DataFeed/aggTrade] Network error: {e}. Retrying in {retry_delay}s…")
            except Exception as e:
                logger.error(f"[DataFeed/aggTrade] Unexpected error: {e}", exc_info=True)

            if self.is_running:
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)

    async def feed_health_monitor(self, notifier=None):
        """
        Feed health monitor — runs as an independent async task.
        Checks every 60s whether a CLOSED kline candle was received within
        1.5× the candle interval (22.5 min for 15m candles).

        FIX: Tracks _last_closed_candle_ts (not _last_kline_frame_ts).
        Live-tick kline frames arrive every second and keep recv() alive even
        when the kline sub-stream has silently dropped. Only a CLOSED candle
        (is_final=True) proves the stream is genuinely delivering data.

        FIX: Threshold reduced from 3× to 1.5× interval (was 45 min → now 22.5 min).
        On stale detection, forces reconnect and triggers REST re-seed so the
        bot doesn't trade on frozen metrics.
        """
        interval_secs = {
            "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600
        }.get(self.interval, 900)
        # FIX-STALE: Tightened from 1.5× (22.5 min) to 1.1× (~16.5 min).
        # The old 1.5× threshold was never hit in practice because the monitor's
        # 2× initial sleep (30 min) meant the first check only happened at 30 min,
        # and by then the main loop's 2.5× emergency guard (37.5 min) had already
        # caught it. Now the monitor proactively forces reconnect at ~16.5 min,
        # well before main.py's last-resort guard ever fires.
        stale_threshold = interval_secs * 1.1  # ~16.5 min for 15m candles

        # FIX-STALE: Reduced initial sleep from 2× to 1× interval (15 min for 15m).
        # A closed candle should arrive within one full interval of the feed starting.
        # Waiting 2 full intervals (30 min) meant the monitor was blind during exactly
        # the window when silent disconnects most commonly occur after boot.
        await asyncio.sleep(interval_secs * 1)

        while self.is_running:
            await asyncio.sleep(60)
            if not self.is_running:
                break

            # Use closed-candle timestamp — live-tick updates don't count
            age = time.time() - self.state._last_closed_candle_ts
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
                self.state._reconnect_event.set()
                logger.info("[DataFeed] Feed health monitor forcing WS reconnect.")

            # PHASE-2.2: aggTrade stream watchdog (count-delta based)
            # measurement cycle can detect a dead stream without needing a
            # warmup cycle.
            _prev_count  = getattr(self, "_aggtrade_watchdog_prev_count", 0)
            _curr_count  = getattr(self.state, "_aggtrade_msg_count", 0)
            now          = time.time()
            elapsed      = now - getattr(self.state, "_aggtrade_count_reset_ts", now)

            if elapsed >= 60.0:
                msgs_per_min = int(_curr_count / max(elapsed, 1) * 60)
                self.state.msgs_per_min = msgs_per_min  # FIX-M10: expose for signal gate
                logger.info(f"[DataFeed] aggTrade throughput: {msgs_per_min} msgs/min (Δ={_curr_count - _prev_count})")

                # P2 FIX: Skip first 60s window. The timer starts at bot launch before
                # the websocket is fully connected/authenticated, so the stream is
                # legitimately empty. Don't false-positive the watchdog on first cycle.
                if self._aggtrade_watchdog_first_cycle:
                    logger.info("[DataFeed] aggTrade watchdog: skipping first-cycle guard (warmup window).")
                    self._aggtrade_watchdog_first_cycle = False
                    self._aggtrade_watchdog_prev_count = _curr_count
                    self.state._aggtrade_msg_count     = 0
                    self.state._aggtrade_count_reset_ts = now
                    continue  # P6 FIX: keep monitor loop alive, not return

                # FIX-AUDIT: Only advance the baseline if we actually received msgs.
                # If msgs_per_min==0 the baseline should NOT advance — it must stay
                # at the last known good value so the NEXT 60s window can properly
                # detect a second consecutive zero and trigger reconnect.
                if msgs_per_min > 0:
                    self._aggtrade_watchdog_prev_count = _curr_count
                # Reset counter regardless so the rate calculation stays fresh
                self.state._aggtrade_msg_count     = 0
                self.state._aggtrade_count_reset_ts = now

                if msgs_per_min == 0 and self._aggtrade_watchdog_prev_count >= 0:
                    # Two consecutive dead cycles (baseline didn't advance last cycle AND still 0 this cycle)
                    trade_age = time.time() - getattr(self.state, "_last_trade_ts", 0)
                    logger.warning(
                        f"[DataFeed] ⚠️ aggTrade sub-stream DEAD — 0 msgs/min for 2+ cycles, "
                        f"last trade {trade_age:.0f}s ago. Forcing WebSocket reconnect."
                    )
                    if notifier and trade_age > 75:
                        try:
                            await notifier.send_message(
                                f"⚠️ aggTrade stream dead ({trade_age:.0f}s). "
                                "Forcing reconnect — CVD/tape will be briefly unreliable."
                            )
                        except Exception:
                            pass
                    self.state._reconnect_event.set()
                    logger.info("[DataFeed] aggTrade watchdog: _reconnect_event set.")



    def stop(self):
        logger.info("[DataFeed] Stop requested.")
        self.is_running = False

    async def aclose(self):
        """Close all persistent HTTP clients. Call on shutdown."""
        await self._close_http()

    async def run_user_data_stream(self, api_key: str, on_fill_callback) -> None:
        """
        Binance USDM Futures user data stream for real-time fill detection.
        Subscribes to ORDER_TRADE_UPDATE events to detect position closes immediately.
        Run as a separate asyncio.create_task() alongside run().
        """
        import httpx as _httpx

        if "testnet" in self.rest_url:
            listen_key_url = f"{self.rest_url}/fapi/v1/listenKey"
            ws_base = "wss://stream.binancefuture.com"
        else:
            listen_key_url = "https://fapi.binance.com/fapi/v1/listenKey"
            ws_base = "wss://fstream.binance.com"

        headers = {"X-MBX-APIKEY": api_key}

        # H1 FIX: Persistent HTTP client for user data stream (listenKey create + keepalive)
        _uds_client: Optional[httpx.AsyncClient] = None

        while self.is_running:
            try:
                # Create listenKey
                if _uds_client is None:
                    _uds_client = httpx.AsyncClient(timeout=10.0, limits=httpx.Limits(max_keepalive_connections=3))
                resp = await _uds_client.post(listen_key_url, headers=headers)
                resp.raise_for_status()
                listen_key = resp.json()["listenKey"]

                logger.info(f"[UserDataStream] listenKey created ✓")

                # Keepalive — Binance expires listenKey after 60 min without ping
                async def _keepalive():
                    nonlocal _uds_client  # P4 FIX: without nonlocal, assignment makes _uds_client local to _keepalive
                    while self.is_running:
                        await asyncio.sleep(29 * 60)
                        if _uds_client is None:
                            _uds_client = httpx.AsyncClient(timeout=5.0, limits=httpx.Limits(max_keepalive_connections=2))
                        try:
                            await _uds_client.put(
                                listen_key_url, headers=headers,
                                params={"listenKey": listen_key}
                            )
                            logger.info("[UserDataStream] listenkey keepalive ✓")
                        except Exception as e:
                            logger.warning(f"[UserDataStream] Keepalive failed: {e}")

                keepalive_task = asyncio.create_task(_keepalive())
                try:
                    async with websockets.connect(
                        f"{ws_base}/ws/{listen_key}",
                        ping_interval=20, ping_timeout=30
                    ) as ws:
                        logger.info("[UserDataStream] Connected ✓")
                        while self.is_running:
                            try:
                                raw = await asyncio.wait_for(ws.recv(), timeout=60)
                                event = json.loads(raw)
                                if event.get("e") == "ORDER_TRADE_UPDATE":
                                    order = event.get("o", {})
                                    if order.get("X") == "FILLED" and order.get("R"):
                                        order_id = order.get("i")
                                        event_time = event.get("E")
                                        fill_id = f"{order_id}_{event_time}"
                                        pnl = float(order.get("rp", 0.0))
                                        logger.info(
                                            f"[UserDataStream] Fill: orderId={order_id} "
                                            f"PnL=${pnl:.2f}"
                                        )
                                        await on_fill_callback(pnl, fill_id)
                            except asyncio.TimeoutError:
                                logger.warning("[UserDataStream] recv timeout — reconnecting")
                                break
                finally:
                    if not keepalive_task.done():
                        keepalive_task.cancel()
                        try:
                            await keepalive_task
                        except asyncio.CancelledError:
                            pass

            except Exception as e:
                logger.warning(f"[UserDataStream] Error: {e} — retry in 10s")
                await asyncio.sleep(10)
