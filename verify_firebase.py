import json
import logging
from typing import Optional, Any

# Set up logging to match the bot's style
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("FirebaseVerifier")

def _normalize_pem(raw_key: str) -> str:
    if not raw_key: return ""
    key = str(raw_key).replace("\\\\n", "\n").replace("\\n", "\n")
    key = key.replace("\\r\\n", "\n").replace("\r\n", "\n").strip()
    key = key.strip('"').strip("'")
    
    lines = [l.strip() for l in key.splitlines() if l.strip()]
    if not lines: return ""

    header, footer = "", ""
    body_parts = []
    
    for l in lines:
        if "BEGIN" in l: 
            header = l
        elif "END" in l: 
            footer = l
        else:
            clean_part = "".join([c for c in l if c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="])
            if clean_part:
                body_parts.append(clean_part)

    if not header or not footer:
        return key

    full_body = "".join(body_parts).rstrip("=")
    remainder = len(full_body) % 4
    if remainder == 2: full_body += "=="
    elif remainder == 3: full_body += "="
    elif remainder == 1: full_body += "==="

    wrapped_body = [full_body[i:i+64] for i in range(0, len(full_body), 64)]
    return "\n".join([header] + wrapped_body + [footer])

def test_key(json_content: str):
    print("\n" + "="*50)
    print("   FIREBASE KEY DIAGNOSTIC TOOL")
    print("="*50)
    
    try:
        # 1. JSON Check
        cred_dict = json.loads(json_content)
        print("✅ [OK] JSON is structurally valid.")
        
        # 2. Key Presence
        if "private_key" not in cred_dict:
            print("❌ [FAIL] 'private_key' field is missing from the JSON.")
            return

        raw_pk = cred_dict["private_key"]
        print(f"ℹ️  Raw Private Key length: {len(raw_pk)} characters.")
        
        # 3. Normalization
        normalized_pk = _normalize_pem(raw_pk)
        print(f"ℹ️  Normalized Key length: {len(normalized_pk)} characters.")
        
        # 4. Length Heuristic
        # A standard 2048-bit RSA key is ~1670+ characters
        if len(normalized_pk) < 1500:
            print(f"⚠️  [WARNING] The key looks TRUNCATED ({len(normalized_pk)} chars).")
            print("   Expected ~1670+ characters. The end of the file was likely missed during copy-paste.")

        # 5. Cryptographic Parsing
        try:
            from firebase_admin import credentials, initialize_app, _apps
            cred_dict["private_key"] = normalized_pk
            cred = credentials.Certificate(cred_dict)
            
            # Initialize temp app
            if not _apps:
                initialize_app(cred)
            
            print("✅ [OK] Firebase SDK accepted the key (ASN.1 structure is valid).")
            print("\n🔥 SUCCESS! This JSON is safe to use in Railway.")
            
        except ImportError:
            print("⚠️  [NOTICE] 'firebase-admin' not installed locally. Skipping SDK-level validation.")
            print("   However, the JSON and structural checks completed.")
        except Exception as e:
            print(f"❌ [FAIL] Firebase SDK rejected the key: {e}")
            if "ASN.1" in str(e):
                print("\n💡 SOLUTION: This is the 'short data' error. Your key is definitely incomplete.")
                print("   Go back to the Firebase Console and download the .json file again.")
            elif "InvalidPadding" in str(e):
                print("\n💡 SOLUTION: The base64 encoding is broken. Ensure you copied the full key.")
            
    except json.JSONDecodeError as e:
        print(f"❌ [FAIL] Content is NOT valid JSON: {e}")
        print("   Make sure you included the opening { and closing } in your paste.")
    except Exception as e:
        print(f"❌ [ERROR] An unexpected error occurred: {e}")

if __name__ == "__main__":
    # --- PASTE YOUR JSON INSIDE THE TRIPLE QUOTES BELOW ---
    if TEST_JSON.strip() == "PASTE_YOUR_JSON_HERE":
        print("\n[!] Please edit this file and paste your Firebase JSON into the TEST_JSON variable.")
        print("    Then run: python verify_firebase.py")
    else:
        test_key(TEST_JSON)
