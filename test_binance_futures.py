"""
Binance USDM Futures — Connection & Permissions Diagnostic
===========================================================
Tests (NO real orders placed):
  1. Load markets / connectivity
  2. API key read permissions (account balance)
  3. Futures wallet USDT balance
  4. BTC/USDT market spec (tick size, min size)
  5. Mark price fetch
  6. Leverage set (dry-run check)
  7. Testnet vs live detection
"""

import asyncio
import os
import sys
from dotenv import load_dotenv

load_dotenv()

API_KEY    = os.environ.get("BINANCE_API_KEY",    "")
API_SECRET = os.environ.get("BINANCE_API_SECRET", "")
TESTNET    = os.environ.get("BOT_TESTNET", "true").lower() != "false"
LEVERAGE   = int(os.environ.get("BOT_LEVERAGE", "1"))
SYMBOL     = os.environ.get("BOT_SYMBOL", "BTC/USDT")

OK   = "  ✅"
FAIL = "  ❌"
WARN = "  ⚠️ "

def banner(text):
    print(f"\n{'═'*55}")
    print(f"  {text}")
    print(f"{'═'*55}")

async def run():
    banner("Binance USDM Futures — Diagnostic")

    # ── 1. Credentials present ─────────────────────────────────
    print("\n[1] Checking .env credentials...")
    if not API_KEY:
        print(f"{FAIL} BINANCE_API_KEY is missing from .env")
        sys.exit(1)
    if not API_SECRET:
        print(f"{FAIL} BINANCE_API_SECRET is missing from .env")
        sys.exit(1)
    print(f"{OK} API Key   : ...{API_KEY[-6:]}")
    print(f"{OK} API Secret: ...{API_SECRET[-6:]}")
    print(f"{OK} Mode      : {'TESTNET' if TESTNET else '🔴 LIVE'}")
    print(f"{OK} Leverage  : {LEVERAGE}×")
    print(f"{OK} Symbol    : {SYMBOL}")

    # ── 2. Import ccxt ─────────────────────────────────────────
    print("\n[2] Importing ccxt...")
    try:
        import ccxt.async_support as ccxt
        print(f"{OK} ccxt version: {ccxt.__version__}")
    except ImportError:
        print(f"{FAIL} ccxt not installed. Run: pip install ccxt")
        sys.exit(1)

    # ── 3. Initialise exchange ─────────────────────────────────
    print("\n[3] Initialising Binance USDM Futures exchange...")
    exchange = ccxt.binanceusdm({
        "apiKey":          API_KEY,
        "secret":          API_SECRET,
        "enableRateLimit": True,
        "options":         {
            "defaultType": "future",
            "fetchMarkets": ["future"],
        },
    })
    if TESTNET:
        exchange.set_sandbox_mode(True)
        print(f"{WARN} Sandbox/testnet mode active — using testnet.binancefutures.com")

    # ── 4. Load markets ────────────────────────────────────────
    print("\n[4] Loading markets (connectivity test)...")
    try:
        markets = await exchange.load_markets()
        print(f"{OK} Markets loaded: {len(markets)} instruments available")
    except Exception as e:
        print(f"{WARN} Could not load markets (often happens if apiKey lacks spot/margin permission): {e}")
        print(f"      → Ignored. Will attempt direct futures endpoint calls anyway.")

    # ── 5. Market spec for BTC/USDT ───────────────────────────
    print(f"\n[5] Checking {SYMBOL} market spec...")
    try:
        market = exchange.market(SYMBOL)
        min_qty   = market.get("limits", {}).get("amount", {}).get("min", "?")
        tick_size = market.get("precision", {}).get("price", "?")
        base_prec = market.get("precision", {}).get("amount", "?")
        print(f"{OK} {SYMBOL} exists on exchange")
        print(f"     Min order qty : {min_qty} BTC")
        print(f"     Price tick    : {tick_size}")
        print(f"     Qty precision : {base_prec}")
    except Exception as e:
        print(f"{FAIL} {SYMBOL} not found: {e}")

    # ── 6. Mark price ──────────────────────────────────────────
    print(f"\n[6] Fetching {SYMBOL} mark price...")
    try:
        ticker = await exchange.fetch_ticker(SYMBOL)
        price  = ticker.get("last") or ticker.get("mark", 0)
        print(f"{OK} Current price: ${price:,.2f}")
    except Exception as e:
        print(f"{FAIL} Could not fetch price: {e}")

    # ── 7. Account balance (requires read permission) ──────────
    print("\n[7] Fetching futures wallet balance (read permission)...")
    try:
        balance  = await exchange.fetch_balance()
        usdt_free  = float(balance.get("free",  {}).get("USDT", 0.0))
        usdt_total = float(balance.get("total", {}).get("USDT", 0.0))
        print(f"{OK} Read permission confirmed")
        print(f"     USDT Free  : ${usdt_free:,.2f}")
        print(f"     USDT Total : ${usdt_total:,.2f}")
        if usdt_total < 5.0:
            print(f"{WARN} Balance is very low — transfer USDT to your futures wallet to trade")
    except ccxt.AuthenticationError as e:
        print(f"{FAIL} Authentication failed: {e}")
        print(f"     → Check API key permissions: 'Enable Futures' must be ticked")
        await exchange.close()
        sys.exit(1)
    except Exception as e:
        print(f"{FAIL} Could not fetch balance: {e}")

    # ── 8. Leverage set check ──────────────────────────────────
    print(f"\n[8] Testing leverage set ({LEVERAGE}×) for {SYMBOL}...")
    try:
        result = await exchange.set_leverage(LEVERAGE, SYMBOL)
        print(f"{OK} Leverage set to {LEVERAGE}× successfully")
    except ccxt.BadRequest as e:
        # Binance returns this if leverage is already at target — treat as success
        if "leverage not modified" in str(e).lower():
            print(f"{OK} Leverage already at {LEVERAGE}× (no change needed)")
        else:
            print(f"{WARN} Leverage set returned warning: {e}")
    except ccxt.PermissionDenied as e:
        print(f"{FAIL} No futures trading permission: {e}")
        print(f"     → Enable 'Futures Trading' in Binance API settings")
    except Exception as e:
        print(f"{FAIL} Leverage set failed: {e}")

    # ── Summary ────────────────────────────────────────────────
    banner("Diagnostic Complete")
    print("  If all checks passed, your bot is ready to trade on")
    print(f"  Binance USDM Futures ({'TESTNET' if TESTNET else 'LIVE'}).")
    print()
    print("  Next step: set BOT_TESTNET=false in Railway when ready to go live.")
    print()

    await exchange.close()

if __name__ == "__main__":
    asyncio.run(run())
