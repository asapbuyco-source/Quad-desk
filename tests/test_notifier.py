from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_error_alert_escapes_html_body():
    from bot.notifier import TelegramNotifier

    notifier = TelegramNotifier(token="token", chat_id="chat")
    notifier.send_message = AsyncMock()

    await notifier.send_error_alert("Notional=$19.80 < min $20.50 & retry failed")

    sent = notifier.send_message.await_args.args[0]
    assert "Notional=$19.80 &lt; min $20.50 &amp; retry failed" in sent
    assert "<code>" in sent
