"""
tests/test_executor.py
======================
Unit tests for TradingExecutor — focused on the P0-1 ghost-position fix.

Scenario:
  Binance USDM Futures OMITS zero-quantity positions from fetch_positions.
  When the SL fires on the exchange, the bot's internal active_position must
  be cleared within one poll cycle (≤30 s in live mode).

Run with:
    python -m pytest tests/test_executor.py -v
"""

import asyncio
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal stub so we can instantiate TradingExecutor without real credentials
# ---------------------------------------------------------------------------

def _make_executor(dry_run=True):
    """Return a TradingExecutor in dry-run mode with a mocked exchange."""
    from bot.executor import TradingExecutor

    with patch("bot.executor.ccxt") as mock_ccxt:
        # Stub the ccxt exchange so __init__ doesn't hit the network
        mock_exchange = MagicMock()
        mock_ccxt.binanceusdm.return_value = mock_exchange
        mock_ccxt.coinbase.return_value = mock_exchange

        executor = TradingExecutor(
            api_key="test_key",
            api_secret="test_secret",
            testnet=True,
            dry_run=dry_run,
            exchange_id="binanceusdm",
            tg_token="",
            tg_chat_id="",
        )

    executor.exchange = MagicMock()
    executor.notifier = AsyncMock()
    executor.dry_run = False   # force live-mode path in _check_live_position_exit
    executor.TAKER_FEE = 0.0005
    return executor


# ---------------------------------------------------------------------------
# P0-1: Ghost position — fetch_positions returns EMPTY list (Binance flat state)
# ---------------------------------------------------------------------------

