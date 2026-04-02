import os
from dotenv import load_dotenv
load_dotenv()
key = os.getenv("COINBASE_PRIVATE_KEY", "")
print("Key length:", len(key))
print("Key starts with:", key[:30])
print("Contains real newlines?", "\n" in key)
print("Contains literal backslash-n?", "\\n" in key)
