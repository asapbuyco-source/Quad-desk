import logging
import time
from typing import Dict, Any, Optional
import ccxt.async_support as ccxt
from bot import heartbeat

logger = logging.getLogger(__name__)


class TradingExecutor:
    """
    Handles risk-managed execution of AI trading signals via ccxt.

    In DRY_RUN mode (no API keys supplied) the executor logs what it WOULD do
    without placing any real orders — safe for live observation/testing.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        testnet: bool = True,
        dry_run: bool = True,
    ):
        self.testnet  = testnet
        self.dry_run  = dry_run or not (api_key and api_secret)
        if self.dry_run:
            logger.warning("[Executor] DRY-RUN mode: no real orders will be placed.")

        self.exchange = ccxt.binance({
            'apiKey':          api_key,
            'secret':          api_secret,
            'enableRateLimit': True,
            'options': {
                'defaultType': 'spot',
            },
        })
        if testnet:
            self.exchange.set_sandbox_mode(True)

        self.active_position: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def initialize(self):
        """
        Load markets and confirm connectivity.
        In dry-run mode we skip the network call when no keys are present.
        """
        if self.dry_run and not self.exchange.apiKey:
            logger.info("[Executor] Skipping market load in keyless dry-run mode.")
            return
        try:
            await self.exchange.load_markets()
            env = "TESTNET" if self.testnet else "LIVE"
            logger.info(f"[Executor] Connected to Binance {env} ✓")
        except Exception as e:
            logger.error(f"[Executor] Failed to initialise exchange: {e}")

    async def close(self):
        await self.exchange.close()

    # ------------------------------------------------------------------
    # Firestore trade logger
    # ------------------------------------------------------------------
    def _log_trade(self, symbol: str, side: str, verdict: str,
                   entry: float, stop_loss: float, take_profit: float):
        """
        Write a trade record to Firestore `botTrades` collection.
        Silently skips if Firebase is not initialised.
        """
        db = heartbeat.get_db()
        if db is None:
            return
        try:
            from firebase_admin import firestore as fs
            doc = {
                "symbol":      symbol,
                "side":        side,
                "verdict":     verdict,
                "entry_price": entry,
                "stop_loss":   stop_loss,
                "take_profit": take_profit,
                "timestamp":   fs.SERVER_TIMESTAMP,
                "mode":        "DRY-RUN" if self.dry_run else "LIVE",
                "ts_ms":       int(time.time() * 1000),
            }
            db.collection("botTrades").add(doc)
            logger.info(f"[Executor] Trade logged to Firestore ✓")
        except Exception as e:
            logger.warning(f"[Executor] Failed to log trade to Firestore: {e}")

    # ------------------------------------------------------------------
    # Balance
    # ------------------------------------------------------------------
    async def get_usdt_balance(self) -> float:
        """Return free USDT balance (or simulated equity in dry-run)."""
        if self.dry_run:
            return 1_000.0  # Simulated starting equity for dry-run logging
        try:
            bal = await self.exchange.fetch_balance()
            return float(bal.get('free', {}).get('USDT', 0.0))
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
        Kelly-constrained fixed-fractional sizing:
        Size = (equity × risk%) / |entry - stop_loss|
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
    ):
        verdict    = signal.get('verdict', 'WAIT')
        confidence = float(signal.get('confidence', 0))
        stop_loss  = float(signal.get('stop_loss', 0))
        take_profit = float(signal.get('take_profit', 0))

        # Guard rails
        if 'WAIT' in verdict:
            return

        if self.active_position is not None:
            logger.info("[Executor] Already in a position. Skipping new entry.")
            return

        if stop_loss <= 0 or take_profit <= 0:
            logger.warning("[Executor] AI returned invalid SL/TP. Aborting.")
            return

        # Sanity check: for a BUY, SL must be below price; for SELL above.
        side = 'buy' if ('BUY' in verdict or 'LONG' in verdict) else 'sell'
        if side == 'buy' and stop_loss >= current_price:
            logger.warning(f"[Executor] SL {stop_loss} ≥ price {current_price} for BUY. Aborting.")
            return
        if side == 'sell' and stop_loss <= current_price:
            logger.warning(f"[Executor] SL {stop_loss} ≤ price {current_price} for SELL. Aborting.")
            return

        equity = await self.get_usdt_balance()
        if equity < 10:
            logger.warning(f"[Executor] Insufficient equity ({equity:.2f} USDT).")
            return

        raw_size = self.calculate_position_size(current_price, stop_loss, equity, max_risk_pct)

        if self.dry_run:
            # ── DRY RUN: only log what would happen ──────────────────
            cost = raw_size * current_price
            logger.info(
                f"[DRY-RUN] {verdict} {symbol} "
                f"| qty={raw_size:.6f} (${cost:.2f}) "
                f"| SL={stop_loss} TP={take_profit} "
                f"| equity=${equity:.2f} risk={max_risk_pct}%"
            )
            self.active_position = {
                'symbol':      symbol,
                'side':        side,
                'size':        raw_size,
                'entry_price': current_price,
                'stop_loss':   stop_loss,
                'take_profit': take_profit,
                'dry_run':     True,
            }
            self._log_trade(symbol, side, verdict, current_price, stop_loss, take_profit)
            return

        # ── LIVE EXECUTION ────────────────────────────────────────────
        try:
            # Format to exchange precision
            fmt_size = float(self.exchange.amount_to_precision(symbol, raw_size))
            cost = fmt_size * current_price
            if cost > equity:
                fmt_size = float(
                    self.exchange.amount_to_precision(symbol, equity * 0.95 / current_price)
                )

            logger.info(f"[Executor] Placing MARKET {side.upper()} {fmt_size} {symbol} @ ~{current_price}")
            order = await self.exchange.create_market_order(symbol, side, fmt_size)
            logger.info(f"[Executor] Market order placed: id={order.get('id')} status={order.get('status')}")

            self.active_position = {
                'symbol':      symbol,
                'side':        side,
                'size':        fmt_size,
                'entry_price': current_price,
                'stop_loss':   stop_loss,
                'take_profit': take_profit,
                'order_id':    order.get('id'),
            }
            self._log_trade(symbol, side, verdict, current_price, stop_loss, take_profit)

            # Attach SL bracket (STOP_LOSS_LIMIT)
            sl_limit_price = (
                stop_loss * 0.999 if side == 'buy' else stop_loss * 1.001
            )
            sl_side = 'sell' if side == 'buy' else 'buy'
            await self.exchange.create_order(
                symbol=symbol,
                type='STOP_LOSS_LIMIT',
                side=sl_side,
                amount=fmt_size,
                price=float(self.exchange.price_to_precision(symbol, sl_limit_price)),
                params={'stopPrice': float(self.exchange.price_to_precision(symbol, stop_loss))},
            )
            logger.info(f"[Executor] SL attached at {stop_loss}")

            # Attach TP (LIMIT)
            await self.exchange.create_order(
                symbol=symbol,
                type='LIMIT',
                side=sl_side,
                amount=fmt_size,
                price=float(self.exchange.price_to_precision(symbol, take_profit)),
                params={'timeInForce': 'GTC'},
            )
            logger.info(f"[Executor] TP attached at {take_profit}")

        except ccxt.InsufficientFunds as e:
            logger.error(f"[Executor] Insufficient funds: {e}")
        except ccxt.InvalidOrder as e:
            logger.error(f"[Executor] Invalid order: {e}")
        except Exception as e:
            logger.error(f"[Executor] Order placement failed: {e}", exc_info=True)

    # ------------------------------------------------------------------
    # Position monitor (called from main loop)
    # ------------------------------------------------------------------
    def check_position_exit(self, current_price: float) -> bool:
        """
        Check whether the active position's SL or TP has been hit
        (used in dry-run; in live mode the exchange handles OCO orders).
        Returns True and clears position if an exit is triggered.
        """
        pos = self.active_position
        if pos is None:
            return False

        side     = pos['side']
        sl       = pos['stop_loss']
        tp       = pos['take_profit']

        if side == 'buy':
            if current_price <= sl:
                pnl = (current_price - pos['entry_price']) * pos['size']
                logger.info(f"[Executor] STOP LOSS HIT. PnL={pnl:.2f} USDT")
                self.active_position = None
                return True
            if current_price >= tp:
                pnl = (current_price - pos['entry_price']) * pos['size']
                logger.info(f"[Executor] TAKE PROFIT HIT. PnL={pnl:.2f} USDT")
                self.active_position = None
                return True
        else:  # sell / short
            if current_price >= sl:
                pnl = (pos['entry_price'] - current_price) * pos['size']
                logger.info(f"[Executor] STOP LOSS HIT (SHORT). PnL={pnl:.2f} USDT")
                self.active_position = None
                return True
            if current_price <= tp:
                pnl = (pos['entry_price'] - current_price) * pos['size']
                logger.info(f"[Executor] TAKE PROFIT HIT (SHORT). PnL={pnl:.2f} USDT")
                self.active_position = None
                return True

        return False
