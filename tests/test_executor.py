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
        assert abs(pnl - (-0.60)) < 0.01, f"PnL should be ~-0.60, got {pnl}"
        executor.notifier.send_close_alert.assert_awaited_once()
        executor._update_trade_exit.assert_called_once_with(
            "test_doc_123", 77841.10, -0.60
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
