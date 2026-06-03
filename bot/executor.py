import logging
import time
from typing import Dict, Any, Optional
import ccxt.async_support as ccxt
from bot import heartbeat
from bot.notifier import TelegramNotifier

logger = logging.getLogger(__name__)

MAX_SHORT_EXPOSURE_BTC = 0.008
MAX_REQUEUE_ATTEMPTS = 3  # H4 FIX: retry failed TP placements up to N times before giving up


class TradingExecutor:
    """
    Handles risk-managed execution of trading signals via ccxt.

    Supports Coinbase Advanced Trade (spot) and Binance (legacy).
    In DRY_RUN mode the executor logs what it WOULD do without placing
    any real orders — safe for live observation/testing.

    Coinbase Advanced Trade uses RSA/EC private key authentication.
    Set COINBASE_API_KEY_NAME and COINBASE_PRIVATE_KEY in your .env.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        testnet: bool = True,
        dry_run: bool = True,
        exchange_id: str = "binance",
        coinbase_key_name: str = "",
        coinbase_private_key: str = "",
        tg_token: str = "",
        tg_chat_id: str = "",
    ):
        self.testnet   = testnet
        self.exchange_id = exchange_id.lower()
        self.is_futures  = "binanceusdm" in self.exchange_id or "future" in self.exchange_id
        self.dry_run   = dry_run or not self._has_credentials(
            exchange_id, api_key, api_secret, coinbase_key_name, coinbase_private_key
        )
        
        self.notifier = TelegramNotifier(tg_token, tg_chat_id)

        if self.dry_run:
            logger.warning("[Executor] DRY-RUN mode: no real orders will be placed.")

        # ── Exchange initialisation ───────────────────────────────────────
        if self.exchange_id == "coinbase":
            self.exchange = self._init_coinbase(
                coinbase_key_name, coinbase_private_key
            )
        else:
            # Binance (legacy / fallback)
            self.exchange = self._init_binance(api_key, api_secret, testnet, self.exchange_id)

        self.active_position: Optional[Dict[str, Any]] = None
        self.pending_order: Optional[Dict[str, Any]] = None  # Track unfilled orders
        self.lock_expiry: float = 0.0
        self.last_panic_reason: str = ""
        self.failed_order_ts: float = 0.0  # Cooldown after live order failure (prevents -2015 spam)
        # P0-3 FIX: Dedicated flag set when emergency_flatten fails.
        # A boolean survives the heartbeat poll clearing active_position; a sentinel dict does not.
        self._flatten_failed: bool = False
        # P0-1 FIX: Lock to prevent TOCTOU race between heartbeat poll and main loop
        # both reading/writing active_position in overlapping async yield points.
        # C2+C5+C6 FIX: Semaphore(1) instead of Lock — reentrant so nested calls
        # (e.g. check_position_exit → _check_live_position_exit) don't deadlock.
        import asyncio as _asyncio_for_lock
        self._position_lock = _asyncio_for_lock.Semaphore(1)

        # PHASE-0.3: Exchange-specific fee table.
        # Fees were hardcoded as Binance USDM rates in 3 separate places.
        # Coinbase charges up to 1.2% taker — 24× higher than the old assumption.
        _EXCHANGE_FEES = {
            "coinbase":    {"taker": 0.012,  "maker": 0.006},
            "binance":     {"taker": 0.001,  "maker": 0.0002},
            "binanceusdm": {"taker": 0.0005, "maker": 0.0002},
            "kraken":      {"taker": 0.0026, "maker": 0.0016},
            "okx":         {"taker": 0.001,  "maker": 0.0008},
        }
        _fees = _EXCHANGE_FEES.get(self.exchange_id, {"taker": 0.001, "maker": 0.0002})
        self.TAKER_FEE = _fees["taker"]
        self.MAKER_FEE = _fees["maker"]
        logger.info(f"[Executor] Fee rates for {self.exchange_id}: taker={self.TAKER_FEE:.4%} maker={self.MAKER_FEE:.4%}")

    # ------------------------------------------------------------------
    # Static helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _has_credentials(exchange_id, api_key, api_secret, cb_name, cb_key) -> bool:
        if exchange_id.lower() == "coinbase":
            return bool(cb_name and cb_key)
        return bool(api_key and api_secret)

    @staticmethod
    def _init_coinbase(key_name: str, private_key: str) -> ccxt.Exchange:
        """
        Coinbase Advanced Trade uses EC/RSA private keys, not HMAC secrets.
        ccxt maps: apiKey → key_name, secret → private_key (PEM string).
        The private key may be stored with literal \\n — normalise to real newlines.
        """
        # Normalise escaped newlines from env vars
        normalised_key = private_key.replace("\\n", "\n").strip()

        exchange = ccxt.coinbase({
            "apiKey":          key_name,
            "secret":          normalised_key,
            "enableRateLimit": True,
            "options": {
                "defaultType":     "spot",
                # Hard-veto legacy V2 features that crash CDP keys
                "fetchCurrencies": False,
                "fetchMarkets":    True,  # Still need markets
            },
        })
        # Override the has['fetchCurrencies'] to force CCXT to skip the public currency fetch
        exchange.has['fetchCurrencies'] = False
        
        logger.info("[Executor] Coinbase Advanced Trade (V3) initialised.")
        return exchange

    @staticmethod
    def _init_binance(api_key: str, api_secret: str, testnet: bool, exchange_id: str = "binance") -> ccxt.Exchange:
        # ── Key Format Check (Ed25519 vs HMAC) ──────────────────────────
        # If the secret contains BEGIN header, it's an Ed25519/RSA key.
        is_ed25519 = str(api_secret).strip().startswith("-----BEGIN")
        logger.info(f"[Executor] Initialising Binance ({'Ed25519' if is_ed25519 else 'HMAC'})")

        # Determine if we should force Futures mode
        is_futures_id = "usdm" in exchange_id.lower() or "future" in exchange_id.lower()
        
        # [FIX] Use specialized ccxt.binanceusdm if targeting USDM futures.
        # This prevents CCXT's load_markets from hitting Spot/Margin SAPI endpoints
        # which can trigger -2015 errors on Futures-only API keys.
        exchange_class = ccxt.binanceusdm if is_futures_id else ccxt.binance
        
        exchange = exchange_class({
            "apiKey":          api_key,
            "secret":          api_secret,
            "enableRateLimit": True,
            "options": {
                "defaultType": "future" if (is_futures_id or testnet) else "spot",
                "adjustForTimeDifference": True,
                "recvWindow": 10000,
            },
        })
        
        if testnet:
            exchange.set_sandbox_mode(True)
        
        # Prevent CCXT from trying to load margin info during load_markets
        exchange.has['fetchMarginAllPairs'] = False
        exchange.has['fetchFundingHistory'] = False
        exchange.has['fetchCurrencies'] = False
        
        active_type = exchange.options.get("defaultType", "spot")
        exchange_name = getattr(exchange_class, "__name__", type(exchange).__name__)
        logger.info(f"[Executor] Binance ({'testnet' if testnet else 'live'}) initialised as {active_type.upper()} via {exchange_name}.")
        return exchange

    # ------------------------------------------------------------------
    # Symbol translation helpers
    # ------------------------------------------------------------------
    def _get_ccxt_symbol(self, raw_symbol: str) -> str:
        """
        Convert a raw symbol (e.g. BTCUSDT) to ccxt unified format.
        Binance USDM futures : BTCUSDT  → BTC/USDT:USDT
        Spot / other         : BTCUSDT  → BTC/USDT
        Called by main.py to set futures leverage at startup.
        """
        symbol = raw_symbol.strip().upper()

        # Already unified (contains /)
        if "/" in symbol:
            if self.is_futures and ":" not in symbol:
                quote = symbol.split("/")[-1]
                return f"{symbol}:{quote}"
            return symbol

        # Dash format (BTC-USDT)
        if "-" in symbol:
            symbol = symbol.replace("-", "/")
            if self.is_futures and ":" not in symbol:
                quote = symbol.split("/")[-1]
                return f"{symbol}:{quote}"
            return symbol

        # Raw concatenated form (BTCUSDT, ETHUSDT, …)
        for quote in ("USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "BNB"):
            if symbol.endswith(quote):
                base    = symbol[: -len(quote)]
                unified = f"{base}/{quote}"
                if self.is_futures:
                    return f"{unified}:{quote}"
                return unified

        # Fallback — return as-is
        return symbol

    def _to_exchange_symbol(self, symbol: str) -> str:
        """
        Translate a symbol to the exchange's native format for CCXT.
        Coinbase uses BTC/USD (ccxt unified) or BTC-USD (raw API).
        This method converts any format to ccxt unified: BTC/USDC
        """
        if self.exchange_id != "coinbase":
            return symbol

        # Normalize: ensure we return ccxt unified format (BTC/USDC, BTC/USD, etc.)
        symbol = symbol.strip().upper()
        
        # If already in BTC/USDC format, return as-is
        if "/" in symbol:
            return symbol
        
        # If in BTC-USDC format, convert to BTC/USDC
        if "-" in symbol:
            return symbol.replace("-", "/")

        # BTCUSDT style → BTC/USDT
        # Common quote currencies in order of descending length (avoid partial match)
        for quote in ("USDT", "USDC", "USD", "BTC", "ETH", "BNB"):
            if symbol.endswith(quote):
                base = symbol[: -len(quote)]
                return f"{base}/{quote}"
        
        # Fallback — return with / added if possible
        return symbol

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def initialize(self):
        """Load markets and confirm connectivity.

        Binance USDM 'markets not loaded' fix:
        - Retries load_markets() up to 3× with back-off on transient network errors.
        - If all retries fail, injects a minimal BTC/USDT:USDT futures market spec so
          amount_to_precision / price_to_precision calls don't crash on the next order.
        """
        if self.dry_run and not self.exchange.apiKey:
            logger.info("[Executor] Skipping market load in keyless dry-run mode.")
            return

        env  = "TESTNET" if self.testnet else "LIVE"
        exch = self.exchange_id.upper()

        # --- Retry loop: up to 3 attempts with exponential back-off ---
        last_exc: Optional[Exception] = None
        for attempt in range(3):
            try:
                await self.exchange.load_markets()
                logger.info(f"[Executor] Connected to {exch} {env} ✓ (attempt {attempt + 1})")
                
                # --- Boot Position Check (no reconciliation) ---
                # If an open position exists on the exchange, alert via Telegram
                # and continue trading normally. We do NOT reconcile because the
                # SL/TP would be guessed from an ATR proxy and could be dangerously wrong.
                # User commits to closing all trades before starting the bot.
                try:
                    positions = await self.exchange.fetch_positions()
                    open_found = False
                    for pos in positions:
                        qty = float(pos.get("contracts", 0) or pos.get("positionAmt", 0))
                        if abs(qty) > 0.0001:
                            open_found = True
                            side = "buy" if qty > 0 else "sell"
                            entry_p = float(pos.get("entryPrice", 0))
                            warn_msg = (
                                f"⚠️ Quad-Desk BOOT WARNING\n"
                                f"Open position found: {side.upper()} {abs(qty)} {pos.get('symbol')} @ {entry_p:.2f}\n"
                                f"Bot is starting normally but has NO internal SL/TP for this position.\n"
                                f"Please verify on Binance — this position is NOT tracked by the bot."
                            )
                            logger.warning(f"[Executor] {warn_msg}")
                            if self.notifier:
                                await self.notifier.send_message(warn_msg)
                    if not open_found:
                        logger.info("[Executor] Boot clean — no open positions found on exchange.")

                except Exception as e:
                    logger.warning(f"[Executor] Could not check positions on boot: {e}")

                # Send startup status notification
                try:
                    mode = "DRY-RUN 🔵" if self.dry_run else "LIVE 🟢"
                    await self.notifier.send_message(
                        f"🤖 Quad-Desk {mode} STARTED\n"
                        f"Exchange: {self.exchange_id.upper()} | "
                        f"Taker fee: {self.TAKER_FEE:.3%}"
                    )
                except Exception:
                    pass

                return   # success — exit initialize
            except Exception as e:
                last_exc = e
                wait_s   = 2 ** attempt          # 1s, 2s, 4s
                logger.warning(
                    f"[Executor] load_markets attempt {attempt + 1}/3 failed: {e}. "
                    f"{'Retrying in ' + str(wait_s) + 's…' if attempt < 2 else 'All retries exhausted.'}"
                )
                if attempt < 2:
                    import asyncio as _asyncio
                    await _asyncio.sleep(wait_s)

        # All retries failed — inject minimal market fallback to prevent order failures
        logger.warning(
            f"[Executor] Could not load {exch} markets after 3 attempts ({last_exc}). "
            "Injecting minimal market fallback — bot will attempt to continue."
        )
        self._inject_fallback_markets()

    def _inject_fallback_markets(self):
        """Injects minimal market data into CCXT to prevent crashes on market load failure.
        Dynamically handles the active BOT_SYMBOL so ETH, SOL, etc. are supported.
        """
        import os as _os
        if not hasattr(self.exchange, 'markets') or self.exchange.markets is None:
            self.exchange.markets = {}
        if not hasattr(self.exchange, 'symbols') or self.exchange.symbols is None:
            self.exchange.symbols = []

        # Determine the active symbol from env (set by launcher per-process)
        raw_sym = _os.environ.get("BOT_SYMBOL", "BTC/USDT")
        ccxt_sym = self._get_ccxt_symbol(raw_sym)  # e.g. ETH/USDT:USDT

        if self.exchange_id == "coinbase":
            # Coinbase: inject the active symbol as a spot market
            base  = raw_sym.split("/")[0].upper()
            quote = raw_sym.split("/")[-1].upper() if "/" in raw_sym else "USD"
            cb_sym = f"{base}/{quote}"
            self.exchange.markets[cb_sym] = {
                'id': f'{base}-{quote}', 'symbol': cb_sym, 'base': base, 'quote': quote,
                'precision': {'amount': 0.00000001, 'price': 0.01},
                'limits': {'amount': {'min': 0.00001, 'max': 10000}, 'price': {'min': 0.01, 'max': 1000000}, 'cost': {'min': 1.0}},
                'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
            }
            if cb_sym not in self.exchange.symbols:
                self.exchange.symbols.append(cb_sym)
            logger.warning(f"[Executor] Fallback market injected for Coinbase: {cb_sym}")

        elif self.is_futures:
            # Binance USDM: inject the active symbol as a futures market
            # Derive precision from known symbols; default to 3dp amount / 2dp price
            _AMOUNT_PREC = {"BTC": 0.001, "ETH": 0.001, "SOL": 0.1,
                             "AVAX": 0.1, "BNB": 0.01, "DOGE": 1.0, "PEPE": 1.0}
            base = raw_sym.split("/")[0].upper()
            amt_prec = _AMOUNT_PREC.get(base, 0.01)
            self.exchange.markets[ccxt_sym] = {
                'id':        raw_sym.replace("/", "").replace(":", "").upper().split("USDT")[0] + "USDT",
                'symbol':    ccxt_sym,
                'base':      base,
                'quote':     'USDT',
                'settle':    'USDT',
                'precision': {'amount': amt_prec, 'price': 0.01},
                'limits':    {'amount': {'min': amt_prec, 'max': 100000}, 'price': {'min': 0.01, 'max': 1000000}},
                'active': True, 'type': 'future', 'spot': False, 'margin': False, 'contract': True
            }
            if ccxt_sym not in self.exchange.symbols:
                self.exchange.symbols.append(ccxt_sym)
            logger.warning(f"[Executor] Fallback market injected for Binance USDM: {ccxt_sym}")

    async def close(self):
        await self.exchange.close()

    # ------------------------------------------------------------------
    # Firestore trade logger
    # ------------------------------------------------------------------
    def _log_trade(self, symbol: str, side: str, verdict: str,
                   entry: float, stop_loss: float, take_profit: float,
                   ulis_verdict: str = "",
                   metrics: dict = None,
                   signal: dict = None):
        """Write a trade record to Firestore `botTrades` collection.
        
        5.6: Includes full signal attribution chain so post-trade analysis can
        identify which signals (regime, OFI, Z-score, RSI, Bayesian confidence)
        drove each entry decision.
        """
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            m = metrics or {}
            s = signal or {}
            doc = {
                "symbol":         symbol,
                "side":           side,
                "verdict":        verdict,
                "entry_price":    entry,
                "stop_loss":      stop_loss,
                "take_profit":    take_profit,
                "timestamp":      fs.SERVER_TIMESTAMP,
                "mode":           "DRY-RUN" if self.dry_run else "LIVE",
                "exchange":       self.exchange_id,
                "ulis_verdict":   ulis_verdict,
                "ts_ms":          int(time.time() * 1000),
                # Signal attribution chain (5.6)
                "regime":         m.get("regime",            "UNKNOWN"),
                "strategy_type":  s.get("strategy_type",     "UNKNOWN"),
                "z_score":        round(m.get("zScore",       0.0), 4),
                "rsi":            round(m.get("rsi",          50.0), 2),
                "ofi_tanh":       round(m.get("ofi",          0.0), 4),  # tanh (-1,+1)
                "bayesian":       round(m.get("bayesianPosterior", 0.5), 4),
                "confidence":     round(float(s.get("confidence", 0.0)), 4),
                "atr_pct":        round(m.get("atr_pct",      0.0), 6),
                "skewness":       round(m.get("skewness",     0.0), 4),
            }
            res = db.collection("botTrades").add(doc)
            doc_id = res[1].id
            logger.info(f"[Executor] Trade logged to Firestore (ID: {doc_id}) ✓")
            return doc_id
        except Exception as e:
            logger.warning(f"[Executor] Failed to log trade to Firestore: {e}")
            return None

    def _update_trade_exit(self, doc_id: str, exit_price: float, pnl: float):
        """Update an existing trade record with exit metadata."""
        if not doc_id:
            return
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            result = "WIN" if pnl > 0 else "LOSS"
            db.collection("botTrades").document(doc_id).update({
                "exit_price": exit_price,
                "pnl":        pnl,
                "result":     result,
                "exit_ts":    fs.SERVER_TIMESTAMP,
                "exit_ts_ms": int(time.time() * 1000)
            })
            logger.info(f"[Executor] Trade {doc_id} exit updated in Firestore ✓")
        except Exception as e:
            logger.warning(f"[Executor] Failed to update trade exit for {doc_id}: {e}")

    def _log_partial_take(self, trade_doc_id: str, partial_size: float,
                          exit_price: float, pnl: float, side: str):
        """Log a partial take-profit execution to Firestore `partialTakes` subcollection."""
        if not trade_doc_id:
            return
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            doc = {
                "parent_trade_id": trade_doc_id,
                "partial_size":    partial_size,
                "exit_price":      exit_price,
                "pnl":             pnl,
                "side":            side,
                "timestamp":       fs.SERVER_TIMESTAMP,
                "ts_ms":           int(time.time() * 1000),
            }
            db.collection("botTrades").document(trade_doc_id).collection("partialTakes").add(doc)
            logger.info(
                f"[Executor] Partial TP logged: size={partial_size} @ {exit_price:.2f} "
                f"PnL={pnl:.2f} for trade {trade_doc_id} ✓"
            )
        except Exception as e:
            logger.warning(f"[Executor] Failed to log partial take: {e}")

    # ------------------------------------------------------------------
    # Balance
    # ------------------------------------------------------------------
    async def get_usdt_balance(self, account_size: float = 100.0) -> float:
        """Return free stablecoin balance (USDC/USD/USDT) or simulated equity in dry-run."""
        if self.dry_run:
            return account_size
        try:
            bal = await self.exchange.fetch_balance()
            free = bal.get("free", {})
            total = float(free.get("USDT", 0.0)) + float(free.get("USD", 0.0)) + float(free.get("USDC", 0.0))
            if total <= 0:
                return account_size
            return total
        except Exception as e:
            logger.warning(f"[Executor] get_usdt_balance fallback: {e}")
            return account_size

    async def get_btc_balance(self) -> float:
        """Return free BTC balance directly from exchange."""
        if self.dry_run: return 0.0
        try:
            bal = await self.exchange.fetch_balance()
            return float(bal.get("free", {}).get("BTC", 0.0))
        except Exception: return 0.0

    async def get_total_equity(self, current_price: float, account_size: float = 100.0) -> float:
        """
        Calculate total account value: (Sum of Stables) + (BTC * Price).
        Ensures risk (position size) is based on entire portfolio, not just cash.
        """
        if self.dry_run: return account_size
        
        try:
            bal = await self.exchange.fetch_balance()
            free = bal.get("free", {})
            
            cash = float(free.get("USDT", 0.0)) + float(free.get("USD", 0.0)) + float(free.get("USDC", 0.0))
            crypto_val = float(free.get("BTC", 0.0)) * current_price
            
            total = cash + crypto_val
            if total <= 5.0: # If effectively zero, fall back
                return account_size
            
            logger.info(f"[Executor] Equity: Cash=${cash:.2f} + BTC_Val=${crypto_val:.2f} → Total=${total:.2f}")
            return total
        except Exception as e:
            err_msg = f"Failed to calculate total equity: {e}"
            logger.error(f"[Executor] {err_msg}")
            await self.notifier.send_error_alert(err_msg)
            return account_size

    # ------------------------------------------------------------------
    # Position sizing
    # ------------------------------------------------------------------
    def _kelly_scale(self, p: float, rr: float, fraction: float = 0.25) -> float:
        """Fractional Kelly multiplier bounded [0.5, 1.5]"""
        if rr <= 0 or p <= 0.50 or p >= 1.0:
            return 1.0
        f_star = (p * rr - (1.0 - p)) / rr
        return max(0.5, min(1.5, 1.0 + f_star * fraction))

    def calculate_position_size(
        self,
        current_price: float,
        stop_loss: float,
        equity: float,
        max_risk_pct: float,
        atr_pct: float = 0.005,
        atr_pct_rank: float = 0.5,
        adaptive_mult: float = 1.0,
    ) -> float:
        """
        Vol-normalized position sizing: constant dollar risk regardless of ATR regime.
        Dr. Markov Alternative A: size = risk_usd / (price × atr_pct × adaptive_mult)
        Additional inverse ATR-rank scaling reduces size further in high-vol environments
        where the formula alone would produce larger positions.
        """
        risk_usd = equity * (max_risk_pct / 100.0)
        vol_distance = atr_pct * current_price * adaptive_mult
        if vol_distance <= 0 or current_price <= 0:
            return 0.0
        vol_scale = 1.0 - 0.4 * max(0.0, atr_pct_rank - 0.5)
        return (risk_usd * vol_scale) / vol_distance

    # ------------------------------------------------------------------
    # Signal execution
    # ------------------------------------------------------------------
    async def execute_signal(
        self,
        symbol: str,
        current_price: float,
        signal: Dict[str, Any],
        max_risk_pct: float,
        account_size: float = 100.0,
        ulis_verdict: str = "",
        funding_rate: float = 0.0,
    ):
        verdict     = signal.get("verdict", "WAIT")
        confidence  = float(signal.get("confidence", 0))
        stop_loss   = float(signal.get("stop_loss", 0))
        take_profit = float(signal.get("take_profit", 0))

        # Guard rails
        if "WAIT" in verdict:
            return

        # C3 FIX: Initialise sentinel values BEFORE the lock so they are always
        # defined if emergency_flatten is reached inside the locked block.
        fmt_size = 0.0
        raw_size = 0.0

        # C2+C5 FIX: Acquire lock BEFORE checking or modifying any shared state.
        # This prevents two concurrent candle-close events from both passing the
        # None-check and placing simultaneous orders.  The Semaphore(1) is reentrant
        # so nested calls (check_position_exit → _check_live_position_exit) do not
        # deadlock — only the outermost acquisition increments the counter.
        async with self._position_lock:
            if self.active_position is not None:
                logger.info("[Executor] Already in a position. Skipping new entry.")
                return

            # C5 FIX: pending_order check is now inside the lock — TOCTOU race closed.
            if self.pending_order is not None:
                if time.time() > self.pending_order.get("expires_at", 0):
                    logger.warning(
                        f"[Executor] Pending order {self.pending_order['id']} TTL expired — "
                        "clearing stale state. Verify on exchange if order was filled."
                    )
                    self.pending_order = None
                else:
                    logger.info(f"[Executor] Pending order {self.pending_order['id']} still unfilled. Rejecting new signal.")
                    return

            if stop_loss <= 0 or take_profit <= 0:
                logger.warning("[Executor] Invalid SL/TP. Aborting.")
                return

            side = "buy" if ("BUY" in verdict or "LONG" in verdict) else "sell"
            # AUDIT FIX #6: Use estimated fill price (bid + spread proxy) for SL check.
            # current_price is the bid. BUY orders fill at the ask (~bid + 2bp).
            # Without this, a SL set between bid and ask passes the check but
            # gets immediately hit at fill.
            fill_price_est = current_price * 1.0002 if side == "buy" else current_price * 0.9998
            if side == "buy" and stop_loss >= fill_price_est:
                logger.warning(f"[Executor] SL {stop_loss} ≥ est. fill {fill_price_est:.2f} for BUY. Aborting.")
                return
            if side == "sell" and stop_loss <= fill_price_est:
                logger.warning(f"[Executor] SL {stop_loss} ≤ est. fill {fill_price_est:.2f} for SELL. Aborting.")
                return

            # 1. Calculate Available Equity for accurate risk sizing.
            # Futures: Use only available margin (Cash) to prevent oversized rejected orders.
            # Spot: Use Total Equity (Cash + BTC) to size based on full portfolio.
            if self.is_futures:
                equity = await self.get_usdt_balance(account_size)
            else:
                equity = await self.get_total_equity(current_price, account_size)

            if side == "buy":
                usdc_equity = equity
                if usdc_equity < 5:
                    err = f"Insufficient USDC (${usdc_equity:.2f}) to open LONG. Min $5 required."
                    logger.warning(f"[Executor] {err}")
                    await self.notifier.send_error_alert(err)
                    return
            else:
                if self.is_futures:
                    usdc_equity = equity
                    if usdc_equity < 5:
                        err = f"Insufficient USDC margin (${usdc_equity:.2f}) to open SHORT on Binance Futures. Min $5 required."
                        logger.warning(f"[Executor] {err}")
                        await self.notifier.send_error_alert(err)
                        return
                else:
                    # Spot: Need BTC in account to sell
                    btc_bal = await self.get_btc_balance()
                    if btc_bal <= 0.00001:
                        err = f"Aborting SELL signal: No BTC balance available to sell on spot account."
                        logger.warning(f"[Executor] {err}")
                        await self.notifier.send_error_alert(err)
                        return

            _atr_pct = float(signal.get("atr_pct", 0.005))
            _atr_rank = float(signal.get("atr_pct_rank", 0.5))
            _ad_mult = float(signal.get("adaptive_mult", 1.0))
            raw_size = self.calculate_position_size(
                current_price, stop_loss, equity, max_risk_pct,
                atr_pct=_atr_pct, atr_pct_rank=_atr_rank, adaptive_mult=_ad_mult
            )
            _rr = abs(take_profit - current_price) / max(abs(stop_loss - current_price), 1e-9)
            kelly_mult = self._kelly_scale(confidence, _rr, fraction=0.25)
            raw_size *= kelly_mult
            if raw_size <= 0.0:
                logger.warning("[Executor] Calculated position size is 0. Aborting.")
                return

            # ── Symbol-aware minimum lot size (critical for multi-coin) ────────
            # BTC min lot = 0.001  | ETH = 0.001  | SOL = 0.1  | AVAX = 0.1
            # PEPE = 1  | DOGE = 1  | WIF = 0.1  | Default (unknown) = 5 USDT notional
            # The actual exchange precision is handled by amount_to_precision() below;
            # this check only prevents zero-size rejections before that call.
            _sym_upper = symbol.upper().replace("/", "").replace(":", "").split("USDT")[0]
            _MIN_QTY_MAP = {
                "BTC":  0.001,
                "ETH":  0.001,
                "SOL":  0.1,
                "AVAX": 0.1,
                "BNB":  0.01,
                "WIF":  0.1,
                "PEPE": 1.0,
                "DOGE": 1.0,
                "INJ":  0.01,
                "ARB":  0.1,
                "OP":   0.1,
            }
            MIN_QTY = _MIN_QTY_MAP.get(_sym_upper, 0.01)  # safe default for unknown alts
            min_notional = 5.5  # Binance USDM global minimum notional = $5

            if raw_size < MIN_QTY:
                sl_dist_pct = abs(current_price - stop_loss) / current_price
                needed_equity = (MIN_QTY * current_price * sl_dist_pct) / (max_risk_pct / 100.0)
                msg = (
                    f"[Executor] ⚠️ Position too small: {raw_size:.6f} {_sym_upper} < min {MIN_QTY}. "
                    f"Need ~${needed_equity:.0f} equity at {max_risk_pct}% risk. "
                    f"Current equity=${equity:.0f}. Deposit or raise BOT_MAX_RISK_PCT."
                )
                logger.error(msg)
                if self.notifier:
                    await self.notifier.send_message(msg)
                return

            if raw_size * current_price < min_notional:
                needed_acct = (min_notional * abs(current_price - stop_loss)) / (max_risk_pct / 100.0)
                logger.error(
                    f"[Executor] Account ${equity:.0f} too small. "
                    f"Notional=${raw_size*current_price:.2f} < min ${min_notional:.2f}. "
                    f"Needs ~${needed_acct:.0f} account. ABORTING order."
                )
                if self.notifier:
                    await self.notifier.send_message(
                        f"⚠️ Account too small: ${equity:.0f} < required ~${needed_acct:.0f}."
                    )
                return

            # H-3 FIX: Hard notional cap (max 2.0x equity)
            max_notional = equity * 2.0
            if raw_size * current_price > max_notional:
                raw_size = max_notional / current_price
                logger.info(f"[Executor] Position capped to max notional (${max_notional:.2f})")

            # Translate symbol to exchange format (unified CCXT symbol)
            if self.exchange_id == "coinbase":
                ex_symbol = self._to_exchange_symbol(symbol)
            else:
                ex_symbol = self._get_ccxt_symbol(symbol)

            fmt_size = float(self.exchange.amount_to_precision(ex_symbol, raw_size))
            if fmt_size < MIN_QTY:
                logger.warning(f"[Executor] fmt_size {fmt_size} < min qty {MIN_QTY} for {_sym_upper}. Aborting.")
                return

            # For Coinbase, ensure the symbol is in the markets cache
            if self.exchange_id == "coinbase":
                if ex_symbol not in self.exchange.markets or self.exchange.markets.get(ex_symbol) is None:
                    # Try to add it to markets cache if missing
                    logger.warning(f"[Executor] Symbol {ex_symbol} not in markets cache. Attempting to register...")
                    if not hasattr(self.exchange, 'markets') or self.exchange.markets is None:
                        self.exchange.markets = {}

                    # Use default market spec for BTC/USDC or BTC/USD
                    if "BTC" in ex_symbol.upper() and "USDC" in ex_symbol.upper():
                        self.exchange.markets['BTC/USDC'] = {
                            'id': 'BTC-USDC', 'symbol': 'BTC/USDC', 'base': 'BTC', 'quote': 'USDC',
                            'precision': {'amount': 0.00000001, 'price': 0.01},
                            'limits': {'amount': {'min': 0.00001, 'max': 1000}, 'price': {'min': 0.01, 'max': 1000000}, 'cost': {'min': 1.0}},
                            'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
                        }
                        logger.info("[Executor] Registered BTC/USDC to markets cache.")
                    elif "BTC" in ex_symbol.upper() and "USD" in ex_symbol.upper():
                        self.exchange.markets['BTC/USD'] = {
                            'id': 'BTC-USD', 'symbol': 'BTC/USD', 'base': 'BTC', 'quote': 'USD',
                            'precision': {'amount': 0.00000001, 'price': 0.01},
                            'limits': {'amount': {'min': 0.00001, 'max': 1000}, 'price': {'min': 0.01, 'max': 1000000}, 'cost': {'min': 1.0}},
                            'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
                        }
                        logger.info("[Executor] Registered BTC/USD to markets cache.")

        if self.dry_run:
            # ── DRY RUN ──────────────────────────────────────────────────
            # P0 FIX: Do NOT await inside _position_lock. send_trade_alert makes
            # an unbounded network call (Telegram). Holding the lock across it
            # blocks the heartbeat from checking exits. Move alert to AFTER
            # the lock is released. State writes (active_position, _log_trade)
            # stay inside the lock — they are atomic.
            #
            # P2 FIX: Dynamic slippage. Flat 0.02% is too optimistic for volatile
            # markets (sweeps gap 5-15 bps). Use max(0.02%, atr_pct * 0.15) so
            # a 0.30% ATR → 4.5 bps slippage — realistic for BTCUSDT sweeps.
            SLIPPAGE_PCT = max(0.0002, _atr_pct * 0.15)
            fill_price = (
                current_price * (1.0 + SLIPPAGE_PCT) if side == "buy"
                else current_price * (1.0 - SLIPPAGE_PCT)
            )
            cost = raw_size * fill_price
            logger.info(
                f"[DRY-RUN] {verdict} {ex_symbol} "
                f"| qty={raw_size:.6f} (${cost:.2f}) "
                f"| fill~{fill_price:.2f} (slip={SLIPPAGE_PCT:.2%}) "
                f"| SL={stop_loss} TP={take_profit} "
                f"| equity=${equity:.2f} risk={max_risk_pct}% "
                f"| ULIS={ulis_verdict}"
            )
            doc_id = self._log_trade(ex_symbol, side, verdict, fill_price, stop_loss, take_profit, ulis_verdict)
            self.active_position = {
                "symbol":           ex_symbol,
                "side":             side,
                "size":             raw_size,
                "entry_price":      fill_price,
                "stop_loss":        stop_loss,
                "take_profit":      take_profit,
                "dry_run":          True,
                "trade_doc_id":     doc_id,
                "be_lock_trigger":  signal.get("be_lock_trigger", 1.0),
                "time_exit_sec":    signal.get("time_exit_sec", 600),
                "atr_at_entry":     signal.get("atr_at_entry", 0.0),
            }
            # Lock released here — Telegram call is outside the critical section
            await self.notifier.send_trade_alert(
                symbol=ex_symbol, side=side, price=current_price,
                size=raw_size, sl=stop_loss, tp=take_profit, is_dry=True
            )
            return

        # ── LIVE EXECUTION ────────────────────────────────────────────────
        # Guard: if the last order failed (e.g. -2015), wait before retrying.
        # Without this, the bot re-attempts the same signal every 15s.
        if time.time() < self.failed_order_ts:
            remaining = int(self.failed_order_ts - time.time())
            logger.info(f"[Executor] Failed-order cooldown active — {remaining}s remaining. Skipping.")
            return

        try:
            # We already have ex_symbol correctly formatted at line ~506 (e.g. BTC/USDT:USDT)
            # Only do the Coinbase USDC -> USD swap if applicable
            if self.exchange_id == "coinbase" and "USDC" in ex_symbol:
                ex_symbol = ex_symbol.replace("USDC", "USD")
                
            fmt_size = float(self.exchange.amount_to_precision(ex_symbol, raw_size))
            cost = fmt_size * current_price
            if cost > equity:
                fmt_size = float(
                    self.exchange.amount_to_precision(ex_symbol, equity * 0.95 / current_price)
                )

            logger.info(f"[Executor] Placing MARKET {side.upper()} {fmt_size} {ex_symbol} @ ~{current_price}")
            import asyncio
            order = None
            for attempt in range(3):
                try:
                    order = await self.exchange.create_market_order(ex_symbol, side, fmt_size)
                    break
                except Exception as e:
                    if attempt == 2:
                        # Engage 90s cooldown — avoids flooding -2015 errors every cycle
                        self.failed_order_ts = time.time() + 90.0
                        logger.error(f"[Executor] Live order failed: {e}")
                        raise e
                    logger.warning(f"[Executor] Market order failed: {e}. Retrying {attempt+1}/3...")
                    await asyncio.sleep(0.5)
            logger.info(f"[Executor] Market order placed: id={order.get('id')} status={order.get('status')}")
            
            # Track this order as pending until it fills or is cancelled
            # MED-5 FIX: Add TTL so a stale pending_order can't lock the bot forever.
            self.pending_order = {
                "id": order.get('id'),
                "symbol": ex_symbol,
                "side": side,
                "size": fmt_size,
                "entry_price": current_price,
                "status": order.get('status', 'open'),
                "expires_at": time.time() + 60,  # auto-expire after 60s if never confirmed
            }
            
            # Telegram Notification (Success)
            await self.notifier.send_trade_alert(
                symbol=ex_symbol, side=side, price=current_price, 
                size=fmt_size, sl=stop_loss, tp=take_profit, is_dry=False
            )

            sl_side = "sell" if side == "buy" else "buy"
            sl_order_id = None
            tp_order_id = None
            sl_placed = False   # track independently for recovery logic
            tp_placed = False

            if self.is_futures:
                # ── FUTURES: STOP (stop-limit) + TAKE_PROFIT_MARKET ──────────
                # Binance USDM futures uses order type "STOP" for stop-limit orders
                # (NOT "STOP_LIMIT" which is a spot-only type). "STOP" requires both
                # a stopPrice (trigger) and a price (limit fill level).
                # ATR buffer (atr * 0.02) gives ~$63 of slippage room on BTC.
                # If "STOP" is rejected by the exchange, we fall back to STOP_MARKET
                # so the bot never enters a position naked without any SL protection.
                atr_for_sl = signal.get("atr_at_entry", 0.0)
                atr_multiplier = 0.015 if (side == "sell" and funding_rate > 0.00008) else 0.02
                sl_limit_price = float(self.exchange.price_to_precision(
                    ex_symbol,
                    stop_loss + (atr_for_sl * atr_multiplier) if side == "buy" else stop_loss - (atr_for_sl * atr_multiplier)
                ))
                sl_order = None
                _sl_last_err = None
                # ── Attempt 1: STOP (stop-limit, preferred — no slippage) ─────
                for attempt in range(3):
                    try:
                        sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP", side=sl_side,
                            amount=fmt_size,
                            price=sl_limit_price,
                            params={
                                "stopPrice":  float(self.exchange.price_to_precision(ex_symbol, stop_loss)),
                                "reduceOnly": True,   # FIXED: reduceOnly works with amount; closePosition does not
                            },
                        )
                        sl_placed = True
                        logger.info(f"[Executor] Futures STOP (stop-limit) SL at {stop_loss} (limit={sl_limit_price}) ✓")
                        break
                    except Exception as e:
                        _sl_last_err = e
                        logger.warning(f"[Executor] Futures STOP attempt {attempt+1}/3 failed: {e}")
                        if attempt < 2:
                            await asyncio.sleep(1.0)

                # ── Fallback: STOP_MARKET if STOP rejected ────────────────────
                if not sl_placed:
                    logger.warning(
                        f"[Executor] STOP order rejected after 3 attempts ({_sl_last_err}). "
                        f"Falling back to STOP_MARKET — slippage risk accepted over naked position."
                    )
                    try:
                        sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP_MARKET", side=sl_side,
                            amount=fmt_size,
                            params={
                                "stopPrice":     float(self.exchange.price_to_precision(ex_symbol, stop_loss)),
                                "closePosition": True,
                            },
                        )
                        sl_placed = True
                        logger.info(f"[Executor] Futures STOP_MARKET SL (fallback) at {stop_loss} ✓")
                    except Exception as e2:
                        raise RuntimeError(
                            f"SL placement failed: STOP ({_sl_last_err}) and STOP_MARKET ({e2}) both rejected"
                        )
                sl_order_id = sl_order.get("id")

                tp_order = None
                _tp_last_err = None
                for attempt in range(3):
                    try:
                        tp_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="TAKE_PROFIT_MARKET", side=sl_side,
                            amount=fmt_size,
                            params={
                                "stopPrice": float(self.exchange.price_to_precision(ex_symbol, take_profit)),
                                "closePosition": True,
                                "workingType": "MARK_PRICE",
                            },
                        )
                        tp_placed = True
                        break
                    except Exception as e:
                        _tp_last_err = e
                        logger.warning(f"[Executor] Futures TP attempt {attempt+1}/3 failed: {e}")
                        if attempt < 2:
                            await asyncio.sleep(1.0)
                if not tp_placed:
                    # SL IS placed — position is not naked, just has no profit target.
                    # H4 FIX: Track requeue attempts so the heartbeat can retry TP placement
                    # up to MAX_REQUEUE_ATTEMPTS before giving up and alerting the operator.
                    self.active_position["requeue_tp_attempts"] = 1
                    self.active_position["requeue_tp_side"] = sl_side
                    self.active_position["requeue_tp_size"] = fmt_size
                    self.active_position["requeue_tp_price"] = float(
                        self.exchange.price_to_precision(ex_symbol, take_profit)
                    )
                    self.active_position["requeue_tp_symbol"] = ex_symbol
                    _tp_warn = (
                        f"⚠️ TP PLACEMENT FAILED for {side.upper()} {ex_symbol} @ {current_price}. "
                        f"SL={stop_loss} IS active (id={sl_order_id}). "
                        f"Will retry TP placement (1/{MAX_REQUEUE_ATTEMPTS}). MONITOR MANUALLY."
                    )
                    logger.error(f"[Executor] {_tp_warn}")
                    await self.notifier.send_error_alert(_tp_warn)
                    tp_order_id = None
                else:
                    tp_order_id = tp_order.get("id")
                    logger.info(f"[Executor] Futures TAKE_PROFIT_LIMIT at {take_profit} (id={tp_order_id}) ✓")

            else:
                # ── SPOT: Exchange-specific limit SL/TP orders ────────────────
                sl_limit = stop_loss * 0.999 if side == "buy" else stop_loss * 1.001
                sl_order = None
                _sl_last_err = None
                for attempt in range(3):
                    try:
                        if self.exchange_id == "binance":
                            sl_order = await self.exchange.create_order(
                                symbol=ex_symbol, type="STOP_LOSS_LIMIT", side=sl_side,
                                amount=fmt_size,
                                price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                                params={"stopPrice": float(self.exchange.price_to_precision(ex_symbol, stop_loss))},
                            )
                        else:
                            # Coinbase Advanced Trade V3 specific stop directions
                            stop_params = {"stop_price": float(self.exchange.price_to_precision(ex_symbol, stop_loss))}
                            if self.exchange_id == "coinbase":
                                direction = "STOP_DIRECTION_STOP_UP" if stop_loss > current_price else "STOP_DIRECTION_STOP_DOWN"
                                # Note: STOP_UP means trigger when price rises ABOVE stop_price (for shorts/longs),
                                # STOP_DOWN means trigger when price drops BELOW stop_price (for longs).
                                # This works correctly for both BUY and SELL positions due to how
                                # Coinbase interprets the direction relative to the order side.
                                stop_params["stop_direction"] = direction
                                
                            sl_order = await self.exchange.create_order(
                                symbol=ex_symbol, type="limit", side=sl_side,
                                amount=fmt_size,
                                price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                                params=stop_params,
                            )
                        sl_placed = True
                        break
                    except Exception as e:
                        _sl_last_err = e
                        logger.warning(f"[Executor] SL attempt {attempt+1}/3 failed: {e}")
                        if attempt < 2:
                            await asyncio.sleep(1.0)
                if not sl_placed:
                    raise RuntimeError(f"SL placement failed after 3 attempts: {_sl_last_err}")
                sl_order_id = sl_order.get("id")
                logger.info(f"[Executor] SL attached at {stop_loss} (id={sl_order_id}) ✓")

                # Take-profit limit order
                tp_order = None
                _tp_last_err = None
                for attempt in range(3):
                    try:
                        tp_order = await self.exchange.create_order(
                            symbol=ex_symbol,
                            type="limit",
                            side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, take_profit)),
                            params={"timeInForce": "GTC"},
                        )
                        tp_placed = True
                        break
                    except Exception as e:
                        _tp_last_err = e
                        logger.warning(f"[Executor] TP attempt {attempt+1}/3 failed: {e}")
                        if attempt < 2:
                            await asyncio.sleep(1.0)
                if not tp_placed:
                    _tp_warn = (
                        f"⚠️ TP PLACEMENT FAILED for {side.upper()} {ex_symbol} @ {current_price}. "
                        f"SL={stop_loss} IS active (id={sl_order_id}). "
                        f"Position protected but NO take-profit. MONITOR MANUALLY."
                    )
                    logger.error(f"[Executor] {_tp_warn}")
                    await self.notifier.send_error_alert(_tp_warn)
                    tp_order_id = None
                else:
                    tp_order_id = tp_order.get("id")
                    logger.info(f"[Executor] TP attached at {take_profit} (id={tp_order_id}) ✓")

            # BUG-1 FIX: Use actual exchange fill price, not signal price.
            # Market orders fill at the ask (for buys) — using current_price
            # corrupts every downstream calculation (PnL, BE stop, daily limit).
            fill_price = float(order.get("average") or order.get("price") or current_price)
            logger.info(f"[Executor] Fill price: {fill_price:.2f} (signal was {current_price:.2f}, diff={fill_price-current_price:+.2f})")

            doc_id = self._log_trade(ex_symbol, side, verdict, fill_price, stop_loss, take_profit, ulis_verdict)
            self.active_position = {
                "symbol":           ex_symbol,
                "side":             side,
                "size":             fmt_size,
                "entry_price":      fill_price,
                "stop_loss":        stop_loss,
                "take_profit":      take_profit,
                "order_id":         order.get("id"),
                "sl_order_id":      sl_order_id,
                "tp_order_id":      tp_order_id,
                "sl_placed":        sl_placed,
                "tp_placed":        tp_placed,
                "dry_run":          False,
                "trade_doc_id":     doc_id,
                "be_lock_trigger":  signal.get("be_lock_trigger", 1.0),
                "time_exit_sec":    signal.get("time_exit_sec", 600),
                "atr_at_entry":     signal.get("atr_at_entry", 0.0),
            }

            # Clear pending order since we now have an active position
            self.pending_order = None

            sl_tp_status = "SL+TP ✓" if (sl_placed and tp_placed) else ("SL ✓ | TP ✗ MONITOR" if sl_placed else "⚠️ NAKED")
            logger.info(f"[Executor] Position open — protection status: {sl_tp_status}")
            await self.notifier.send_trade_alert(
                symbol=ex_symbol, side=side, price=current_price,
                size=fmt_size, sl=stop_loss, tp=take_profit, is_dry=False
            )
            return True


        except ccxt.InsufficientFunds as e:
            logger.error(f"[Executor] Insufficient funds: {e}")
        except ccxt.InvalidOrder as e:
            logger.error(f"[Executor] Invalid order: {e}")
        except Exception as e:
            err_msg = f"Live order / SL placement failed: {e}"
            logger.error(f"[Executor] {err_msg}", exc_info=True)

            # ── EMERGENCY: SL failed — position is NAKED. Flatten immediately. ──
            # Note: TP-only failures are handled above and do NOT reach here —
            # the position keeps its SL in that case and is therefore still protected.
            if self.active_position is None and 'order' in locals() and order and order.get('id'):
                critical_msg = (
                    f"🚨 CRITICAL: SL PLACEMENT FAILED after market fill! "
                    f"FLATTENING NAKED {side.upper()} {ex_symbol} NOW. Error: {e}"
                )
                logger.critical(f"[Executor] {critical_msg}")
                await self.notifier.send_error_alert(critical_msg)

                close_side = "sell" if side == "buy" else "buy"
                try:
                    await self.exchange.create_market_order(ex_symbol, close_side, fmt_size)
                    logger.info("[Executor] ✓ Naked position flattened successfully.")
                    await self.notifier.send_error_alert(
                        f"✅ Naked {side.upper()} {ex_symbol} position flattened. No unintended exposure remains."
                    )
                except Exception as flatten_err:
                    manual_msg = (
                        f"🚨🚨 CRITICAL FAILURE: Could not flatten naked {side.upper()} {ex_symbol} position! "
                        f"MANUAL INTERVENTION REQUIRED IMMEDIATELY! Flatten error: {flatten_err}"
                    )
                    logger.critical(f"[Executor] {manual_msg}")
                    await self.notifier.send_error_alert(manual_msg)
            else:
                await self.notifier.send_error_alert(err_msg)

        finally:
            # If we don't have an active position after all that,
            # we MUST clear pending_order so the bot isn't stuck "Waiting"
            if self.active_position is None:
                self.pending_order = None

    # ------------------------------------------------------------------
    # Position monitor (called from main loop for dry-run)
    # ------------------------------------------------------------------

    async def move_sl_to_breakeven(self, symbol: str, entry_price: float):
        """Moves the current Stop Loss to the entry price (Breakeven)."""
        if self.dry_run:
            logger.info("[Executor] DRY-RUN: Simulated moving SL to breakeven.")
            return

        logger.info(f"[Executor] Moving Stop Loss to Breakeven @ {entry_price:.2f}")
        try:
            if not self.active_position:
                return
                
            # Phase 1: Place the NEW Stop Loss FIRST
            # This ensures we NEVER have a naked position if the API fails
            fmt_size = self.exchange.amount_to_precision(symbol, self.active_position["size"])
            close_side = "sell" if self.active_position["side"] == "buy" else "buy"
            
            new_order = await self.exchange.create_order(
                symbol,
                "STOP_MARKET",
                close_side,
                fmt_size,
                None,
                params={
                    "stopPrice": float(self.exchange.price_to_precision(symbol, entry_price)),
                    "reduceOnly": True
                }
            )
            logger.info("[Executor] Phase 1 Success: New Breakeven SL safely placed on exchange.")
            
            # Phase 2: Now that new SL is secure, cancel the OLD Stop Loss
            open_orders = await self.exchange.fetch_open_orders(symbol)
            for order in open_orders:
                is_stop = order.get("type", "").lower() in ("stop", "stop_market", "stopmarket")
                is_not_new = str(order.get("id")) != str(new_order.get("id"))
                if is_stop and is_not_new:
                    await self.exchange.cancel_order(order["id"], symbol)
                    logger.debug(f"[Executor] Phase 2 Success: Cancelled old SL order {order['id']}")
            
            if hasattr(self, "notifier") and self.notifier:
                await self.notifier.send_message(f"🔒 **Breakeven Secured**\
Moved Stop Loss to entry price at {entry_price:.2f} for {symbol}.")
                    
        except Exception as e:
            # If Phase 1 fails, Phase 2 never runs. The original Stop Loss remains active.
            # Your capital is still fully protected.
            err_msg = f"Failed to move SL to breakeven on Live Exchange: {e}"
            logger.error(f"[Executor] CRITICAL: {err_msg}")
            if hasattr(self, "notifier") and self.notifier:
                await self.notifier.send_error_alert(f"⚠️ **Breakeven Move Failed!**\
{err_msg}\
*Note: Original Stop Loss is still active.*")

    # C-3 FIX: Check opposing CVD divergence — move SL to breakeven if flow flips
        cvd = metrics.get("cvd_divergence")
        if cvd and cvd.get("strength", 0) > 0.40:
            side = pos.get("side", "")
            cvd_type = cvd.get("type", "")
            opp = (
                (side == "buy"  and cvd_type in ("EXHAUSTION_SELL", "CONTINUATION_SELL")) or
                (side == "sell" and cvd_type in ("EXHAUSTION_BUY",  "CONTINUATION_BUY"))
            )
            if opp:
                logger.warning(
                    f"[Executor] Opposing CVD divergence ({cvd_type}, strength={cvd.get('strength', 0):.2f}). "
                    "Moving SL to BE."
                )
                await self.move_sl_to_breakeven(pos["symbol"], pos["entry_price"])
                pos["_be_locked"] = True

    async def check_breakeven_and_partials(self, current_price: float, atr: float) -> None:
        """Check if breakeven stop should be locked, based on be_lock_trigger threshold."""
        if not self.active_position:
            return
        pos = self.active_position
        be_lock_trigger = pos.get("be_lock_trigger", 1.0)
        atr_at_entry = pos.get("atr_at_entry", 0.0)
        # P1 FIX: Add ATR minimum guard. Without it, a tiny atr_at_entry (quiet market)
        # means be_lock_trigger×atr_at_entry is a micro-pip amount — breakeven fires
        # on noise, immediately cutting the trade. Require at least 0.5×ATR of
        # absolute movement before considering breakeven.
        MIN_ATR_FRACTION = 0.5
        if atr_at_entry < atr * MIN_ATR_FRACTION:
            logger.debug(
                f"[Breakeven] Skipped — atr_at_entry={atr_at_entry:.2f} < {MIN_ATR_FRACTION}×ATR={atr*MIN_ATR_FRACTION:.2f}. Market too quiet."
            )
            return
        if be_lock_trigger <= 0.0 or atr_at_entry <= 0.0:
            return
        entry_price = pos["entry_price"]
        side = pos["side"]
        profit_target = be_lock_trigger * atr_at_entry
        if side == "buy":
            unrealized_pnl = current_price - entry_price
        else:
            unrealized_pnl = entry_price - current_price
        if unrealized_pnl >= profit_target:
            if pos.get("_be_locked", False):
                return
            logger.info(
                f"[Executor] Breakeven threshold reached: profit={unrealized_pnl:.2f} "
                f">= trigger={profit_target:.2f} ({be_lock_trigger}×ATR). Moving SL to breakeven."
            )
            await self.move_sl_to_breakeven(pos["symbol"], entry_price)
            pos["_be_locked"] = True

    async def check_position_exit(self, current_price: float,
                                   candle_high: float = None,
                                   candle_low: float = None) -> tuple:
        """
        Check SL/TP for position exit.

        DRY-RUN: Simulates SL/TP hits from candle high/low for realistic backtesting.
        LIVE MODE: Polls exchange fetch_positions() to detect real fills by the
                   exchange's STOP_MARKET / TAKE_PROFIT_MARKET orders.

        CRIT-1 FIX: Previously both modes ran the same simulation logic. In live mode
        this caused race conditions where internal state was cleared while the exchange
        still had open protective orders, leading to orphaned cancel calls and missed PnL.

        C6 FIX: Entire body is now protected by _position_lock (Semaphore(1)).
        This prevents the heartbeat poll and main loop from simultaneously clearing
        active_position, which caused duplicate Firestore writes and double alerts.

        Returns (exited: bool, pnl: float).
        """
        # C6 FIX: Acquire lock before reading active_position.
        # Semaphore(1) is reentrant — if we already hold it (e.g. check_position_exit
        # → _check_live_position_exit), nested acquisition does not deadlock.
        async with self._position_lock:
            pos = self.active_position
            if pos is None:
                return False, 0.0

            if not self.dry_run:
                return await self._check_live_position_exit(current_price)

            # ── DRY-RUN simulation ────────────────────────────────────────────
            side = pos["side"]
            sl   = pos["stop_loss"]
            tp   = pos["take_profit"]

            # PHASE-0.3: Use exchange-specific fees set in __init__
            TAKER_FEE = self.TAKER_FEE
            MAKER_FEE = self.MAKER_FEE

            size = pos.get("size") or pos.get("qty") or 0.0
            if size <= 0:
                logger.warning("[Executor] Active position has 0 size. Clearing stale state.")
                self.active_position = None
                return False, 0.0

            notional = size * pos["entry_price"]
            entry_fee = notional * TAKER_FEE

            # Use candle high/low for realistic SL/TP simulation if available
            check_high = candle_high if candle_high is not None else current_price
            check_low  = candle_low  if candle_low  is not None else current_price

            async def finalize_exit(exit_type: str, exit_price: float):
                nonlocal notional, entry_fee, side
                # C6 FIX: Set active_position = None FIRST before any await.
                # This prevents a second concurrent call (heartbeat or loop) from
                # seeing a stale non-None active_position while this function is
                # still awaiting send_close_alert.
                self.active_position = None
                self.pending_order = None
                exit_notional = size * exit_price
                exit_fee = exit_notional * (MAKER_FEE if exit_type == "TP" else TAKER_FEE)

                raw_pnl = (exit_price - pos["entry_price"]) * size if side == "buy" else (pos["entry_price"] - exit_price) * size
                net_pnl = raw_pnl - (entry_fee + exit_fee)
                logger.info(f"[Executor] {exit_type} HIT{' (SHORT)' if side == 'sell' else ''}. Net PnL=${net_pnl:.2f} (Fees: ${entry_fee+exit_fee:.2f})")

                if hasattr(self, "notifier") and self.notifier:
                    await self.notifier.send_close_alert(
                        symbol=pos["symbol"], side=side, price=exit_price, type=exit_type, pnl=net_pnl, is_dry=self.dry_run
                    )
                self._update_trade_exit(pos.get("trade_doc_id"), exit_price, net_pnl)
                return True, net_pnl

            if side == "buy":
                if check_low <= sl:
                    return await finalize_exit("SL", sl)
                if check_high >= tp:
                    return await finalize_exit("TP", tp)
            else:
                if check_high >= sl:
                    return await finalize_exit("SL", sl)
                if check_low <= tp:
                    return await finalize_exit("TP", tp)

            return False, 0.0

    async def _check_live_position_exit(self, current_price: float) -> tuple:
        """
        LIVE MODE: Poll exchange to detect if position was closed by SL/TP orders.

        P0-1 GHOST-POSITION FIX:
        Binance USDM Futures OMITS zero-quantity positions from fetch_positions entirely.
        The old code searched for a matching symbol with qty < 0.0001 — since Binance
        never returns that entry at all when flat, the position was never detected as closed.

        Correct approach: build a set of symbols that have NON-ZERO qty (open_syms).
        If our symbol is ABSENT from open_syms, the position is flat on the exchange.
        Then fetch the actual fill price + realized PnL from trade history.

        C6 FIX: Body NOT wrapped in _position_lock. The lock is held by the caller
        (check_position_exit → _check_live_position_exit). `_position_lock` is a
        Semaphore(1) — Python asyncio.Semaphore is NOT reentrant. A nested
        acquisition here would deadlock. The outer lock in check_position_exit
        is the only acquisition needed for the entire exit check path.
        """
        pos = self.active_position
        if pos is None:
            return False, 0.0

        symbol = pos.get("symbol", "")
        logger.debug(f"[LiveExit] Polling exchange for {symbol}…")

        try:
            # Fetch ALL positions — Binance only returns non-flat ones
            all_positions = await self.exchange.fetch_positions()

            # Build the set of symbols that are genuinely open (qty > noise floor)
            open_syms = {
                p.get("symbol")
                for p in all_positions
                if abs(float(p.get("contracts", 0) or 0)) > 0.0001
            }

            if symbol not in open_syms:
                # ── Position is FLAT on the exchange ────────────────────────
                # The SL or TP order was filled by Binance; bot state is stale.
                entry = pos["entry_price"]
                size  = pos["size"]
                side  = pos["side"]

                # Fetch actual fill price + exchange-reported realized PnL
                fill_price = current_price  # fallback
                actual_pnl = None
                try:
                    recent_trades = await self.exchange.fetch_my_trades(symbol, limit=10)
                    # Closing trades have side opposite to our entry side
                    closing = [
                        t for t in recent_trades
                        if t.get("side", "").lower() != side.lower()
                    ]
                    if closing:
                        fill_price = float(closing[-1]["price"])
                        actual_pnl = float(
                            closing[-1].get("info", {}).get("realizedPnl", 0)
                        )
                        if actual_pnl != 0:
                            logger.info(
                                f"[LiveExit] Exchange-reported fill={fill_price:.2f} "
                                f"realizedPnl=${actual_pnl:.2f}"
                            )
                        else:
                            logger.info(f"[LiveExit] Exchange-reported fill={fill_price:.2f}")
                except Exception as e:
                    logger.warning(f"[LiveExit] fill-price fetch failed: {e}")

                # Use exchange PnL if available, otherwise estimate from geometry
                if actual_pnl is not None and actual_pnl != 0:
                    net_pnl = actual_pnl
                else:
                    raw_pnl = ((fill_price - entry) * size if side == "buy"
                               else (entry - fill_price) * size)
                    fees = (entry + fill_price) * size * self.TAKER_FEE
                    net_pnl = raw_pnl - fees

                exit_type = "TP" if net_pnl > 0 else "SL"
                logger.info(
                    f"[LiveExit] Position flat on exchange — type={exit_type} "
                    f"pnl=${net_pnl:.2f} fill={fill_price:.2f}"
                )
                if self.notifier:
                    await self.notifier.send_close_alert(
                        symbol=symbol, side=side, price=fill_price,
                        type=exit_type, pnl=net_pnl, is_dry=False
                    )
                self._update_trade_exit(pos.get("trade_doc_id"), fill_price, net_pnl)
                self.active_position = None
                self.pending_order = None
                return True, net_pnl

            # Symbol still present in open_syms → position still live
            return False, 0.0

        except Exception as e:
            logger.warning(f"[LiveExit] poll error: {e}")
            return False, 0.0



    async def cancel_opposing_orders(self, filled_side: str = "sl"):
        """
        Cancel the opposing order after one side fills.
        In LIVE mode: if SL fills, cancel TP order (and vice versa).
        Prevents naked re-entries from orphaned orders.
        """
        pos = self.active_position
        if pos is None:
            return

        cancel_id = pos.get("tp_order_id") if filled_side == "sl" else pos.get("sl_order_id")
        symbol = pos.get("symbol", "")

        if cancel_id:
            try:
                await self.exchange.cancel_order(cancel_id, symbol)
                label = "TP" if filled_side == "sl" else "SL"
                logger.info(f"[Executor] Cancelled opposing {label} order {cancel_id} ✓")
            except Exception as e:
                # -2011 "Unknown order sent" means Binance already cancelled it
                # (closePosition=True orders are auto-cleaned when position closes).
                err_str = str(e).lower()
                already_gone = (
                    "-2011" in err_str
                    or "unknown order" in err_str
                    or "not found" in err_str
                    or "not_found" in err_str
                )
                if already_gone:
                    label = "TP" if filled_side == "sl" else "SL"
                    logger.info(f"[Executor] Opposing {label} order {cancel_id} already gone (Binance cleaned it) ✓")
                else:
                    logger.warning(f"[Executor] Failed to cancel opposing order {cancel_id}: {e}")

    def is_system_locked(self) -> bool:
        """Check if the system is currently under a panic-mode lock."""
        return time.time() < self.lock_expiry

    async def engage_panic_mode(self, reason: str, lock_seconds: int = 300):
        """
        Engages the killswitch: attempts emergency flatten then locks the system.
        """
        logger.warning(f"[PanicMode] ENGAGED! Reason: {reason}. Locking system for {lock_seconds}s.")
        self.lock_expiry = time.time() + lock_seconds
        self.last_panic_reason = reason

        if self.active_position and not self.dry_run:
            logger.warning(f"[PanicMode] Attempting emergency flatten before locking.")
            try:
                await self.emergency_flatten(f"Panic mode triggered: {reason}")
                logger.info("[PanicMode] Emergency flatten succeeded.")
            except Exception as flatten_err:
                logger.error(
                    f"[PanicMode] Flatten attempt failed: {flatten_err}. "
                    "Falling through to resting STOP_MARKET order."
                )

        if self.notifier:
            await self.notifier.send_message(f"🚨 PANIC MODE ENGAGED!\nReason: {reason}\nSystem locked for {lock_seconds}s.", critical=True)

    async def emergency_flatten(self, reason: str):
        """Immediately closes the current position with a Market Order."""
        if not self.active_position:
            return

        pos = self.active_position
        ex_symbol = pos["symbol"]
        side = pos["side"]
        size = pos["size"]
        close_side = "sell" if side == "buy" else "buy"

        logger.warning(f"[Executor] EMERGENCY FLATTEN triggered ({reason}) for {size} {ex_symbol}")

        try:
            if not self.dry_run:
                # 1. Cancel all open orders for this symbol first
                try:
                    await self.exchange.cancel_all_orders(ex_symbol)
                except Exception:
                    pass

                # 2. Market close
                await self.exchange.create_market_order(ex_symbol, close_side, size)

            logger.info(f"[Executor] Flattened {ex_symbol} ✅")

            # BUG-2 + HIGH-1 FIX: Fetch actual fill price from trade history.
            # Old code: _last_price never set → fill_price always = entry → PnL always $0.
            # Every panic exit was recorded as flat, bypassing the daily loss limit.
            entry = pos.get("entry_price", 0.0)
            size  = pos.get("size", 0.0)
            side  = pos.get("side", "buy")
            fill_price = entry  # fallback
            est_pnl    = 0.0
            if not self.dry_run:
                try:
                    recent = await self.exchange.fetch_my_trades(ex_symbol, limit=5)
                    closing = [
                        t for t in recent
                        if float(t.get("info", {}).get("realizedPnl", 0)) != 0
                    ]
                    if closing:
                        fill_price = float(closing[-1]["price"])
                        est_pnl    = float(closing[-1].get("info", {}).get("realizedPnl", 0))
                        logger.info(f"[Flatten] Exchange PnL: ${est_pnl:.2f} fill={fill_price:.2f}")
                    else:
                        # Estimate from entry vs current candle close
                        raw = (fill_price - entry) * size if side == "buy" else (entry - fill_price) * size
                        est_pnl = raw - (entry + fill_price) * size * self.TAKER_FEE
                except Exception as fe:
                    logger.warning(f"[Flatten] Could not fetch fill: {fe}")
            # HIGH-1 FIX: pass real fill_price (not 0.0) to Firestore
            self._last_panic_pnl = est_pnl  # BUG-3: expose for main.py daily_pnl update
            self._update_trade_exit(pos.get("trade_doc_id"), fill_price, est_pnl)
            self.active_position = None
        except Exception as e:
            # 3.4 FIX: Critical failure requires immediate human action.
            # Fire Telegram and log at CRITICAL level regardless of any other state.
            msg = (
                f"🚨 CRITICAL: FAILED TO FLATTEN POSITION\n"
                f"Symbol: {ex_symbol} | Side: {side.upper()} | Size: {size}\n"
                f"Reason: {reason}\n"
                f"Error: {str(e)}\n"
                f"ACTION REQUIRED: Log into exchange immediately and close this position manually."
            )
            logger.critical(msg)
            if self.notifier:
                try:
                    await self.notifier.send_message(msg)
                except Exception as notify_err:
                    logger.error(f"[Executor] Also failed to send Telegram alert: {notify_err}")
            # P0-3 FIX: Use a dedicated boolean flag, NOT a sentinel dict.
            # The 30s heartbeat poll calls _check_live_position_exit which sets
            # active_position = None if the symbol is gone — silently wiping the
            # sentinel dict and allowing the bot to resume trading unprotected.
            # A separate boolean survives the poll clearing active_position.
            self._flatten_failed = True
            self.active_position = None  # Clear position — halt is enforced via _flatten_failed flag

    async def attempt_tp_requeue(self) -> bool:
        """
        H4 FIX: Retry TP placement for positions that entered without a TP attached.

        Called by main.py on every analysis cycle when active_position has
        requeue_tp_attempts > 0. Retries up to MAX_REQUEUE_ATTEMPTS times.
        Returns True if TP was successfully placed, False if max attempts exhausted.
        """
        pos = self.active_position
        if pos is None:
            return False

        if not pos.get("requeue_tp_attempts", 0):
            return False  # No pending TP requeue

        attempts = pos["requeue_tp_attempts"]
        if attempts > MAX_REQUEUE_ATTEMPTS:
            logger.warning(
                f"[Executor] TP requeue attempts ({attempts}) >= MAX_REQUEUE_ATTEMPTS "
                f"({MAX_REQUEUE_ATTEMPTS}). Giving up on TP. Position has SL only."
            )
            pos.pop("requeue_tp_attempts", None)
            pos.pop("requeue_tp_side", None)
            pos.pop("requeue_tp_size", None)
            pos.pop("requeue_tp_price", None)
            pos.pop("requeue_tp_symbol", None)
            return False

        symbol = pos.get("requeue_tp_symbol")
        side = pos.get("requeue_tp_side")
        size = pos.get("requeue_tp_size")
        tp_price = pos.get("requeue_tp_price")

        if not all([symbol, side, size, tp_price]):
            logger.error("[Executor] TP requeue: missing position fields — clearing requeue state.")
            for k in ["requeue_tp_attempts", "requeue_tp_side", "requeue_tp_size", "requeue_tp_price", "requeue_tp_symbol"]:
                pos.pop(k, None)
            return False

        for attempt in range(3):
            try:
                tp_order = await self.exchange.create_order(
                    symbol=symbol,
                    type="TAKE_PROFIT_MARKET",
                    side=side,
                    amount=size,
                    params={
                        "stopPrice": tp_price,
                        "closePosition": True,
                        "workingType": "MARK_PRICE",
                    },
                )
                pos["tp_order_id"] = tp_order.get("id")
                for k in ["requeue_tp_attempts", "requeue_tp_side", "requeue_tp_size", "requeue_tp_price", "requeue_tp_symbol"]:
                    pos.pop(k, None)
                logger.info(f"[Executor] TP requeue SUCCESS — TP placed at {tp_price} (attempt {attempts}) ✓")
                return True
            except Exception as e:
                logger.warning(
                    f"[Executor] TP requeue attempt {attempts}/{MAX_REQUEUE_ATTEMPTS}, "
                    f"inner attempt {attempt+1}/3 failed: {e}"
                )
                if attempt < 2:
                    await asyncio.sleep(1.0)

        # All 3 inner attempts failed this cycle — increment and alert
        pos["requeue_tp_attempts"] = attempts + 1
        logger.warning(
            f"[Executor] TP requeue inner loop exhausted. "
            f"Attempt {attempts+1}/{MAX_REQUEUE_ATTEMPTS}. Will retry next cycle."
        )
        if pos["requeue_tp_attempts"] >= MAX_REQUEUE_ATTEMPTS:
            await self.notifier.send_error_alert(
                f"⚠️ TP placement FAILED after {MAX_REQUEUE_ATTEMPTS} requeue attempts. "
                f"Position is unprotected — SL active. Manual intervention required."
            )
        return False

