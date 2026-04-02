import logging
import time
from typing import Dict, Any, Optional
import ccxt.async_support as ccxt
from bot import heartbeat

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
    ):
        self.testnet   = testnet
        self.exchange_id = exchange_id.lower()
        self.dry_run   = dry_run or not self._has_credentials(
            exchange_id, api_key, api_secret, coinbase_key_name, coinbase_private_key
        )

        if self.dry_run:
            logger.warning("[Executor] DRY-RUN mode: no real orders will be placed.")

        # ── Exchange initialisation ───────────────────────────────────────
        if self.exchange_id == "coinbase":
            self.exchange = self._init_coinbase(
                coinbase_key_name, coinbase_private_key
            )
        else:
            # Binance (legacy / fallback)
            self.exchange = self._init_binance(api_key, api_secret, testnet)

        self.active_position: Optional[Dict[str, Any]] = None

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
                "defaultType": "spot",
            },
        })
        logger.info("[Executor] Coinbase Advanced Trade (spot) initialised.")
        return exchange

    @staticmethod
    def _init_binance(api_key: str, api_secret: str, testnet: bool) -> ccxt.Exchange:
        exchange = ccxt.binance({
            "apiKey":          api_key,
            "secret":          api_secret,
            "enableRateLimit": True,
            "options": {
                "defaultType": "spot",
            },
        })
        if testnet:
            exchange.set_sandbox_mode(True)
        logger.info(f"[Executor] Binance ({'testnet' if testnet else 'live'}) initialised.")
        return exchange

    # ------------------------------------------------------------------
    # Symbol translation helpers
    # ------------------------------------------------------------------
    def _to_exchange_symbol(self, symbol: str) -> str:
        """
        Translate a Binance-style symbol (BTCUSDT) to the exchange's native format.
        Coinbase uses BTC/USD (ccxt unified) or BTC-USD (raw API).
        ccxt accepts the unified BTC/USDT format for both exchanges.
        """
        if self.exchange_id != "coinbase":
            return symbol

        # Map BTCUSDT → BTC/USDT, BTC-USD → BTC/USD, etc.
        # If already in BTC-USD or BTC/USD form, convert to ccxt unified
        if "/" in symbol:
            return symbol  # already unified
        if "-" in symbol:
            return symbol.replace("-", "/")  # BTC-USD → BTC/USD

        # BTCUSDT style → BTC/USDT
        # Common quote currencies in order of descending length (avoid partial match)
        for quote in ("USDT", "USDC", "USD", "BTC", "ETH", "BNB"):
            if symbol.endswith(quote):
                base = symbol[: -len(quote)]
                return f"{base}/{quote}"
        return symbol  # fallback — return as-is

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
            logger.error(f"[Executor] Failed to initialise exchange: {e}")

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
            return account_size   # Configurable simulated equity
        try:
            bal = await self.exchange.fetch_balance()
            free = bal.get("free", {})
            # Sum all stablecoin balances — funds may be split across wallets
            usdt = float(free.get("USDT", 0.0))
            usd  = float(free.get("USD",  0.0))
            usdc = float(free.get("USDC", 0.0))
            total = usdt + usdc + usd
            logger.info(f"[Executor] Balance: USDC={usdc:.2f} USD={usd:.2f} USDT={usdt:.2f} → total={total:.2f}")
            return total
        except Exception as e:
            logger.error(f"[Executor] fetch_balance error: {e}")
            return 0.0

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

        equity = await self.get_usdt_balance(account_size)
        if equity < 5:
            logger.warning(f"[Executor] Insufficient equity ({equity:.2f}). Min $5 required.")
            return

        raw_size = self.calculate_position_size(current_price, stop_loss, equity, max_risk_pct)
        if raw_size <= 0.0:
            logger.warning("[Executor] Calculated position size is 0. Aborting.")
            return

        # Translate symbol to exchange format
        ex_symbol = self._to_exchange_symbol(symbol)

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
            return

        # ── LIVE EXECUTION ────────────────────────────────────────────────
        try:
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
                    if attempt == 2: raise e
                    logger.warning(f"[Executor] Market order failed: {e}. Retrying {attempt+1}/3...")
                    await asyncio.sleep(0.5)
            logger.info(f"[Executor] Market order placed: id={order.get('id')} status={order.get('status')}")

            sl_side = "sell" if side == "buy" else "buy"
            sl_order_id = None
            tp_order_id = None

            # Stop-loss order (exchange-specific type)
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
                        sl_order = await self.exchange.create_order(
                            symbol=ex_symbol, type="limit", side=sl_side,
                            amount=fmt_size,
                            price=float(self.exchange.price_to_precision(ex_symbol, sl_limit)),
                            params={"stop_price": float(self.exchange.price_to_precision(ex_symbol, stop_loss))},
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
            self._log_trade(ex_symbol, side, verdict, current_price, stop_loss, take_profit, ulis_verdict)

        except ccxt.InsufficientFunds as e:
            logger.error(f"[Executor] Insufficient funds: {e}")
        except ccxt.InvalidOrder as e:
            logger.error(f"[Executor] Invalid order: {e}")
        except Exception as e:
            logger.error(f"[Executor] Order placement failed: {e}", exc_info=True)
            
            # FLAT PREVENT NAKED POSITION
            if self.active_position is None and 'order' in locals() and order and order.get('id'):
                logger.error("[Executor] SL/TP failed after Market Fill. FLATTENING NAKED POSITION IMMEDIATELY!")
                close_side = "sell" if side == "buy" else "buy"
                try:
                    await self.exchange.create_market_order(ex_symbol, close_side, fmt_size)
                    logger.info("[Executor] Flattened naked position successfully.")
                except Exception as ex:
                    logger.critical(f"[Executor] CRITICAL: Failed to flatten naked position! MANUAL INTERVENTION REQUIRED! {ex}")

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
                return True, pnl
            if current_price >= tp:
                pnl = (current_price - pos["entry_price"]) * pos["size"]
                logger.info(f"[Executor] TAKE PROFIT HIT. PnL=${pnl:.2f}")
                self.active_position = None
                return True, pnl
        else:
            if current_price >= sl:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                logger.info(f"[Executor] STOP LOSS HIT (SHORT). PnL=${pnl:.2f}")
                self.active_position = None
                return True, pnl
            if current_price <= tp:
                pnl = (pos["entry_price"] - current_price) * pos["size"]
                logger.info(f"[Executor] TAKE PROFIT HIT (SHORT). PnL=${pnl:.2f}")
                self.active_position = None
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

            if new_sl:
                pos["sl_order_id"] = new_sl.get("id")
                pos["be_triggered"] = True
                pos["stop_loss"]    = entry
                logger.info(f"[Executor] New Break-Even SL attached at {entry} (id={pos['sl_order_id']})")

        except Exception as e:
            logger.error(f"[Executor] Break-Even API update failed: {e}", exc_info=True)
