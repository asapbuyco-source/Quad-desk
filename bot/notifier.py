import logging
import httpx
import asyncio
import html
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

class TelegramNotifier:
    """
    Handle sending trade alerts and error notifications to Telegram.

    H1 FIX: Persistent httpx.AsyncClient reused across all requests.
    """
    def __init__(self, token: Optional[str], chat_id: Optional[str]):
        self.token = token
        self.chat_id = chat_id
        self.base_url = f"https://api.telegram.org/bot{token}/sendMessage" if token else None
        self.document_url = f"https://api.telegram.org/bot{token}/sendDocument" if token else None
        self._client: httpx.AsyncClient = None  # H1: lazy-initialized persistent client
        self._last_errors = {}  # Deduplication cache for errors

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=10.0, limits=httpx.Limits(max_keepalive_connections=3))
        return self._client

    async def close(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def is_active(self) -> bool:
        return bool(self.token and self.chat_id)

    async def send_message(self, text: str, critical: bool = False):
        if not self.is_active:
            return
        for attempt in range(2 if critical else 1):
            try:
                client = await self._get_client()
                payload = {"chat_id": self.chat_id, "text": text, "parse_mode": "HTML"}
                resp = await client.post(self.base_url, json=payload)
                resp.raise_for_status()
                return
            except Exception as e:
                logger.error(f"[Telegram] Failed to send message (attempt {attempt+1}): {e}")
                if critical and attempt == 0:
                    await asyncio.sleep(2.0)

    async def send_document(self, file_path: str, caption: str = "", critical: bool = False):
        """Send a local file to Telegram as a document attachment."""
        if not self.is_active:
            return

        path = Path(file_path)
        if not path.exists() or not path.is_file():
            logger.warning(f"[Telegram] Document not found: {path}")
            return

        for attempt in range(2 if critical else 1):
            try:
                client = await self._get_client()
                data = {"chat_id": self.chat_id}
                if caption:
                    data["caption"] = caption[:1024]
                with path.open("rb") as fh:
                    files = {"document": (path.name, fh, "text/plain")}
                    resp = await client.post(self.document_url, data=data, files=files, timeout=60.0)
                resp.raise_for_status()
                return
            except Exception as e:
                logger.error(f"[Telegram] Failed to send document (attempt {attempt+1}): {e}")
                if critical and attempt == 0:
                    await asyncio.sleep(2.0)

    async def send_trade_alert(self, symbol: str, side: str, price: float, size: float, sl: float, tp: float, is_dry: bool = False):
        """Send a beautiful, compact trade entry alert."""
        mode_str = "🧪 DRY" if is_dry else "🚀 LIVE"
        emoji = "📈 LONG" if side.lower() == "buy" else "📉 SHORT"
        
        # Calculate Risk and Reward
        risk = abs(price - sl)
        reward = abs(tp - price)
        rr = reward / risk if risk > 0 else 0.0
        notional = price * size
        
        msg = (
            f"<b>{mode_str} | {emoji} {symbol}</b>\n"
            f"💰 Entry: <code>{price:.4f}</code> | Vol: <code>${notional:.0f}</code>\n"
            f"🛑 SL: <code>{sl:.4f}</code>\n"
            f"🎯 TP: <code>{tp:.4f}</code> (RR: {rr:.1f}x)"
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
            f"📡 <code>{exchange.upper()}</code> | 💹 <code>{symbol}</code>\n"
            f"⚡ {leverage}× | ⏱ {interval} | 🔧 {version}\n"
            f"<i>Bot is live and scanning markets.</i>"
        )
        await self.send_message(msg)

    async def send_error_alert(self, error_msg: str):
        """Send an urgent error notification with rate-limiting."""
        import time
        now = time.time()
        
        # Simple deduplication: don't spam the exact same error within 5 minutes
        if error_msg in self._last_errors:
            if now - self._last_errors[error_msg] < 300:
                return  # Skip spam
        
        self._last_errors[error_msg] = now
        
        # Cleanup old errors to prevent memory leak
        self._last_errors = {k: v for k, v in self._last_errors.items() if now - v < 300}

        error_msg_esc = html.escape(str(error_msg), quote=False)
        msg = f"⚠️ <b>BOT ERROR</b>\n<code>{error_msg_esc}</code>"
        await self.send_message(msg)

    async def send_close_alert(self, symbol: str, side: str, price: float, type: str, pnl: float, is_dry: bool = False):
        """Send a beautiful, compact trade exit summary alert."""
        mode_str = "🧪 DRY" if is_dry else "🚀 LIVE"
        emoji = "🔴" if type == "SL" else ("🔵" if type == "BE" else "🟢")
        result = "PROFIT" if pnl >= 0 else "LOSS"
        
        msg = (
            f"<b>{mode_str} | {emoji} {type} HIT</b>\n"
            f"📊 <b>{side.upper()} {symbol}</b>\n"
            f"🔚 Exit: <code>{price:.4f}</code>\n"
            f"💵 {result}: <code>${pnl:.2f}</code>"
        )
        await self.send_message(msg)
