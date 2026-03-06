import os
import asyncio
from dotenv import load_dotenv

# Test google.generativeai (used in backend)
async def test_generativeai():
    print("Testing google.generativeai (backend)...")
    try:
        import google.generativeai as genai_old
        load_dotenv("backend/.env")
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print("No API key found in backend/.env")
            return
        genai_old.configure(api_key=api_key)
        model = genai_old.GenerativeModel("gemini-2.0-flash")
        response = await model.generate_content_async("Hello")
        print("google.generativeai test SUCCESS:", response.text)
    except Exception as e:
        print("google.generativeai test FAILED:", repr(e))

# Test google.genai (used in bot)
def test_genai():
    print("\nTesting google.genai (bot)...")
    try:
        from google import genai
        load_dotenv(".env")
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print("No API key found in .env")
            return
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents="Hello"
        )
        print("google.genai test SUCCESS:", response.text)
    except Exception as e:
        print("google.genai test FAILED:", repr(e))

if __name__ == "__main__":
    asyncio.run(test_generativeai())
    test_genai()
