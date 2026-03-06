import httpx
import asyncio
import os
from dotenv import load_dotenv

load_dotenv(".env")

async def test_whale_alert():
    WHALE_ALERT_API_KEY = os.getenv("WHALE_ALERT_API_KEY")
    if not WHALE_ALERT_API_KEY:
        print("WHALE_ALERT_API_KEY not found in backend/.env")
        return

    print("Testing Whale Alert API with valid parameters...")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.whale-alert.io/v1/transactions",
                params={
                    "api_key": WHALE_ALERT_API_KEY,
                    "limit": 5,
                    "start": int(__import__('time').time()) - 3600,
                    "min_value": 10000000,
                    "currency": "btc",  # FIXED from "bitcoin"
                },
            )
            print("Status Code:", resp.status_code)
            if resp.status_code == 200:
                data = resp.json()
                print("Success! Transactions found:", len(data.get("transactions", [])))
            else:
                print("Error Details:", resp.text)
    except Exception as e:
        print("API Request Failed:", str(e))

if __name__ == "__main__":
    asyncio.run(test_whale_alert())
