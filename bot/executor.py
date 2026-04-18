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
        logger.info(f"[Executor] Binance ({'testnet' if testnet else 'live'}) initialised as {active_type.upper()} via {exchange_class.__name__}.")
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
                
                # --- Position Reconciliation ---
                try:
                    positions = await self.exchange.fetch_positions()
                    for pos in positions:
                        qty = float(pos.get("contracts", 0) or pos.get("positionAmt", 0))
                        if abs(qty) > 0:
                            side = "buy" if qty > 0 else "sell"
                            entry_p = float(pos.get("entryPrice", 0))
                            logger.info(f"[Executor] Reconciled open position on boot: {side.upper()} {abs(qty)} @ {entry_p}")
                            
                            import time
                            self.active_position = {
                                "id": f"reconciled-{int(time.time())}",
                                "symbol": pos.get("symbol"),
                                "side": side,
                                "entry_price": entry_p,
                                "qty": abs(qty),
                                "take_profit": 0,
                                "stop_loss": 0,
                                "tp_order_id": None,
                                "sl_order_id": None,
                                "ts": int(time.time() * 1000)
                            }
                            
                            # Try binding existing SL/TP orders
                            open_orders = await self.exchange.fetch_open_orders(pos.get("symbol"))
                            for o in open_orders:
                                o_type = str(o.get("type", "")).lower()
                                price = o.get("stopPrice") or o.get("price")
                                if "stop" in o_type:
                                    self.active_position["sl_order_id"] = o.get("id")
                                    self.active_position["stop_loss"] = price
                                elif "take_profit" in o_type or "profit" in o_type:
                                    self.active_position["tp_order_id"] = o.get("id")
                                    self.active_position["take_profit"] = price
                except Exception as e:
                    logger.warning(f"[Executor] Could not reconcile historical positions: {e}")

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
        """Injects minimal market data into CCXT to prevent crashes."""
        if not hasattr(self.exchange, 'markets') or self.exchange.markets is None:
            self.exchange.markets = {}
        if not hasattr(self.exchange, 'symbols') or self.exchange.symbols is None:
            self.exchange.symbols = []

        if self.exchange_id == "coinbase":
            self.exchange.markets['BTC/USDC'] = {
                'id': 'BTC-USDC', 'symbol': 'BTC/USDC', 'base': 'BTC', 'quote': 'USDC',
                'precision': {'amount': 0.00000001, 'price': 0.01},
                'limits': {'amount': {'min': 0.00001, 'max': 1000}, 'price': {'min': 0.01, 'max': 1000000}, 'cost': {'min': 1.0}},
                'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
            }
            self.exchange.markets['BTC/USD'] = {
                'id': 'BTC-USD', 'symbol': 'BTC/USD', 'base': 'BTC', 'quote': 'USD',
                'precision': {'amount': 0.00000001, 'price': 0.01},
                'limits': {'amount': {'min': 0.00001, 'max': 1000}, 'price': {'min': 0.01, 'max': 1000000}, 'cost': {'min': 1.0}},
                'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
            }
            if 'BTC/USDC' not in self.exchange.symbols: self.exchange.symbols.append('BTC/USDC')
            if 'BTC/USD' not in self.exchange.symbols: self.exchange.symbols.append('BTC/USD')
        
        elif self.is_futures:
            self.exchange.markets['BTC/USDT:USDT'] = {
                'id': 'BTCUSDT', 'symbol': 'BTC/USDT:USDT', 'base': 'BTC', 'quote': 'USDT', 'settle': 'USDT',
                'precision': {'amount': 0.001, 'price': 0.1},
                'limits': {'amount': {'min': 0.001, 'max': 1000}, 'price': {'min': 0.1, 'max': 1000000}},
                'active': True, 'type': 'future', 'spot': False, 'margin': False, 'contract': True
            }
            if 'BTC/USDT:USDT' not in self.exchange.symbols: self.exchange.symbols.append('BTC/USDT:USDT')

    async def close(self):
        await self.exchange.close()

    # ------------------------------------------------------------------
    # Firestore trade logger
    # ------------------------------------------------------------------
    def _log_trade(self, symbol: str, side: str, verdict: str,
                   entry: float, stop_loss: float, take_profit: float,
                   ulis_verdict: str = ""):
        """Write a trade record to Firestore `botTrades` collection."""
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
            }
            db.collection("botTrades").add(doc)
            logger.info("[Executor] Trade logged to Firestore ✓")
        except Exception as e:
            logger.warning(f"[Executor] Failed to log trade to Firestore: {e}")

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

        # 1. Calculate Available Equity for accurate risk sizing.
        # Futures: Use only available margin (Cash) to prevent oversized rejected orders.
        # Spot: Use Total Equity (Cash + BTC) to size based on full portfolio.
        if self.is_futures:
            equity = await self.get_usdt_balance(account_size)
        else:
            equity = await self.get_total_equity(current_price, account_size)
        
        if side == "buy":
            usdc_equity = await self.get_usdt_balance(account_size)
            if usdc_equity < 5:
                err = f"Insufficient USDC (${usdc_equity:.2f}) to open LONG. Min $5 required."
                logger.warning(f"[Executor] {err}")
                await self.notifier.send_error_alert(err)
                return
        else:
            # For SELL: Check balance appropriately
            if self.is_futures:
                # Futures: Need USDC margin to open short
                usdc_equity = await self.get_usdt_balance(account_size)
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

        raw_size = self.calculate_position_size(current_price, stop_loss, equity, max_risk_pct)
        if raw_size <= 0.0:
            logger.warning("[Executor] Calculated position size is 0. Aborting.")
            return

        # Translate symbol to exchange format (unified CCXT symbol)
        if self.exchange_id == "coinbase":
            ex_symbol = self._to_exchange_symbol(symbol)
        else:
            ex_symbol = self._get_ccxt_symbol(symbol)

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
                            # Coinbase Advanced Trade V3 specific stop directions
                            stop_params = {"stop_price": float(self.exchange.price_to_precision(ex_symbol, stop_loss))}
                            if self.exchange_id == "coinbase":
                                direction = "STOP_DIRECTION_STOP_UP" if stop_loss > current_price else "STOP_DIRECTION_STOP_DOWN"
                                stop_params["stop_direction"] = direction
                                
                            sl_order = await self.exchange.create_order(
                                symbol=ex_symbol, type="limit", side=sl_side,
                                amount=fmt_size,
                                price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                                params=stop_params,
                            )
                        break
                    except Exception as e:
                        if attempt == 2: raise e
                        logger.warning(f"[Executor] SL placement failed: {e}. Retrying {attempt+1}/3...")
                        await asyncio.sleep(0.5)
                sl_order_id = sl_order.get("id")
                logger.info(f"[Executor] SL attached at {stop_loss} (id={sl_order_id})")

                # Take-profit limit order
                tp_order = None
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

        if side == "buy":
            if current_price <= sl:
                pnl = (current_price - pos["entry_price"]) * pos["size"]
                logger.info(f"[Executor] STOP LOSS HIT. PnL=${pnl:.2f}")
                self.active_position = None
                self.pending_order = None
                return True, pnl
            if current_price >= tp:
                pnl = (current_price - pos["entry_price"]) * pos["size"]
                logger.info(f"[Executor] TAKE PROFIT HIT. PnL=${pnl:.2f}")
                self.active_position = None
                self.pending_order = None
                return True, pnl
        else:
            if current_price >= sl:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                logger.info(f"[Executor] STOP LOSS HIT (SHORT). PnL=${pnl:.2f}")
                self.active_position = None
                self.pending_order = None
                return True, pnl
            if current_price <= tp:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                logger.info(f"[Executor] TAKE PROFIT HIT (SHORT). PnL=${pnl:.2f}")
                self.active_position = None
                self.pending_order = None
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
            # ── PATCH #4: Apply fee buffer to break-even lock ──
            fee_buffer_pct = 0.0015  # 0.15% buffer covers round-trip fees (~0.08%) + margin
            new_sl = entry * (1.0 + fee_buffer_pct) if side == "buy" else entry * (1.0 - fee_buffer_pct)
            pos["stop_loss"] = round(new_sl, 2)
            return

        # LIVE MODE: Cancel old SL and place new one at Entry
        import asyncio
        try:
            ex_symbol = pos["symbol"]
            old_sl_id = pos.get("sl_order_id")
            fmt_size  = pos["size"]

            # Fix Race Condition: Set state BEFORE yielding via await
            pos["be_triggered"] = True
            # ── PATCH #4: Apply fee buffer to break-even lock ──
            fee_buffer_pct = 0.0015  # 0.15% buffer covers round-trip fees (~0.08%) + margin
            be_stop_loss = entry * (1.0 + fee_buffer_pct) if side == "buy" else entry * (1.0 - fee_buffer_pct)
            pos["stop_loss"] = round(be_stop_loss, 2)

            cancel_success = True
            if old_sl_id:
                for attempt in range(3):
                    try:
                        await self.exchange.cancel_order(old_sl_id, ex_symbol)
                        cancel_success = True
                        pos["sl_order_id"] = None
                        logger.info(f"[Executor] Cancelled old SL {old_sl_id} for Break-Even ✓")
                        break
                    except Exception as e:
                        err_str = str(e).lower()
                        # -2011 / "Unknown order sent" → Binance already removed it
                        # (e.g. closePosition=True orders are auto-cleaned, or it was
                        #  already triggered). Treat as success — the SL is gone.
                        already_gone = (
                            "-2011" in err_str
                            or "unknown order" in err_str
                            or "not found" in err_str
                            or "not_found" in err_str
                        )
                        if already_gone:
                            cancel_success = True
                            pos["sl_order_id"] = None
                            logger.info(f"[Executor] Old SL {old_sl_id} already gone on Binance — proceeding with BE placement ✓")
                            break
                        if attempt == 2:
                            # Genuinely failed — log but do NOT revert be_triggered.
                            # The in-memory stop_loss was already updated; reverting
                            # be_triggered would cause an infinite retry storm.
                            logger.warning(f"[Executor] Could not cancel old SL for Break-Even (will proceed anyway): {e}")
                            cancel_success = True  # attempt BE placement regardless
                            break
                        await asyncio.sleep(0.5)

            if not cancel_success:
                return

            sl_side = "sell" if side == "buy" else "buy"
            sl_limit = be_stop_loss * 0.999 if side == "buy" else be_stop_loss * 1.001

            new_sl_order = None
            for attempt in range(3):
                try:
                    if self.is_futures:
                        new_sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP_MARKET", side=sl_side,
                            amount=fmt_size,
                            params={
                                "stopPrice":    float(self.exchange.price_to_precision(ex_symbol, be_stop_loss)),
                                "closePosition": True,
                                "workingType":  "MARK_PRICE",
                            },
                        )
                    elif self.exchange_id == "binance":
                        new_sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="STOP_LOSS_LIMIT", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                            params={"stopPrice": float(self.exchange.price_to_precision(ex_symbol, be_stop_loss))},
                        )
                    else:
                        new_sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="limit", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                            params={"stop_price": float(self.exchange.price_to_precision(ex_symbol, be_stop_loss))},
                        )
                    break
                except Exception as e:
                    if attempt == 2:
                        logger.error(f"[Executor] Failed to create Break-Even SL: {e}")
                        break
                    await asyncio.sleep(0.5)

            if new_sl_order and new_sl_order.get("id"):
                pos["sl_order_id"] = new_sl_order.get("id")
                logger.info(f"[Executor] New Break-Even SL attached at {be_stop_loss:.2f} (fee-buffered, id={pos['sl_order_id']})")
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

    def is_system_locked(self) -> bool:
        """Check if the system is currently under a panic-mode lock."""
        return time.time() < self.lock_expiry

    async def engage_panic_mode(self, reason: str, lock_seconds: int = 300):
        """
        Engages the killswitch: closes any active position and locks the system.
        """
        logger.warning(f"[PanicMode] ENGAGED! Reason: {reason}. Locking system for {lock_seconds}s.")
        self.lock_expiry = time.time() + lock_seconds
        self.last_panic_reason = reason
        
        if self.active_position:
            await self.emergency_flatten(f"PANIC: {reason}")
        
        # Notify user via Telegram
        if self.notifier:
            await self.notifier.send_message(f"🚨 PANIC MODE ENGAGED!\nReason: {reason}\nSystem locked for {lock_seconds}s.")

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
                except:
                    pass
                
                # 2. Market close
                await self.exchange.create_market_order(ex_symbol, close_side, size)
            
            logger.info(f"[Executor] Flattened {ex_symbol} ✅")
            self.active_position = None
        except Exception as e:
            logger.error(f"[Executor] FAILED TO FLATTEN POSITION! {e}")
            if self.notifier:
                await self.notifier.send_message(f"‼️ CRITICAL: Failed to flatten position during {reason}! Error: {e}")