class TestGhostPositionFix:

    def _make_active_position(self):
        return {
            "symbol":      "BTC/USDT:USDT",
            "side":        "buy",
            "size":        0.001,
            "entry_price": 78439.90,
            "stop_loss":   77865.59,
            "take_profit": 79600.00,
            "dry_run":     False,
            "trade_doc_id": "test_doc_123",
        }

    @pytest.mark.asyncio
    async def test_ghost_cleared_when_positions_empty(self):
        """
        Binance returns an empty list from fetch_positions when position is flat.
        The bot must detect the absence of the symbol and clear active_position.
        """
        executor = _make_executor()
        executor.active_position = self._make_active_position()

        # Exchange returns empty list — Binance flat-position behaviour
        executor.exchange.fetch_positions = AsyncMock(return_value=[])

        # Trade history: one closing trade with realized PnL
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[
            {
                "price": "77841.10",
                "info": {"realizedPnl": "-0.60"},
            }
        ])
        executor._update_trade_exit = MagicMock()

        exited, pnl = await executor._check_live_position_exit(current_price=77841.10)

        assert exited is True, "Position should be detected as closed"
        assert executor.active_position is None, "active_position must be cleared"
        expected_fee = (78439.90 + 77841.10) * 0.001 * executor.TAKER_FEE
        expected_pnl = -0.60 - expected_fee
        assert pnl == pytest.approx(expected_pnl, abs=0.01)
        executor.notifier.send_close_alert.assert_awaited_once()
        executor._update_trade_exit.assert_called_once_with(
            "test_doc_123", 77841.10, pytest.approx(expected_pnl, abs=0.01)
        )

    @pytest.mark.asyncio
    async def test_exchange_split_close_fills_are_aggregated(self):
        """
        Binance may split one SL/TP close into several trade fills. The bot must
        account for the whole close, not only the latest tiny fill.
        """
        executor = _make_executor()
        entry = 62588.00
        close = 62407.90
        size = 0.005
        entry_ts = time.time() - 60
        entry_fee = entry * size * executor.TAKER_FEE
        close_fee_per_fill = close * 0.001 * executor.TAKER_FEE
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": size,
            "entry_price": entry,
            "entry_fee": entry_fee,
            "stop_loss": 62256.11,
            "take_profit": 63071.16,
            "dry_run": False,
            "trade_doc_id": "split_doc_123",
            "entry_ts": entry_ts,
        }
        executor.exchange.fetch_positions = AsyncMock(return_value=[])
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[
            {
                "side": "sell",
                "amount": "0.001",
                "price": str(close),
                "timestamp": int((entry_ts + 10 + i) * 1000),
                "info": {
                    "realizedPnl": "-0.1801",
                    "commission": str(close_fee_per_fill),
                },
            }
            for i in range(5)
        ])
        executor._update_trade_exit = MagicMock()

        exited, pnl = await executor._check_live_position_exit(current_price=close)

        expected_gross = -0.1801 * 5
        expected_fees = entry_fee + (close_fee_per_fill * 5)
        expected_pnl = expected_gross - expected_fees
        assert exited is True
        assert pnl == pytest.approx(expected_pnl, abs=1e-6)
        executor.exchange.fetch_my_trades.assert_awaited_once_with("BTC/USDT:USDT", limit=50)
        executor._update_trade_exit.assert_called_once_with(
            "split_doc_123", pytest.approx(close, abs=1e-9), pytest.approx(expected_pnl, abs=1e-6)
        )

    @pytest.mark.asyncio
    async def test_position_still_open_when_symbol_in_response(self):
        """
        If fetch_positions returns the symbol with qty > 0, position is still open.
        active_position must NOT be cleared.
        """
        executor = _make_executor()
        executor.active_position = self._make_active_position()

        executor.exchange.fetch_positions = AsyncMock(return_value=[
            {
                "symbol":    "BTC/USDT:USDT",
                "contracts": 0.001,   # non-zero — still open
            }
        ])

        exited, pnl = await executor._check_live_position_exit(current_price=78500.0)

        assert exited is False, "Position should NOT be detected as closed"
        assert executor.active_position is not None, "active_position must still exist"
        assert pnl == 0.0

    @pytest.mark.asyncio
    async def test_pnl_estimated_when_no_trade_history(self):
        """
        If fetch_my_trades fails, PnL is estimated from entry/fill geometry.
        Position must still be cleared.
        """
        executor = _make_executor()
        executor.active_position = self._make_active_position()

        executor.exchange.fetch_positions = AsyncMock(return_value=[])
        executor.exchange.fetch_my_trades = AsyncMock(side_effect=Exception("network error"))
        executor._update_trade_exit = MagicMock()

        fill_price = 77865.59  # SL price
        exited, pnl = await executor._check_live_position_exit(current_price=fill_price)

        assert exited is True
        assert executor.active_position is None
        # PnL should be negative (SL loss)
        assert pnl < 0, f"Expected negative PnL for SL exit, got {pnl}"

    @pytest.mark.asyncio
    async def test_live_exit_type_uses_tp_geometry_not_net_pnl_sign(self):
        executor = _make_executor()
        executor.active_position = self._make_active_position()
        executor.exchange.fetch_positions = AsyncMock(return_value=[])
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[{
            "side": "sell",
            "price": "79600.00",
            "info": {"realizedPnl": "-1.00"},
        }])
        executor._update_trade_exit = MagicMock()

        exited, pnl = await executor._check_live_position_exit(current_price=79600.00)

        assert exited is True
        assert pnl < 0
        assert executor.notifier.send_close_alert.await_args.kwargs["type"] == "TP"

    @pytest.mark.asyncio
    async def test_live_exit_type_marks_between_levels_as_manual(self):
        executor = _make_executor()
        executor.active_position = self._make_active_position()
        executor.exchange.fetch_positions = AsyncMock(return_value=[])
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[{
            "side": "sell",
            "price": "79000.00",
            "info": {"realizedPnl": "0.50"},
        }])
        executor._update_trade_exit = MagicMock()

        exited, pnl = await executor._check_live_position_exit(current_price=79000.00)

        assert exited is True
        assert pnl > 0
        assert executor.notifier.send_close_alert.await_args.kwargs["type"] == "MANUAL"

    @pytest.mark.asyncio
    async def test_no_active_position_returns_early(self):
        """If active_position is None, poll must return (False, 0.0) immediately."""
        executor = _make_executor()
        executor.active_position = None
        executor.exchange.fetch_positions = AsyncMock()

        exited, pnl = await executor._check_live_position_exit(current_price=78000.0)

        assert exited is False
        assert pnl == 0.0
        executor.exchange.fetch_positions.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_exchange_error_returns_false_not_raises(self):
        """A fetch_positions network error must not crash the loop — returns (False, 0.0)."""
        executor = _make_executor()
        executor.active_position = self._make_active_position()

        executor.exchange.fetch_positions = AsyncMock(side_effect=Exception("timeout"))

        exited, pnl = await executor._check_live_position_exit(current_price=78000.0)

        assert exited is False
        assert pnl == 0.0
        # active_position must NOT be cleared on a poll error
        assert executor.active_position is not None


