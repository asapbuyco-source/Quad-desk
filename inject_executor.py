import os

path = r'C:\Users\pc\Desktop\projects\Quad-desk\bot\executor.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

injection = '''
    async def move_sl_to_breakeven(self, symbol: str, entry_price: float):
        """Moves the current Stop Loss to the entry price (Breakeven)."""
        if self._dry_run:
            logger.info("[Executor] DRY-RUN: Simulated moving SL to breakeven.")
            return

        logger.info(f"[Executor] Moving Stop Loss to Breakeven @ {entry_price:.2f}")
        try:
            open_orders = await self.exchange.fetch_open_orders(symbol)
            for order in open_orders:
                if order.get("type", "").lower() in ("stop", "stop_market", "stopmarket"):
                    await self.exchange.cancel_order(order["id"], symbol)
                    logger.debug(f"[Executor] Cancelled old SL order {order['id']}")
            
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
                logger.info("[Executor] New Breakeven SL placed successfully on exchange.")
        except Exception as e:
            logger.error(f"[Executor] Failed to move SL to breakeven: {e}")

    async def check_position_exit('''

if "async def check_position_exit(" in content:
    content = content.replace("    async def check_position_exit(", injection)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Injected move_sl_to_breakeven into executor.py")
else:
    print("Could not find check_position_exit anchor.")
