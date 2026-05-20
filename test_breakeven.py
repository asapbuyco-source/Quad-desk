import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

# Create a mock for the executor
class MockExecutor:
    def __init__(self):
        self._dry_run = False
        self.exchange = MagicMock()
        self.exchange.fetch_open_orders = AsyncMock()
        self.exchange.cancel_order = AsyncMock()
        self.exchange.create_order = AsyncMock()
        self.exchange.amount_to_precision = MagicMock(side_effect=lambda sym, amt: float(amt))
        self.exchange.price_to_precision = MagicMock(side_effect=lambda sym, price: float(price))
        self.active_position = {"side": "buy", "size": 1.5}
        
    async def move_sl_to_breakeven(self, symbol: str, entry_price: float):
        if self._dry_run:
            return

        try:
            open_orders = await self.exchange.fetch_open_orders(symbol)
            for order in open_orders:
                if order.get("type", "").lower() in ("stop", "stop_market", "stopmarket"):
                    await self.exchange.cancel_order(order["id"], symbol)
            
            if self.active_position:
                fmt_size = self.exchange.amount_to_precision(symbol, self.active_position["size"])
                close_side = "sell" if self.active_position["side"] == "buy" else "buy"
                await self.exchange.create_order(
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
        except Exception as e:
            print(f"Error: {e}")

class TestBreakeven(unittest.IsolatedAsyncioTestCase):
    async def test_breakeven(self):
        executor = MockExecutor()
        
        # Setup mock orders
        executor.exchange.fetch_open_orders.return_value = [
            {"id": "123", "type": "stop_market"},
            {"id": "456", "type": "limit"}
        ]
        
        await executor.move_sl_to_breakeven("BTC/USDT", 65000.0)
        
        # Verify cancel order was called only on the stop_market
        executor.exchange.cancel_order.assert_called_once_with("123", "BTC/USDT")
        
        # Verify new order was created correctly
        executor.exchange.create_order.assert_called_once_with(
            "BTC/USDT",
            "STOP_MARKET",
            "sell",  # Since active position is 'buy'
            1.5,
            None,
            params={"stopPrice": 65000.0, "reduceOnly": True}
        )

if __name__ == '__main__':
    unittest.main()
