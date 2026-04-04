import asyncio
import os
from dotenv import load_dotenv
from bot.notifier import TelegramNotifier

async def test_notifier():
    load_dotenv()
    
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    
    print(f"Testing Telegram with Token: {token[:5]}... [{len(token) if token else 0} chars]")
    print(f"Chat ID: {chat_id}")
    
    if not token or not chat_id:
        print("❌ Error: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found in .env")
        return

    notifier = TelegramNotifier(token, chat_id)
    
    print("\n1. Sending Success Alert (Entry)...")
    await notifier.send_trade_alert(
        symbol="BTC-USDC", 
        side="buy", 
        price=67500.50, 
        size=0.0015, 
        sl=66800.0, 
        tp=69000.0, 
        is_dry=True
    )
    
    print("2. Sending Error Alert (Insufficient Funds)...")
    await notifier.send_error_alert("Insufficient USDC ($1.20) to open LONG. Min $5 required.")
    
    print("\n✅ Verification scripts finished. Check your Telegram!")

if __name__ == "__main__":
    asyncio.run(test_notifier())