class TestFlattenAccounting:

    @pytest.mark.asyncio
    async def test_emergency_flatten_aggregates_split_close_fills(self):
        executor = _make_executor()
        entry = 62588.00
        close = 62407.90
        size = 0.005
        entry_ts = time.time() - 60
        entry_fee = entry * size * executor.TAKER_FEE
        close_fee_per_fill = close * 0.001 * executor.TAKER_FEE
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": size,
            "entry_price": entry,
            "entry_fee": entry_fee,
            "trade_doc_id": "panic_split_doc",
            "entry_ts": entry_ts,
        }
        executor.exchange.cancel_all_orders = AsyncMock()
        executor.exchange.create_market_order = AsyncMock(return_value={"id": "flatten-1"})
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[
            {
                "side": "sell",
                "amount": "0.001",
                "price": str(close),
                "timestamp": int((entry_ts + 10 + i) * 1000),
                "info": {
                    "realizedPnl": "-0.1801",
                    "commission": str(close_fee_per_fill),
                },
            }
            for i in range(5)
        ])
        executor._update_trade_exit = MagicMock()

        pnl = await executor.emergency_flatten("test split close")

        expected_gross = -0.1801 * 5
        expected_fees = entry_fee + (close_fee_per_fill * 5)
        expected_pnl = expected_gross - expected_fees
        assert pnl == pytest.approx(expected_pnl, abs=1e-6)
        executor.exchange.create_market_order.assert_awaited_once_with(
            "BTC/USDT:USDT", "sell", size, params={"reduceOnly": True}
        )
        executor.exchange.fetch_my_trades.assert_awaited_once_with("BTC/USDT:USDT", limit=50)
        executor._update_trade_exit.assert_called_once_with(
            "panic_split_doc", pytest.approx(close, abs=1e-9), pytest.approx(expected_pnl, abs=1e-6)
        )
        assert executor.active_position is None


# ---------------------------------------------------------------------------
# Minimum notional floor
# ---------------------------------------------------------------------------

