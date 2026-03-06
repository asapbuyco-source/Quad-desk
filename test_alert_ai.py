import asyncio
import httpx

async def test_alert():
    url = "http://localhost:8000/alerts/evaluate"
    payload = {
        "symbol": "BTCUSDT",
        "price": 95000,
        "zScore": 2.6,
        "tacticalProbability": 0.8,
        "aiScore": 0.85,
        "model": "gemini-2.5-pro" # Testing non-default model parameter 
    }
    
    try:
        async with httpx.AsyncClient() as client:
            print(f"Sending request to {url} with model {payload['model']}...")
            response = await client.post(url, json=payload, timeout=15.0)
            print(f"Status Code: {response.status_code}")
            print(f"Response: {response.json()}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_alert())
