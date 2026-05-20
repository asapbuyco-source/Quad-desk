import os
path = r'C:\Users\pc\Desktop\projects\Quad-desk\bot\executor.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old_func = '''    async def move_sl_to_breakeven(self, symbol: str, entry_price: float):
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
            logger.error(f"[Executor] Failed to move SL to breakeven: {e}")'''

new_func = '''    async def move_sl_to_breakeven(self, symbol: str, entry_price: float):
        """Moves the current Stop Loss to the entry price (Breakeven)."""
        if self._dry_run:
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
                    
        except Exception as e:
            # If Phase 1 fails, Phase 2 never runs. The original Stop Loss remains active.
            # Your capital is still fully protected.
            logger.error(f"[Executor] CRITICAL: Failed to move SL to breakeven on Live Exchange: {e}")'''

if old_func in content:
    content = content.replace(old_func, new_func)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("SUCCESS: Executor updated to hyper-safe order logic.")
else:
    print("FAILED: Old function not found exactly.")