class TestMinNotionalFloor:

    @pytest.mark.asyncio
    async def test_trade_skipped_when_notional_too_small(self):
        """
        A signal that would produce < $50 notional must be rejected before
        any exchange calls are made.
        """
        from bot.executor import TradingExecutor

        with patch("bot.executor.ccxt"):
            executor = TradingExecutor(
                api_key="k", api_secret="s",
                testnet=True, dry_run=False,
                exchange_id="binanceusdm",
            )

        executor.dry_run = False
        executor.active_position = None
        executor.pending_order = None
        executor.lock_expiry = 0.0
        executor.failed_order_ts = 0.0
        executor.TAKER_FEE = 0.0005
        executor.MAKER_FEE = 0.0002
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.notifier = AsyncMock()
        executor.exchange = AsyncMock()

        # get_usdt_balance returns $10 — so risk_usd = $10 × 1% = $0.10
        executor.get_usdt_balance = AsyncMock(return_value=10.0)

        signal = {
            "verdict": "BUY",
            "confidence": 0.70,
            "stop_loss": 77000.0,
            "take_profit": 80000.0,
        }

        # With $0.10 risk and a $1439 SL distance, raw_size = 0.10/1439 ≈ 0.0001 BTC
        # notional = 0.0001 × 78439 ≈ $7.84 → below $50 floor
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=78439.90,
            signal=signal,
            max_risk_pct=1.0,
            account_size=10.0,
        )

        # No market order should have been placed
        executor.exchange.create_market_order.assert_not_awaited()
        # Error alert should have been sent
        executor.notifier.send_error_alert.assert_awaited()


    @pytest.mark.asyncio
    async def test_binance_usdm_uses_fifty_dollar_min_notional(self):
        """Binance USDM rejects orders below $50 notional; block before retries."""
        from bot.executor import TradingExecutor

        with patch("bot.executor.ccxt"):
            executor = TradingExecutor(
                api_key="k", api_secret="s",
                testnet=True, dry_run=False,
                exchange_id="binanceusdm",
            )

        executor.dry_run = False
        executor.active_position = None
        executor.pending_order = None
        executor.lock_expiry = 0.0
        executor.failed_order_ts = 0.0
        executor.TAKER_FEE = 0.0005
        executor.MAKER_FEE = 0.0002
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.notifier = AsyncMock()
        executor.exchange = AsyncMock()
        executor.get_usdt_balance = AsyncMock(return_value=100.0)
        executor._portfolio_risk_multiplier = AsyncMock(return_value=1.0)
        executor.calculate_position_size = MagicMock(return_value=0.012)

        await executor.execute_signal(
            symbol="ETHUSDT",
            current_price=1650.0,
            signal={
                "verdict": "BUY",
                "confidence": 0.90,
                "stop_loss": 1600.0,
                "take_profit": 1700.0,
            },
            max_risk_pct=1.0,
            account_size=100.0,
        )

        executor.exchange.create_market_order.assert_not_awaited()
        executor.notifier.send_error_alert.assert_awaited()

    @pytest.mark.asyncio
    async def test_notional_cap_cannot_shrink_order_below_exchange_minimum(self):
        """A capped futures order must be rechecked against min notional."""
        from bot.executor import TradingExecutor

        with patch("bot.executor.ccxt"):
            executor = TradingExecutor(
                api_key="k", api_secret="s",
                testnet=True, dry_run=False,
                exchange_id="binanceusdm",
            )

        executor.dry_run = False
        executor.active_position = None
        executor.pending_order = None
        executor.lock_expiry = 0.0
        executor.failed_order_ts = 0.0
        executor.TAKER_FEE = 0.0005
        executor.MAKER_FEE = 0.0002
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.notifier = AsyncMock()
        executor.exchange = AsyncMock()
        executor.get_usdt_balance = AsyncMock(return_value=20.0)
        executor._portfolio_risk_multiplier = AsyncMock(return_value=1.0)
        executor.calculate_position_size = MagicMock(return_value=0.04)  # $66 raw at $1650

        await executor.execute_signal(
            symbol="ETHUSDT",
            current_price=1650.0,
            signal={
                "verdict": "BUY",
                "confidence": 0.90,
                "stop_loss": 1600.0,
                "take_profit": 1700.0,
            },
            max_risk_pct=1.0,
            account_size=20.0,
        )

        executor.exchange.create_market_order.assert_not_awaited()
        executor.notifier.send_error_alert.assert_awaited()


