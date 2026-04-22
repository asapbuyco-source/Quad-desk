import logging
import httpx
import asyncio
from typing import Optional

logger = logging.getLogger(__name__)

class TelegramNotifier:
    """
    Handle sending trade alerts and error notifications to Telegram.
    """
    def __init__(self, token: Optional[str], chat_id: Optional[str]):
        self.token = token
        self.chat_id = chat_id
        self.base_url = f"https://api.telegram.org/bot{token}/sendMessage" if token else None

    @property
    def is_active(self) -> bool:
        return bool(self.token and self.chat_id)

    async def send_message(self, text: str):
        if not self.is_active:
            return

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                payload = {
                    "chat_id": self.chat_id,
                    "text": text,
                    "parse_mode": "HTML"
                }
                resp = await client.post(self.base_url, json=payload)
                resp.raise_for_status()
        except Exception as e:
            logger.error(f"[Telegram] Failed to send message: {e}")

    async def send_trade_alert(self, symbol: str, side: str, price: float, size: float, sl: float, tp: float, is_dry: bool = False):
        """Send a beautiful trade entry alert."""
        mode_str = "🧪 [DRY-RUN]" if is_dry else "🚀 [LIVE-TRADE]"
        emoji = "📈" if side.lower() == "buy" else "📉"
        
        msg = (
            f"<b>{mode_str} ENTRY</b>\n"
            f"━━━━━━━━━━━━━━━\n"
            f"{emoji} <b>{side.upper()} {symbol}</b>\n"
            f"💰 Price: <code>{price:.2f}</code>\n"
            f"📦 Size: <code>{size:.6f}</code>\n"
            f"🛑 SL: <code>{sl:.2f}</code>\n"
            f"🎯 TP: <code>{tp:.2f}</code>\n"
            f"━━━━━━━━━━━━━━━"
        )
        await self.send_message(msg)

    async def send_startup_alert(
        self,
        symbol: str,
        exchange: str,
        mode: str,
        leverage: int,
        interval: str,
        version: str = "v7",
    ):
        """Send a startup notification when the bot comes online."""
        mode_emoji = "🧪" if mode == "DRY-RUN" else "🚀"
        msg = (
            f"<b>{mode_emoji} QUAD-DESK BOT ONLINE</b>\n"
            f"━━━━━━━━━━━━━━━\n"
            f"📡 <b>Exchange:</b> <code>{exchange.upper()}</code>\n"
            f"💹 <b>Symbol:</b>   <code>{symbol}</code>\n"
            f"⚡ <b>Leverage:</b> <code>{leverage}×</code>\n"
            f"⏱ <b>Interval:</b> <code>{interval}</code>\n"
            f"🤖 <b>Mode:</b>     <code>{mode}</code>\n"
            f"🔧 <b>Engine:</b>   <code>7-Stage Hybrid {version}</code>\n"
            f"━━━━━━━━━━━━━━━\n"
            f"<i>Bot is live and scanning markets.</i>"
        )
        await self.send_message(msg)

    async def send_error_alert(self, error_msg: str):
        """Send an urgent error notification."""
        msg = f"⚠️ <b>BOT ERROR</b>\n━━━━━━━━━━━━━━━\n<code>{error_msg}</code>"
        await self.send_message(msg)

    async def send_close_alert(self, symbol: str, side: str, price: float, type: str, pnl: float, is_dry: bool = False):
        """Send a beautiful trade exit summary alert."""
        mode_str = "🧪 [DRY-RUN]" if is_dry else "🚀 [LIVE-TRADE]"
        emoji = "🔴" if type == "SL" else "🟢"
        result = "PROFIT" if pnl >= 0 else "LOSS"
        
        msg = (
            f"<b>{mode_str} CLOSE</b>\n"
            f"━━━━━━━━━━━━━━━\n"
            f"{emoji} <b>{type} HIT: {side.upper()} {symbol}</b>\n"
            f"🔚 Exit Price: <code>{price:.2f}</code>\n"
            f"💵 {result}: <code>${pnl:.2f}</code>\n"
            f"━━━━━━━━━━━━━━━"
        )
        await self.send_message(msg)
