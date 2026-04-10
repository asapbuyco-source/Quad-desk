"""
Ed25519 Key Generator for Binance Futures API
==============================================
Run this ONCE locally. It will:
  1. Generate an Ed25519 public/private key pair
  2. Print the public key  -> paste into Binance API Management
  3. Print the private key -> add to your .env and Railway variables

Run with:
    python generate_ed25519_key.py
"""

import sys
import base64

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
except ImportError:
    print("[ERROR] 'cryptography' package not installed.")
    print("Run:  pip install cryptography")
    sys.exit(1)

# ── Generate ──────────────────────────────────────────────────────────
private_key = Ed25519PrivateKey.generate()

private_pem = private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")

public_pem = private_key.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode("utf-8")

# Also produce the raw base64 public key (Binance accepts both PEM and raw)
raw_pub_bytes = private_key.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
raw_pub_b64 = base64.b64encode(raw_pub_bytes).decode("utf-8")

# ── Display ───────────────────────────────────────────────────────────
SEP = "=" * 60

print(f"\n{SEP}")
print("  STEP 1 — Paste this PUBLIC KEY into Binance")
print(f"{SEP}")
print("Go to: binance.com -> Profile -> API Management")
print("       -> Create API -> Self-Generated (Ed25519)")
print("       -> Paste the key below into the 'Public Key' box")
print("       -> Enable: [x] Enable Reading  [x] Enable Futures")
print("       -> NO IP restriction needed with Ed25519")
print()
print(public_pem)
print(f"(Raw base64 version, same key): {raw_pub_b64}")

print(f"\n{SEP}")
print("  STEP 2 — Copy the API KEY ID that Binance gives you")
print(f"{SEP}")
print("After pasting the public key, Binance will show you an API Key ID")
print("(looks like: a1b2c3d4e5f6...)")
print("Add it to your .env and Railway variables as:")
print()
print("  BINANCE_API_KEY=<the key ID Binance shows you>")

print(f"\n{SEP}")
print("  STEP 3 — Add this PRIVATE KEY to .env and Railway")
print(f"{SEP}")
print("Add EXACTLY this line to your .env file")
print("(the private key as a single-line escaped string):")
print()
# Produce the single-line version safe for .env files
oneliner = private_pem.replace("\n", "\\n")
print(f'BINANCE_ED25519_PRIVATE_KEY="{oneliner}"')
print()
print("Also add BINANCE_ED25519_PRIVATE_KEY to your Railway service variables.")
print("In Railway, paste the raw PEM (with real newlines) into the variable value.")
print("Railway's UI handles multiline values — just paste the block below:")
print()
print(private_pem)

print(f"\n{SEP}")
print("  IMPORTANT — Security Rules")
print(f"{SEP}")
print("  - NEVER commit the private key to git")
print("  - NEVER share the private key with anyone")
print("  - The public key is safe to share (that's its purpose)")
print("  - Delete this script after you've saved both keys")
print(f"{SEP}\n")