class TestLiveSafetyHardening:

    @pytest.mark.asyncio
    async def test_tp_failure_after_sl_flattens_instead_of_sl_only(self):
        """All-or-flatten: TP failure after SL placed cancels sibling and flattens."""
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.active_position = None
        executor.pending_order = None
        executor.failed_order_ts = 0.0
        executor._bracket_handled = False
        executor.get_usdt_balance = AsyncMock(return_value=10_000.0)
        executor.exchange.amount_to_precision = MagicMock(return_value="0.01")
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))
        executor.exchange.create_orders = AsyncMock(side_effect=Exception("batch failed"))
        executor.exchange.cancel_order = AsyncMock()
        executor.exchange.create_market_order = AsyncMock(return_value={
            "id": "entry-1",
            "status": "closed",
            "average": 1000.0,
        })
        executor.exchange.create_order = AsyncMock(side_effect=[
            {"id": "sl-1"},
            Exception("tp reject 1"),
            Exception("tp reject 2"),
            Exception("tp reject 3"),
        ])
        executor._log_trade = MagicMock(return_value="trade-1")

        result = await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=1000.0,
            signal={
                "verdict": "BUY",
                "confidence": 0.8,
                "stop_loss": 990.0,
                "take_profit": 1030.0,
                "atr_at_entry": 10.0,
            },
            max_risk_pct=1.0,
            account_size=10_000.0,
        )

        # TP failure → flatten. Result is None (exception caught internally).
        assert result is None
        assert executor.active_position is None
        assert executor.pending_order is None

    @pytest.mark.asyncio
    async def test_live_market_load_failure_blocks_trading(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.exchange.load_markets = AsyncMock(side_effect=Exception("network down"))

        with pytest.raises(RuntimeError, match="Live trading blocked"):
            await executor.initialize()

        executor.notifier.send_error_alert.assert_awaited()

    @pytest.mark.asyncio
    async def test_dry_run_market_load_failure_uses_fallback_markets(self):
        executor = _make_executor(dry_run=True)
        executor.dry_run = True
        executor.exchange.apiKey = "test"
        executor.exchange.markets = None
        executor.exchange.symbols = None
        executor.exchange.load_markets = AsyncMock(side_effect=Exception("network down"))

        await executor.initialize()

        assert executor.exchange.markets
        assert executor.exchange.symbols


class TestPartialProfitTaking:

    @pytest.mark.asyncio
    async def test_dry_run_partial_reduces_size_and_moves_sl_to_entry(self):
        executor = _make_executor(dry_run=True)
        executor.dry_run = True
        executor._log_partial_take = MagicMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 90.0,
            "initial_stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "partial_take_r": 0.75,
            "partial_take_pct": 0.50,
            "_partial_taken": False,
            "realized_partial_pnl": 0.0,
            "be_lock_trigger": 2.0,
            "atr_at_entry": 10.0,
            "trade_doc_id": "trade-1",
        }

        await executor.check_breakeven_and_partials(current_price=108.0, atr=10.0)

        assert executor.active_position["size"] == pytest.approx(0.5)
        assert executor.active_position["stop_loss"] == 100.0
        assert executor.active_position["_partial_taken"] is True
        assert executor.active_position["_be_locked"] is True
        assert executor.active_position["realized_partial_pnl"] > 0
        executor._log_partial_take.assert_called_once()

    @pytest.mark.asyncio
    async def test_live_futures_partial_rebuilds_reduced_sl_tp_orders(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True
        executor.exchange.amount_to_precision = MagicMock(side_effect=lambda _symbol, amount: str(round(float(amount), 6)))
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))
        executor.exchange.create_market_order = AsyncMock(return_value={"id": "partial-close"})
        executor.exchange.cancel_order = AsyncMock()
        executor.exchange.create_order = AsyncMock(side_effect=[
            {"id": "sl-reduced"},
            {"id": "tp-reduced"},
        ])
        executor._log_partial_take = MagicMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 90.0,
            "initial_stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "sl_order_id": "sl-old",
            "tp_order_id": "tp-old",
            "partial_take_r": 0.75,
            "partial_take_pct": 0.50,
            "_partial_taken": False,
            "realized_partial_pnl": 0.0,
            "be_lock_trigger": 2.0,
            "atr_at_entry": 10.0,
            "trade_doc_id": "trade-1",
        }

        await executor.check_breakeven_and_partials(current_price=108.0, atr=10.0)

        pos = executor.active_position
        assert pos["size"] == pytest.approx(0.5)
        assert pos["stop_loss"] == 100.0
        assert pos["sl_order_id"] == "sl-reduced"
        assert pos["tp_order_id"] == "tp-reduced"
        assert pos["_partial_taken"] is True
        executor.exchange.create_market_order.assert_awaited_once()
        executor.exchange.cancel_order.assert_any_await("sl-old", "BTC/USDT:USDT")
        executor.exchange.cancel_order.assert_any_await("tp-old", "BTC/USDT:USDT")
        assert executor.exchange.create_order.await_count == 2

    @pytest.mark.asyncio
    async def test_live_futures_partial_flattens_when_replacement_sl_rejected(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True
        executor.exchange.amount_to_precision = MagicMock(side_effect=lambda _symbol, amount: str(round(float(amount), 6)))
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))
        executor.exchange.create_market_order = AsyncMock(return_value={"id": "partial-close"})
        executor.exchange.create_order = AsyncMock(side_effect=Exception("Order would immediately trigger"))
        executor.exchange.cancel_all_orders = AsyncMock()
        executor.exchange.fetch_my_trades = AsyncMock(return_value=[])
        executor._log_partial_take = MagicMock()
        executor._update_trade_exit = MagicMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "entry_fee": 0.05,
            "stop_loss": 90.0,
            "initial_stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "partial_take_r": 0.75,
            "partial_take_pct": 0.50,
            "_partial_taken": False,
            "realized_partial_pnl": 0.0,
            "be_lock_trigger": 2.0,
            "atr_at_entry": 10.0,
            "trade_doc_id": "trade-1",
            "regime": "RANGE",
        }

        await executor.check_breakeven_and_partials(current_price=108.0, atr=10.0)

        assert executor.active_position is None
        assert executor.exchange.create_market_order.await_count == 2
        assert executor._pending_forced_exit["reason"] == "partial_protection_rebuild_failed"
        assert executor._pending_forced_exit["position"]["size"] == pytest.approx(0.5)

    def test_effective_reward_risk_uses_live_entry_price(self):
        executor = _make_executor(dry_run=False)

        rr = executor._effective_reward_risk(
            side="buy",
            entry_price=65.01,
            stop_loss=64.63,
            take_profit=65.47,
        )

        assert rr == pytest.approx(1.21, rel=0.02)

    @pytest.mark.asyncio
    async def test_live_futures_partial_remaining_uses_rounded_close_size(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True

        def truncate_3dp(_symbol, amount):
            return f"{int(float(amount) * 1000) / 1000:.3f}"

        executor.exchange.amount_to_precision = MagicMock(side_effect=truncate_3dp)
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))
        executor.exchange.create_market_order = AsyncMock(return_value={"id": "partial-close"})
        executor.exchange.cancel_order = AsyncMock()
        executor.exchange.create_order = AsyncMock(side_effect=[
            {"id": "sl-reduced"},
            {"id": "tp-reduced"},
        ])
        executor._log_partial_take = MagicMock()
        executor.active_position = {
            "symbol": "ETH/USDT:USDT",
            "side": "sell",
            "size": 0.049,
            "entry_price": 1640.20,
            "stop_loss": 1655.60,
            "initial_stop_loss": 1655.60,
            "initial_risk_dist": 15.40,
            "take_profit": 1602.92,
            "sl_order_id": "sl-old",
            "tp_order_id": "tp-old",
            "partial_take_r": 0.33,
            "partial_take_pct": 0.40,
            "_partial_taken": False,
            "realized_partial_pnl": 0.0,
            "be_lock_trigger": 2.0,
            "atr_at_entry": 7.90,
            "trade_doc_id": "trade-eth",
        }

        await executor.check_breakeven_and_partials(current_price=1633.30, atr=7.90)

        pos = executor.active_position
        assert executor.exchange.create_market_order.await_args.args[2] == pytest.approx(0.019)
        assert pos["size"] == pytest.approx(0.030)
        assert executor.exchange.create_order.await_args_list[0].kwargs["amount"] == pytest.approx(0.030)


