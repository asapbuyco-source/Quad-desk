import os
from dotenv import load_dotenv


def _run_genai_smoke(env_path: str, label: str):
    from google import genai

    print(f"Testing google.genai ({label})...")
    load_dotenv(env_path)
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print(f"No API key found in {env_path}")
        return

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Hello",
    )
    print(f"google.genai {label} test SUCCESS:", response.text)


def test_backend_genai():
    try:
        _run_genai_smoke("backend/.env", "backend")
    except Exception as e:
        print("google.genai backend test FAILED:", repr(e))


def test_bot_genai():
    try:
        _run_genai_smoke(".env", "bot")
    except Exception as e:
        print("google.genai bot test FAILED:", repr(e))

if __name__ == "__main__":
    test_backend_genai()
    test_bot_genai()
