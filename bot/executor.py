import logging
import time
from typing import Dict, Any, Optional
import ccxt.async_support as ccxt
from bot import heartbeat
from bot.notifier import TelegramNotifier

logger = logging.getLogger(__name__)


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
        exchange_id: str = "binanceusdm",
        coinbase_key_name: str = "",
        coinbase_private_key: str = "",
        tg_token: str = "",
        tg_chat_id: str = "",
        leverage: int = 1,
    ):
        self.testnet     = testnet
        self.exchange_id = exchange_id.lower()
        self.leverage    = max(1, min(leverage, 20))   # clamp 1-20×
        self.is_futures  = self.exchange_id == "binanceusdm"
        self.dry_run     = dry_run or not self._has_credentials(
            exchange_id, api_key, api_secret, coinbase_key_name, coinbase_private_key
        )

        self.notifier = TelegramNotifier(tg_token, tg_chat_id)

        if self.dry_run:
            logger.warning("[Executor] DRY-RUN mode: no real orders will be placed.")

        # ── Exchange initialisation ───────────────────────────────────────
        if self.exchange_id == "coinbase":
            self.exchange = self._init_coinbase(coinbase_key_name, coinbase_private_key)
        elif self.exchange_id == "binanceusdm":
            self.exchange = self._init_binance_futures(api_key, api_secret, testnet)
        else:
            # Binance Spot (legacy / fallback)
            self.exchange = self._init_binance(api_key, api_secret, testnet)

        self.active_position: Optional[Dict[str, Any]] = None
        self.pending_order: Optional[Dict[str, Any]] = None  # Track unfilled orders
        self._last_insuf_warn_ts: float = 0.0  # Cooldown for insufficient-funds spam

        # ── Panic Mode State ─────────────────────────────────────────────────
        self.system_locked: bool = False          # True = no new entries allowed
        self.lock_expiry: float = 0.0             # Unix timestamp when lock expires
        self.last_panic_reason: str = ""          # For logging/Telegram

        # Fee rates per exchange:  Coinbase Spot 1.2% | Binance Spot 0.1% | Binance Futures 0.04%
        if self.exchange_id == "coinbase":
            self.EXCHANGE_FEE_RATE: float = 0.012
        elif self.exchange_id == "binanceusdm":
            self.EXCHANGE_FEE_RATE: float = 0.0004
        else:
            self.EXCHANGE_FEE_RATE: float = 0.001

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
    def _init_binance(api_key: str, api_secret: str, testnet: bool) -> ccxt.Exchange:
        exchange = ccxt.binance({
            "apiKey":          api_key,
            "secret":          api_secret,
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        if testnet:
            exchange.set_sandbox_mode(True)
        logger.info(f"[Executor] Binance Spot ({'testnet' if testnet else 'live'}) initialised.")
        return exchange

    @staticmethod
    def _init_binance_futures(api_key: str, api_secret: str, testnet: bool) -> ccxt.Exchange:
        """
        Binance USDM Perpetual Futures (ccxt.binanceusdm).
        Same API key/secret as Binance Spot but routed to the USDM futures endpoint.
        Testnet uses Binance's dedicated futures testnet.
        """
        exchange = ccxt.binanceusdm({
            "apiKey":          api_key,
            "secret":          api_secret,
            "enableRateLimit": True,
            "options": {"defaultType": "future"},
        })
        if testnet:
            exchange.set_sandbox_mode(True)
        logger.info(f"[Executor] Binance USDM Futures ({'testnet' if testnet else 'LIVE'}) initialised.")
        return exchange

    # ------------------------------------------------------------------
    # Symbol translation helpers
    # ------------------------------------------------------------------
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
        """Load markets and confirm connectivity."""
        if self.dry_run and not self.exchange.apiKey:
            logger.info("[Executor] Skipping market load in keyless dry-run mode.")
            return
        try:
            await self.exchange.load_markets()
            env = "TESTNET" if self.testnet else "LIVE"
            exch = self.exchange_id.upper()
            logger.info(f"[Executor] Connected to {exch} {env} ✓")
        except Exception as e:
            # CDP keys often fail on public V2 currency fetches during load_markets
            logger.warning(f"[Executor] Exchange initialised with warnings (CDP/V3 compatibility): {e}")
            
            # Manual fallback for the core symbol so trade execution doesn't fail
            # These are the standard BTC/USDC parameters for Coinbase Advanced Trade
            if self.exchange_id == "coinbase":
                # Ensure CCXT internal structures are initialized
                if not hasattr(self.exchange, 'markets') or self.exchange.markets is None:
                    self.exchange.markets = {}
                if not hasattr(self.exchange, 'marketsById') or self.exchange.marketsById is None:
                    self.exchange.marketsById = {}
                if not hasattr(self.exchange, 'symbols') or self.exchange.symbols is None:
                    self.exchange.symbols = []

                # BTC/USDC market spec — precision uses TICK_SIZE (raw float step values)
                _btc_usdc = {
                    'id': 'BTC-USDC', 'symbol': 'BTC/USDC', 'base': 'BTC', 'quote': 'USDC',
                    'precision': {'amount': 1e-8, 'price': 0.01},
                    'limits': {
                        'amount': {'min': 0.00001, 'max': 1000},
                        'price':  {'min': 0.01,    'max': 1_000_000},
                        'cost':   {'min': 1.0}
                    },
                    'active': True,
                    'type': 'spot', 'spot': True, 'margin': False, 'contract': False
                }
                # BTC/USD market spec
                _btc_usd = {
                    'id': 'BTC-USD', 'symbol': 'BTC/USD', 'base': 'BTC', 'quote': 'USD',
                    'precision': {'amount': 1e-8, 'price': 0.01},
                    'limits': {
                        'amount': {'min': 0.00001, 'max': 1000},
                        'price':  {'min': 0.01,    'max': 1_000_000},
                        'cost':   {'min': 1.0}
                    },
                    'active': True,
                    'type': 'spot', 'spot': True, 'margin': False, 'contract': False
                }

                # Populate both unified-symbol keyed dict (used by amount_to_precision / market())
                # AND the exchange-id keyed dict (used internally by some CCXT methods)
                self.exchange.markets['BTC/USDC']     = _btc_usdc
                self.exchange.markets['BTC/USD']      = _btc_usd
                self.exchange.marketsById['BTC-USDC'] = _btc_usdc
                self.exchange.marketsById['BTC-USD']  = _btc_usd

                if 'BTC/USDC' not in self.exchange.symbols:
                    self.exchange.symbols.append('BTC/USDC')
                if 'BTC/USD' not in self.exchange.symbols:
                    self.exchange.symbols.append('BTC/USD')

            logger.info("[Executor] Proceeding with manual market state for BTC/USDC and BTC/USD...")

    async def close(self):
        await self.exchange.close()

    # ------------------------------------------------------------------
    # Firestore trade logger
    # ------------------------------------------------------------------
    def _log_trade(self, symbol: str, side: str, verdict: str,
                   entry: float, stop_loss: float, take_profit: float,
                   ulis_verdict: str = ""):
        """Write an OPEN trade record to Firestore `botTrades` collection."""
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            doc = {
                "symbol":       symbol,
                "side":         side,
                "verdict":      verdict,
                "entry_price":  entry,
                "stop_loss":    stop_loss,
                "take_profit":  take_profit,
                "timestamp":    fs.SERVER_TIMESTAMP,
                "mode":         "DRY-RUN" if self.dry_run else "LIVE",
                "exchange":     self.exchange_id,
                "ulis_verdict": ulis_verdict,
                "ts_ms":        int(time.time() * 1000),
                "type":         "OPEN",
            }
            db.collection("botTrades").add(doc)
            logger.info("[Executor] Trade open logged to Firestore ✓")
        except Exception as e:
            logger.warning(f"[Executor] Failed to log trade to Firestore: {e}")

    def _log_trade_close(self, symbol: str, side: str, pnl: float, exit_reason: str):
        """Write a CLOSE record to Firestore with WIN/LOSS outcome."""
        outcome = "WIN" if pnl > 0 else "LOSS"
        logger.info(
            f"[Executor] Trade CLOSED | {exit_reason} | PnL=${pnl:.2f} ({outcome})"
        )
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            doc = {
                "symbol":       symbol,
                "side":         side,
                "pnl":          round(pnl, 4),
                "outcome":      outcome,
                "exit_reason":  exit_reason,   # "STOP_LOSS" or "TAKE_PROFIT"
                "timestamp":    fs.SERVER_TIMESTAMP,
                "mode":         "DRY-RUN" if self.dry_run else "LIVE",
                "exchange":     self.exchange_id,
                "ts_ms":        int(time.time() * 1000),
                "type":         "CLOSE",
            }
            db.collection("botTrades").add(doc)
            logger.info(f"[Executor] Trade close logged to Firestore ({outcome}) ✓")
        except Exception as e:
            logger.warning(f"[Executor] Failed to log trade close to Firestore: {e}")

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
        except: return 0.0

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
    def calculate_position_size(
        self,
        current_price: float,
        stop_loss: float,
        equity: float,
        max_risk_pct: float,
    ) -> float:
        """
        Fixed-fractional sizing: risk_usd / |entry − stop|
        risk_usd = equity × (max_risk_pct / 100)
        """
        risk_usd = equity * (max_risk_pct / 100.0)
        distance = abs(current_price - stop_loss)
        if distance <= 0 or current_price <= 0:
            return 0.0
        return risk_usd / distance

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
    ):
        verdict     = signal.get("verdict", "WAIT")
        confidence  = float(signal.get("confidence", 0))
        stop_loss   = float(signal.get("stop_loss", 0))
        take_profit = float(signal.get("take_profit", 0))

        # Guard rails
        if "WAIT" in verdict:
            return

        if self.active_position is not None:
            logger.info("[Executor] Already in a position. Skipping new entry.")
            return

        # Check if previous order is still pending (unfilled)
        if self.pending_order is not None:
            logger.info(f"[Executor] Pending order {self.pending_order['id']} still unfilled. Rejecting new signal.")
            return

        if stop_loss <= 0 or take_profit <= 0:
            logger.warning("[Executor] Invalid SL/TP. Aborting.")
            return

        side = "buy" if ("BUY" in verdict or "LONG" in verdict) else "sell"
        if side == "buy" and stop_loss >= current_price:
            logger.warning(f"[Executor] SL {stop_loss} ≥ price {current_price} for BUY. Aborting.")
            return
        if side == "sell" and stop_loss <= current_price:
            logger.warning(f"[Executor] SL {stop_loss} ≤ price {current_price} for SELL. Aborting.")
            return

        # 1. Calculate Total Equity (Cash + Crypto Value) for accurate risk sizing
        equity = await self.get_total_equity(current_price, account_size)
        
        if side == "buy":
            usdc_equity = await self.get_usdt_balance(account_size)
            # Minimum: $5 order + fee reserve at exchange rate (~1.2% on Coinbase)
            fee_reserve = usdc_equity * self.EXCHANGE_FEE_RATE
            min_required = 5.0 + fee_reserve
            if usdc_equity < min_required:
                # Cooldown: only warn once per 60 seconds to avoid log spam
                now = time.time()
                if now - self._last_insuf_warn_ts >= 60:
                    self._last_insuf_warn_ts = now
                    fee_pct = self.EXCHANGE_FEE_RATE * 100
                    err = (
                        f"Insufficient USDC (${usdc_equity:.2f}) to open LONG. "
                        f"Min ${min_required:.2f} required "
                        f"(incl. ~{fee_pct:.1f}% {self.exchange_id} taker fee)."
                    )
                    logger.warning(f"[Executor] {err}")
                    await self.notifier.send_error_alert(err)
                return
        else:
            # Futures SHORT only needs USDT margin — no BTC required.
            # Spot SHORT requires holding BTC to sell.
            if not self.is_futures:
                btc_bal = await self.get_btc_balance()
                if btc_bal <= 0.00001:
                    err = "Aborting SELL signal: No BTC balance on spot. Use futures for shorting."
                    logger.warning(f"[Executor] {err}")
                    await self.notifier.send_error_alert(err)
                    return

        raw_size = self.calculate_position_size(current_price, stop_loss, equity, max_risk_pct)
        if raw_size <= 0.0:
            logger.warning("[Executor] Calculated position size is 0. Aborting.")
            return

        # Translate symbol to exchange format
        ex_symbol = self._to_exchange_symbol(symbol)

        # For Coinbase, ensure the symbol is in the markets cache
        # ex_symbol is in CCXT unified format (BTC/USDC) thanks to _to_exchange_symbol above
        if self.exchange_id == "coinbase":
            if ex_symbol not in (self.exchange.markets or {}) or self.exchange.markets.get(ex_symbol) is None:
                logger.warning(f"[Executor] Symbol {ex_symbol} not in markets cache. Registering on-the-fly...")
                if not hasattr(self.exchange, 'markets') or self.exchange.markets is None:
                    self.exchange.markets = {}
                if not hasattr(self.exchange, 'marketsById') or self.exchange.marketsById is None:
                    self.exchange.marketsById = {}

                base, quote = (ex_symbol.split("/") + ["USDC"])[:2]  # safe unpack
                ex_id = f"{base}-{quote}"
                market_spec = {
                    'id': ex_id, 'symbol': ex_symbol, 'base': base, 'quote': quote,
                    'precision': {'amount': 1e-8, 'price': 0.01},
                    'limits': {'amount': {'min': 0.00001, 'max': 1000},
                               'price':  {'min': 0.01,    'max': 1_000_000},
                               'cost':   {'min': 1.0}},
                    'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
                }
                self.exchange.markets[ex_symbol] = market_spec
                self.exchange.marketsById[ex_id]  = market_spec
                logger.info(f"[Executor] Registered {ex_symbol} (id={ex_id}) to markets cache.")

        if self.dry_run:
            # ── DRY RUN ──────────────────────────────────────────────────
            cost = raw_size * current_price
            logger.info(
                f"[DRY-RUN] {verdict} {ex_symbol} "
                f"| qty={raw_size:.6f} (${cost:.2f}) "
                f"| SL={stop_loss} TP={take_profit} "
                f"| equity=${equity:.2f} risk={max_risk_pct}% "
                f"| ULIS={ulis_verdict}"
            )
            self.active_position = {
                "symbol":      ex_symbol,
                "side":        side,
                "size":        raw_size,
                "entry_price": current_price,
                "stop_loss":   stop_loss,
                "take_profit": take_profit,
                "dry_run":     True,
            }
            self._log_trade(ex_symbol, side, verdict, current_price, stop_loss, take_profit, ulis_verdict)
            
            # Telegram Notification
            await self.notifier.send_trade_alert(
                symbol=ex_symbol, side=side, price=current_price, 
                size=raw_size, sl=stop_loss, tp=take_profit, is_dry=True
            )
            return

        # ── LIVE EXECUTION ────────────────────────────────────────────────
        try:
            # ex_symbol is already in CCXT unified format (e.g. BTC/USDC) from _to_exchange_symbol.
            # CCXT internally translates unified symbols → exchange-native IDs (BTC-USDC) for API calls.
            # DO NOT convert to hyphen format here — it breaks CCXT's internal market() lookup.
            fmt_size = float(self.exchange.amount_to_precision(ex_symbol, raw_size))
            cost = fmt_size * current_price

            # --- MINIMUM SIZE BUMP ---
            # If the calculated risk size is smaller than a reasonable exchange minimum ($5.00),
            # shift the size up so small accounts/percentages aren't perpetually blocked by exchange limits.
            if cost > 0 and cost < 5.0:
                logger.info(f"[Executor] Calculated trade value (${cost:.2f}) is too small. Bumping to $5.00 minimum.")
                cost = 5.0
                fmt_size = float(self.exchange.amount_to_precision(ex_symbol, cost / current_price))

            usdt_avail = await self.get_usdt_balance(account_size)
            # Futures: with Nx leverage the max notional = usdt × N
            lev_factor = self.leverage if self.is_futures else 1.0
            max_cost   = usdt_avail * lev_factor * (1.0 - self.EXCHANGE_FEE_RATE)

            if side == "buy" or self.is_futures:
                # BUY (spot or futures) and Futures SHORT — cap by USDT margin
                if cost > max_cost:
                    fmt_size = float(
                        self.exchange.amount_to_precision(ex_symbol, max_cost / current_price)
                    )
            else:
                # SELL on SPOT: must cap by available BTC balance
                btc_available = await self.get_btc_balance()
                max_sell = max(0.0, btc_available * 0.999)
                if fmt_size > max_sell:
                    fmt_size = float(self.exchange.amount_to_precision(ex_symbol, max_sell))

            cost = fmt_size * current_price  # recalculate after potential cap

            if fmt_size <= 0.0 or cost < 1.0:
                logger.warning(f"[Executor] Final size/cost too small after caps (qty={fmt_size}, cost=${cost:.2f}). Aborting live order.")
                return

            import asyncio

            # Set leverage per-symbol for futures just before the entry order
            if self.is_futures:
                try:
                    await self.exchange.set_leverage(self.leverage, ex_symbol)
                    logger.info(f"[Executor] Futures leverage set to {self.leverage}× for {ex_symbol}")
                except Exception as e:
                    logger.warning(f"[Executor] set_leverage skipped (may already be set): {e}")

            order = None
            for attempt in range(3):
                try:
                    if self.is_futures:
                        # Futures: both LONG and SHORT use base-quantity market orders
                        logger.info(
                            f"[Executor] Futures MARKET {side.upper()} "
                            f"{fmt_size} BTC {ex_symbol} @ ~{current_price} ({self.leverage}×)"
                        )
                        order = await self.exchange.create_market_order(ex_symbol, side, fmt_size)
                    elif self.exchange_id == "coinbase" and side == "buy":
                        # Coinbase spot BUY expects quote cost, not base quantity
                        usdc_cost = round(cost, 2)
                        logger.info(
                            f"[Executor] Placing MARKET BUY {usdc_cost} USDC → {ex_symbol} @ ~{current_price}"
                        )
                        order = await self.exchange.create_market_order(
                            ex_symbol, side, usdc_cost,
                            params={"createMarketBuyOrderRequiresPrice": False}
                        )
                    else:
                        logger.info(
                            f"[Executor] Placing MARKET {side.upper()} {fmt_size} BTC {ex_symbol} @ ~{current_price}"
                        )
                        order = await self.exchange.create_market_order(ex_symbol, side, fmt_size)
                    break
                except Exception as e:
                    if attempt == 2: raise e
                    logger.warning(f"[Executor] Market order failed: {e}. Retrying {attempt+1}/3...")
                    await asyncio.sleep(0.5)
            logger.info(f"[Executor] Market order placed: id={order.get('id')} status={order.get('status')}")
            
            # Track this order as pending until it fills or is cancelled
            self.pending_order = {
                "id": order.get('id'),
                "symbol": ex_symbol,
                "side": side,
                "size": fmt_size,
                "entry_price": current_price,
                "status": order.get('status', 'open')
            }
            
            # Telegram Notification (Success)
            await self.notifier.send_trade_alert(
                symbol=ex_symbol, side=side, price=current_price, 
                size=fmt_size, sl=stop_loss, tp=take_profit, is_dry=False
            )

            sl_side = "sell" if side == "buy" else "buy"
            sl_order_id = None
            tp_order_id = None

            if self.is_futures:
                # ── FUTURES: STOP_MARKET + TAKE_PROFIT_MARKET ────────────────
                # closePosition=True closes the full position; workingType=MARK_PRICE
                # avoids wick-triggered stops from momentary spread spikes.
                sl_order = None
                for attempt in range(3):
                    try:
                        sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP_MARKET", side=sl_side,
                            amount=fmt_size,
                            params={
                                "stopPrice":    float(self.exchange.price_to_precision(ex_symbol, stop_loss)),
                                "closePosition": True,
                                "workingType":  "MARK_PRICE",
                            },
                        )
                        break
                    except Exception as e:
                        if attempt == 2: raise e
                        logger.warning(f"[Executor] Futures SL failed: {e}. Retrying {attempt+1}/3...")
                        await asyncio.sleep(0.5)
                sl_order_id = sl_order.get("id")
                logger.info(f"[Executor] Futures STOP_MARKET at {stop_loss} (id={sl_order_id})")

                tp_order = None
                for attempt in range(3):
                    try:
                        tp_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="TAKE_PROFIT_MARKET", side=sl_side,
                            amount=fmt_size,
                            params={
                                "stopPrice":    float(self.exchange.price_to_precision(ex_symbol, take_profit)),
                                "closePosition": True,
                                "workingType":  "MARK_PRICE",
                            },
                        )
                        break
                    except Exception as e:
                        if attempt == 2: raise e
                        logger.warning(f"[Executor] Futures TP failed: {e}. Retrying {attempt+1}/3...")
                        await asyncio.sleep(0.5)
                tp_order_id = tp_order.get("id")
                logger.info(f"[Executor] Futures TAKE_PROFIT_MARKET at {take_profit} (id={tp_order_id})")

            else:
                # ── SPOT: Exchange-specific limit SL/TP orders ────────────────
                sl_limit = stop_loss * 0.999 if side == "buy" else stop_loss * 1.001
                sl_order = None
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
                            # Coinbase V3 stop direction
                            direction = "STOP_DIRECTION_STOP_UP" if stop_loss > current_price else "STOP_DIRECTION_STOP_DOWN"
                            sl_order = await self.exchange.create_order(
                                symbol=ex_symbol, type="limit", side=sl_side,
                                amount=fmt_size,
                                price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                                params={"stop_price": float(self.exchange.price_to_precision(ex_symbol, stop_loss)),
                                        "stop_direction": direction},
                            )
                        break
                    except Exception as e:
                        if attempt == 2: raise e
                        logger.warning(f"[Executor] SL placement failed: {e}. Retrying {attempt+1}/3...")
                        await asyncio.sleep(0.5)
                sl_order_id = sl_order.get("id")
                logger.info(f"[Executor] SL attached at {stop_loss} (id={sl_order_id})")

                tp_order = None
                for attempt in range(3):
                    try:
                        tp_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="limit", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, take_profit)),
                            params={"timeInForce": "GTC"},
                        )
                        break
                    except Exception as e:
                        if attempt == 2: raise e
                        logger.warning(f"[Executor] TP placement failed: {e}. Retrying {attempt+1}/3...")
                        await asyncio.sleep(0.5)
                tp_order_id = tp_order.get("id")
                logger.info(f"[Executor] TP attached at {take_profit} (id={tp_order_id})")

            self.active_position = {
                "symbol":      ex_symbol,
                "side":        side,
                "size":        fmt_size,
                "entry_price": current_price,
                "stop_loss":   stop_loss,
                "take_profit": take_profit,
                "order_id":    order.get("id"),
                "sl_order_id": sl_order_id,
                "tp_order_id": tp_order_id,
            }
            
            # Clear pending order since we now have an active position
            self.pending_order = None
            self._log_trade(ex_symbol, side, verdict, current_price, stop_loss, take_profit, ulis_verdict)

        except ccxt.InsufficientFunds as e:
            logger.error(f"[Executor] Insufficient funds: {e}")
        except ccxt.InvalidOrder as e:
            logger.error(f"[Executor] Invalid order: {e}")
        except Exception as e:
            err_msg = f"Live order failed: {e}"
            logger.error(f"[Executor] {err_msg}", exc_info=True)
            await self.notifier.send_error_alert(err_msg)
            
            # FLAT PREVENT NAKED POSITION
            if self.active_position is None and 'order' in locals() and order and order.get('id'):
                logger.error("[Executor] SL/TP failed after Market Fill. FLATTENING NAKED POSITION IMMEDIATELY!")
                close_side = "sell" if side == "buy" else "buy"
                try:
                    await self.exchange.create_market_order(ex_symbol, close_side, fmt_size)
                    logger.info("[Executor] Flattened naked position successfully.")
                except Exception as ex:
                    logger.critical(f"[Executor] CRITICAL: Failed to flatten naked position! MANUAL INTERVENTION REQUIRED! {ex}")

        finally:
            # If we don't have an active position after all that, 
            # we MUST clear pending_order so the bot isn't stuck "Waiting"
            if self.active_position is None:
                self.pending_order = None

    # ------------------------------------------------------------------
    # Position monitor (called from main loop for dry-run)
    # ------------------------------------------------------------------
    def check_position_exit(self, current_price: float) -> tuple:
        """
        Check SL/TP for dry-run mode.
        In live mode the exchange handles OCO orders.
        Returns (exited: bool, pnl: float).
        PnL is 0.0 when the position has not yet exited.
        """
        pos = self.active_position
        if pos is None:
            return False, 0.0

        side = pos["side"]
        sl   = pos["stop_loss"]
        tp   = pos["take_profit"]

        symbol = pos.get("symbol", "")
        if side == "buy":
            if current_price <= sl:
                pnl = (current_price - pos["entry_price"]) * pos["size"]
                self.active_position = None
                self.pending_order = None
                self._log_trade_close(symbol, side, pnl, "STOP_LOSS")
                return True, pnl
            if current_price >= tp:
                pnl = (current_price - pos["entry_price"]) * pos["size"]
                self.active_position = None
                self.pending_order = None
                self._log_trade_close(symbol, side, pnl, "TAKE_PROFIT")
                return True, pnl
        else:
            if current_price >= sl:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                self.active_position = None
                self.pending_order = None
                self._log_trade_close(symbol, side, pnl, "STOP_LOSS")
                return True, pnl
            if current_price <= tp:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                self.active_position = None
                self.pending_order = None
                self._log_trade_close(symbol, side, pnl, "TAKE_PROFIT")
                return True, pnl

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
                logger.warning(f"[Executor] Failed to cancel opposing order {cancel_id}: {e}")

    async def update_breakeven_stop(self, current_price: float):
        """
        If the current price reaches 50% of the Take-Profit distance,
        move the Stop-Loss up to the Entry Price (Break-Even).
        For Live: cancels old SL and creates new SL order.
        """
        pos = self.active_position
        if not pos or pos.get("be_triggered", False):
            return

        side  = pos["side"]
        entry = pos["entry_price"]
        tp    = pos["take_profit"]

        # Calculate 50% trigger line
        be_target = entry + ((tp - entry) * 0.5)

        triggered = False
        if side == "buy" and current_price >= be_target:
            triggered = True
        elif side == "sell" and current_price <= be_target:
            triggered = True

        if not triggered:
            return

        # Trigger Break-Even log
        logger.info("[Executor] RUNNER SECURED: Target halfway reached. Attempting Break-Even SL.")

        if self.dry_run:
            pos["be_triggered"] = True
            pos["stop_loss"]    = entry
            return

        # LIVE MODE: Cancel old SL and place new one at Entry
        import asyncio
        try:
            ex_symbol = pos["symbol"]
            old_sl_id = pos.get("sl_order_id")
            fmt_size  = pos["size"]

            # Fix Race Condition: Set state BEFORE yielding via await
            pos["be_triggered"] = True
            pos["stop_loss"]    = entry

            cancel_success = True
            if old_sl_id:
                for attempt in range(3):
                    try:
                        await self.exchange.cancel_order(old_sl_id, ex_symbol)
                        cancel_success = True
                        pos["sl_order_id"] = None
                        break
                    except Exception as e:
                        if attempt == 2:
                            err_str = str(e).lower()
                            if "not found" in err_str or "not_found" in err_str:
                                cancel_success = True
                                pos["sl_order_id"] = None
                                break
                            logger.warning(f"[Executor] Final failure to cancel old SL for Break-Even: {e}")
                            cancel_success = False
                            pos["be_triggered"] = False # Revert
                            break
                        await asyncio.sleep(0.5)
            
            if not cancel_success:
                return

            sl_side = "sell" if side == "buy" else "buy"
            sl_limit = entry * 0.999 if side == "buy" else entry * 1.001

            new_sl = None
            for attempt in range(3):
                try:
                    if self.exchange_id == "binance":
                        new_sl = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP_LOSS_LIMIT", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                            params={"stopPrice": float(self.exchange.price_to_precision(ex_symbol, entry))},
                        )
                    else:
                        new_sl = await self.exchange.create_order(
                            symbol=ex_symbol, type="limit", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                            params={"stop_price": float(self.exchange.price_to_precision(ex_symbol, entry))},
                        )
                    break
                except Exception as e:
                    if attempt == 2:
                        logger.error(f"[Executor] Failed to create Break-Even SL: {e}")
                        break
                    await asyncio.sleep(0.5)

            if new_sl and new_sl.get("id"):
                pos["sl_order_id"] = new_sl.get("id")
                logger.info(f"[Executor] New Break-Even SL attached at {entry} (id={pos['sl_order_id']})")
            else:
                logger.critical("[Executor] SL placement failed during Break-Even update! FLATTENING NAKED POSITION!")
                try:
                    await self.exchange.create_market_order(ex_symbol, sl_side, fmt_size)
                    self.active_position = None
                    logger.info("[Executor] Flattened naked position successfully.")
                except Exception as ex:
                    logger.critical(f"[Executor] CRITICAL: Failed to flatten naked position! {ex}")

        except Exception as e:
            logger.error(f"[Executor] Break-Even API update failed: {e}", exc_info=True)

    # ------------------------------------------------------------------
    # System lock helpers (used by Panic Mode)
    # ------------------------------------------------------------------
    def is_system_locked(self) -> bool:
        """Return True if the bot is in a panic-mode cooldown lock."""
        if self.system_locked and time.time() >= self.lock_expiry:
            self.system_locked = False
            self.lock_expiry = 0.0
            logger.info("[PanicMode] System lock expired — bot is resuming normal operation.")
        return self.system_locked

    # ------------------------------------------------------------------
    # Panic Mode — Emergency Flatten & System Lock
    # ------------------------------------------------------------------
    async def engage_panic_mode(self, reason: str, lock_seconds: int = 300):
        """
        Emergency capital-protection routine.

        Triggered when a dangerous market condition is detected (e.g. sudden
        BTC flash-crash, ULIS AVOID verdict, or cascade risk spike).

        Steps:
          1. Log and alert immediately.
          2. Cancel all known open orders (SL / TP).
          3. Flatten any active position with a market order (IOC intent).
          4. Lock the system for `lock_seconds` (default 5 min) to prevent
             re-entry while conditions are still dangerous.
        """
        import asyncio

        logger.critical(f"[PanicMode] !!! PANIC MODE ENGAGED: {reason} !!!")

        # --- 1. Notify immediately ----------------------------------------
        try:
            await self.notifier.send_message(
                f"🚨 <b>PANIC MODE ENGAGED</b>\n"
                f"━━━━━━━━━━━━━━━\n"
                f"Reason: <code>{reason}</code>\n"
                f"Bot locked for {lock_seconds // 60} min. All positions flattened."
            )
        except Exception as e:
            logger.warning(f"[PanicMode] Telegram alert failed: {e}")

        # --- 2. Cancel all known open orders --------------------------------
        orders_to_cancel = []
        if self.active_position:
            sl_id = self.active_position.get("sl_order_id")
            tp_id = self.active_position.get("tp_order_id")
            sym   = self.active_position.get("symbol", "")
            if sl_id:
                orders_to_cancel.append((sl_id, sym, "SL"))
            if tp_id:
                orders_to_cancel.append((tp_id, sym, "TP"))

        if self.pending_order:
            pid = self.pending_order.get("id")
            psym = self.pending_order.get("symbol", "")
            if pid:
                orders_to_cancel.append((pid, psym, "PENDING"))

        if not self.dry_run:
            for order_id, sym, label in orders_to_cancel:
                try:
                    await self.exchange.cancel_order(order_id, sym)
                    logger.info(f"[PanicMode] Cancelled {label} order {order_id} ✓")
                except Exception as e:
                    logger.warning(f"[PanicMode] Could not cancel {label} order {order_id}: {e}")
        else:
            for order_id, sym, label in orders_to_cancel:
                logger.info(f"[PanicMode][DRY-RUN] Would cancel {label} order {order_id}")

        # --- 3. Flatten active position -------------------------------------
        if self.active_position:
            pos      = self.active_position
            ex_sym   = pos["symbol"]
            pos_side = pos["side"]           # "buy" or "sell"
            pos_size = pos["size"]
            close_side = "sell" if pos_side == "buy" else "buy"

            if self.dry_run:
                pnl_est = 0.0  # Can't calculate without live price here
                logger.info(
                    f"[PanicMode][DRY-RUN] Would flatten {pos_side.upper()} "
                    f"{pos_size:.6f} {ex_sym} via MARKET {close_side.upper()}"
                )
            else:
                for attempt in range(3):
                    try:
                        if self.exchange_id == "coinbase" and close_side == "buy":
                            # Coinbase BUY needs quote cost, not base amount
                            # Approximate cost from position size * last known price
                            # We pass size as base amount with createMarketBuyOrderRequiresPrice=False
                            await self.exchange.create_market_order(
                                ex_sym, close_side, pos_size,
                                params={"createMarketBuyOrderRequiresPrice": False}
                            )
                        else:
                            await self.exchange.create_market_order(ex_sym, close_side, pos_size)
                        logger.info(
                            f"[PanicMode] Emergency MARKET {close_side.upper()} "
                            f"{pos_size:.6f} {ex_sym} — position flattened ✓"
                        )
                        break
                    except Exception as e:
                        if attempt == 2:
                            logger.critical(
                                f"[PanicMode] CRITICAL: Failed to flatten position after 3 attempts! "
                                f"MANUAL INTERVENTION REQUIRED! {e}"
                            )
                            try:
                                await self.notifier.send_message(
                                    f"🆘 <b>CRITICAL — MANUAL INTERVENTION REQUIRED</b>\n"
                                    f"━━━━━━━━━━━━━━━\n"
                                    f"Bot could not flatten <code>{ex_sym}</code> position!\n"
                                    f"Error: <code>{e}</code>"
                                )
                            except Exception:
                                pass
                        else:
                            logger.warning(f"[PanicMode] Flatten attempt {attempt + 1} failed: {e}. Retrying…")
                            await asyncio.sleep(0.5)

            self.active_position = None
            self.pending_order   = None

        # --- 4. Lock system -------------------------------------------------
        self.system_locked   = True
        self.lock_expiry     = time.time() + lock_seconds
        self.last_panic_reason = reason
        logger.warning(
            f"[PanicMode] System locked for {lock_seconds}s "
            f"(until {time.strftime('%H:%M:%S', time.localtime(self.lock_expiry))}). "
            f"Reason: {reason}"
        )