class TestTimeExitBleedGuard:

    @pytest.mark.asyncio
    async def test_time_exit_defers_tiny_positive_net_pnl(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.emergency_flatten = AsyncMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "time_exit_sec": 60,
            "entry_ts": time.time() - 61,
            "realized_partial_pnl": 0.0,
        }

        exited, pnl = await executor.check_time_exit(current_price=100.5)

        assert exited is False
        assert pnl == 0.0
        assert executor.active_position["_time_exit_deferred_logged"] is True
        executor.emergency_flatten.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_time_exit_defers_profit_below_fee_slippage_buffer(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.emergency_flatten = AsyncMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 99.5,
            "initial_risk_dist": 0.5,
            "take_profit": 101.5,
            "time_exit_sec": 60,
            "entry_ts": time.time() - 61,
            "realized_partial_pnl": 0.0,
        }

        exited, pnl = await executor.check_time_exit(current_price=100.25)

        assert exited is False
        assert pnl == 0.0
        assert executor.active_position["_time_exit_deferred_logged"] is True
        executor.emergency_flatten.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_hard_time_exit_defers_small_fee_negative_drift(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.emergency_flatten = AsyncMock()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "time_exit_sec": 60,
            "entry_ts": time.time() - 121,
            "realized_partial_pnl": 0.0,
        }

        exited, pnl = await executor.check_time_exit(current_price=99.0)

        assert exited is False
        assert pnl == 0.0
        assert executor.active_position["_hard_time_exit_deferred_logged"] is True
        executor.emergency_flatten.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_volatile_time_exit_uses_explicit_hard_cap(self):
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.emergency_flatten = AsyncMock(return_value=-1.25)
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 90.0,
            "initial_risk_dist": 10.0,
            "take_profit": 130.0,
            "time_exit_sec": 60,
            "time_exit_hard_cap_s": 60,
            "regime": "VOLATILE",
            "entry_ts": time.time() - 61,
            "realized_partial_pnl": 0.0,
        }

        exited, pnl = await executor.check_time_exit(current_price=99.0)

        assert exited is True
        assert pnl == -1.25
        executor.emergency_flatten.assert_awaited_once_with("Regime time exit")


class TestRiskSizing:

    def test_kelly_never_exceeds_configured_risk_ceiling(self):
        executor = _make_executor(dry_run=False)

        assert executor._kelly_scale(0.80, 2.5) <= 1.0

    def test_position_size_includes_stop_distance_and_fee_buffer(self):
        executor = _make_executor(dry_run=False)
        executor.TAKER_FEE = 0.0005

        size = executor.calculate_position_size(
            current_price=100.0,
            stop_loss=90.0,
            equity=1000.0,
            max_risk_pct=1.0,
            atr_pct=0.01,
            atr_pct_rank=0.5,
            adaptive_mult=1.0,
        )

        # Gross risk-only size would be 1.0. Fee-aware sizing should be smaller.
        assert size == pytest.approx(10.0 / (10.0 + 0.095))


# ── Phase 0 / A1: Regression test for TP requeue on open positions ────────────

class TestTpRequeueOnOpenPosition:
    """A1 FIX: TP requeue must be called while position is open, not only on exit."""

    @pytest.mark.asyncio
    async def test_attempt_tp_requeue_returns_false_when_no_pending_requeue(self):
        """attempt_tp_requeue should return False when requeue_tp_attempts is 0."""
        executor = _make_executor()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 0.001,
            "requeue_tp_attempts": 0,  # No pending requeue
        }
        result = await executor.attempt_tp_requeue()
        assert result is False

    @pytest.mark.asyncio
    async def test_attempt_tp_requeue_returns_false_when_no_active_position(self):
        """attempt_tp_requeue should return False when active_position is None."""
        executor = _make_executor()
        executor.active_position = None
        result = await executor.attempt_tp_requeue()
        assert result is False

    @pytest.mark.asyncio
    async def test_attempt_tp_requeue_success_updates_bracket_status(self):
        """A1/D2 FIX: Successful TP requeue should set bracket_status to BRACKETED."""
        executor = _make_executor()
        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 0.001,
            "requeue_tp_attempts": 1,
            "requeue_tp_side": "sell",
            "requeue_tp_size": 0.001,
            "requeue_tp_price": 1030.0,
            "requeue_tp_symbol": "BTC/USDT:USDT",
            "bracket_status": "SL_ONLY",
            "bracket_missing_leg": "TP",
        }
        executor.exchange.create_order = AsyncMock(return_value={"id": "tp-requeue-1"})

        result = await executor.attempt_tp_requeue()

        assert result is True
        assert executor.active_position["bracket_status"] == "BRACKETED"
        assert executor.active_position["bracket_missing_leg"] is None
        assert executor.active_position["tp_order_id"] == "tp-requeue-1"
        assert "requeue_tp_attempts" not in executor.active_position


# ── Phase 0 / D2: Bracket status tracking ─────────────────────────────────────

    @pytest.mark.asyncio
    async def test_position_enters_with_bracket_status_on_successful_tp(self):
        """D2 FIX: Position entered with TP should have bracket_status=BRACKETED."""
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.active_position = None
        executor.pending_order = None
        executor.failed_order_ts = 0.0
        executor._bracket_handled = False
        executor.get_usdt_balance = AsyncMock(return_value=10_000.0)
        executor.exchange.amount_to_precision = MagicMock(return_value="0.01")
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))
        executor.exchange.create_market_order = AsyncMock(return_value={
            "id": "entry-1",
            "status": "closed",
            "average": 1000.0,
        })
        # Batch fails → fall back to individual, both succeed
        executor.exchange.create_orders = AsyncMock(side_effect=Exception("batch unsupported"))
        executor.exchange.create_order = AsyncMock(side_effect=[
            {"id": "sl-1"},
            {"id": "tp-1"},
        ])
        executor._log_trade = MagicMock(return_value="trade-1")

        result = await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=1000.0,
            signal={
                "verdict": "BUY",
                "confidence": 0.8,
                "stop_loss": 990.0,
                "take_profit": 1030.0,
                "atr_at_entry": 10.0,
            },
            max_risk_pct=1.0,
            account_size=10_000.0,
        )

        assert result is True
        assert executor.active_position["bracket_status"] == "BRACKETED"
        assert executor.active_position["bracket_missing_leg"] is None
        assert executor.active_position["sl_order_id"] == "sl-1"
        assert executor.active_position["tp_order_id"] == "tp-1"

    @pytest.mark.asyncio
    async def test_bracket_leg_failure_handles_internally(self):
        """All-or-flatten: bracket leg failure cancels sibling, flattens, and does not crash."""
        executor = _make_executor(dry_run=False)
        executor.dry_run = False
        executor.is_futures = True
        executor.exchange_id = "binanceusdm"
        executor.active_position = None
        executor.pending_order = None
        executor.failed_order_ts = 0.0
        executor._bracket_handled = False
        executor.get_usdt_balance = AsyncMock(return_value=10_000.0)
        executor.exchange.amount_to_precision = MagicMock(return_value="0.01")
        executor.exchange.price_to_precision = MagicMock(side_effect=lambda _symbol, price: str(price))

        executor.exchange.create_orders = AsyncMock(side_effect=Exception("batch failed"))
        executor.exchange.create_market_order = AsyncMock(return_value={
            "id": "entry-1",
            "status": "closed",
            "average": 1000.0,
        })

        call_count = {"sl": 0}
        async def create_order_side_effect(**kwargs):
            if kwargs.get("type") == "STOP":
                call_count["sl"] += 1
                if call_count["sl"] == 1:
                    return {"id": "sl-1"}
            raise Exception("order rejected")

        executor.exchange.cancel_order = AsyncMock()
        executor.exchange.create_order = AsyncMock(side_effect=create_order_side_effect)
        executor._log_trade = MagicMock(return_value="trade-1")

        result = await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=1000.0,
            signal={
                "verdict": "BUY",
                "confidence": 0.8,
                "stop_loss": 990.0,
                "take_profit": 1030.0,
                "atr_at_entry": 10.0,
            },
            max_risk_pct=1.0,
            account_size=10_000.0,
        )

        # RuntimeError is caught internally, function returns None
        assert result is None
        assert executor.exchange.cancel_order.called
        # Entry + emergency flatten with reduceOnly
        assert executor.exchange.create_market_order.call_count >= 2
        assert executor.active_position is None
