"""
Full Binance connectivity + Ed25519 auth diagnostic.
Run: python test_ed25519_auth.py
"""
import os, sys, asyncio, json
import httpx
import ccxt.async_support as ccxt
from dotenv import load_dotenv

load_dotenv()

async def run():
    api_key     = os.environ.get("BINANCE_API_KEY", "").strip()
    ed25519_raw = os.environ.get("BINANCE_ED25519_PRIVATE_KEY", "").strip()
    ed25519_priv = ed25519_raw.replace("\\n", "\n").strip()

    sep = "=" * 60
    print(sep)
    print("  Quad-Desk -- Binance Ed25519 Auth Checker")
    print(sep)

    # -----------------------------------------------------------
    # ENV AUDIT
    # -----------------------------------------------------------
    print("\n[ENV AUDIT]")
    print(f"  BOT_EXCHANGE       : {os.environ.get('BOT_EXCHANGE','(not set)')}")
    print(f"  BOT_SYMBOL         : {os.environ.get('BOT_SYMBOL','(not set)')}")
    print(f"  BOT_TESTNET        : {os.environ.get('BOT_TESTNET','(not set)')}")
    print(f"  BOT_LEVERAGE       : {os.environ.get('BOT_LEVERAGE','(not set)')}")
    print(f"  BOT_MIN_CONFIDENCE : {os.environ.get('BOT_MIN_CONFIDENCE','(not set)')}")
    print(f"  BOT_ACCOUNT_SIZE   : {os.environ.get('BOT_ACCOUNT_SIZE','(not set)')}")
    print(f"  BOT_ULIS_GATE      : {os.environ.get('BOT_ULIS_GATE','(not set)')}")
    print(f"  BINANCE_API_KEY    : {api_key[:12]}...{api_key[-6:] if api_key else '(missing)'}")
    hmac = os.environ.get("BINANCE_API_SECRET","").strip()
    print(f"  BINANCE_API_SECRET : {'(set, '+str(len(hmac))+' chars)' if hmac else '(missing)'}")
    has_ed = bool(ed25519_priv and "BEGIN PRIVATE KEY" in ed25519_priv)
    print(f"  ED25519 KEY        : {'(set, PKCS8)' if has_ed else '(missing or malformed)'}")

    sym_issue = []
    sym = os.environ.get("BOT_SYMBOL","")
    if sym == "BTC/USDC:USDC":
        sym_issue.append("[WARN] BOT_SYMBOL=BTC/USDC:USDC -- Binance USDM USDC-margined contracts")
        sym_issue.append("       have very low liquidity vs BTC/USDT:USDT. Bot may get no fills.")
    for s in sym_issue:
        print(f"  {s}")

    # -----------------------------------------------------------
    # STEP 1: Raw HTTP ping
    # -----------------------------------------------------------
    print("\n[STEP 1] Raw HTTP connectivity ...")
    async with httpx.AsyncClient(timeout=10) as c:
        for url in [
            "https://fapi.binance.com/fapi/v1/ping",
            "https://fapi.binance.com/fapi/v1/exchangeInfo",
        ]:
            try:
                r = await c.get(url)
                if r.status_code == 200:
                    body = r.text[:80]
                    count_hint = ""
                    if "symbols" in r.text:
                        try:
                            count_hint = f" ({len(r.json().get('symbols',[]))} symbols)"
                        except:
                            pass
                    print(f"  [OK ] {url}{count_hint}")
                else:
                    print(f"  [FAIL {r.status_code}] {url} -- {r.text[:120]}")
            except Exception as e:
                print(f"  [ERR] {url} -- {type(e).__name__}: {e}")

    # -----------------------------------------------------------
    # STEP 2: ccxt load_markets (no auth)
    # -----------------------------------------------------------
    print("\n[STEP 2] ccxt.binanceusdm load_markets (public, no auth) ...")
    ex_pub = ccxt.binanceusdm({"enableRateLimit": True})
    ex_pub.has["fetchMarginAllPairs"] = False
    ex_pub.has["fetchFundingHistory"] = False
    ex_pub.has["fetchCurrencies"]     = False
    try:
        await ex_pub.load_markets()
        print(f"  [OK ] {len(ex_pub.markets)} futures markets loaded")
        has_btcusdt = "BTC/USDT:USDT" in ex_pub.markets
        has_btcusdc = "BTC/USDC:USDC" in ex_pub.markets
        print(f"        BTC/USDT:USDT = {'YES' if has_btcusdt else 'NO'}")
        print(f"        BTC/USDC:USDC = {'YES (low liquidity warning)' if has_btcusdc else 'NO -- BOT_SYMBOL must be changed'}")
    except Exception as e:
        print(f"  [FAIL] {type(e).__name__}: {e}")
    finally:
        await ex_pub.close()

    # -----------------------------------------------------------
    # STEP 3: Ed25519 authenticated balance check
    # -----------------------------------------------------------
    if not api_key:
        print("\n[STEP 3] Skipped -- BINANCE_API_KEY missing")
        return
    if not has_ed:
        print("\n[STEP 3] Skipped -- ED25519 key missing; falling back to HMAC")
        secret = hmac
    else:
        secret = ed25519_priv

    print(f"\n[STEP 3] Auth test using {'Ed25519' if has_ed else 'HMAC'} key ...")
    ex = ccxt.binanceusdm({
        "apiKey": api_key,
        "secret": secret,
        "enableRateLimit": True,
        "options": {
            "defaultType": "future",
            "adjustForTimeDifference": True,
            "recvWindow": 10000,
        },
    })
    ex.has["fetchMarginAllPairs"] = False
    ex.has["fetchFundingHistory"] = False
    ex.has["fetchCurrencies"]     = False

    try:
        await ex.load_markets()
        print("  [OK ] load_markets passed (authenticated)")
        balance = await ex.fetch_balance()
        free = balance.get("free", {})
        usdt = float(free.get("USDT", 0))
        usdc = float(free.get("USDC", 0))
        print(f"  [OK ] fetch_balance passed -- USDT={usdt:.4f} | USDC={usdc:.4f}")
        if usdt < 1 and usdc < 1:
            print("  [WARN] Both balances are near zero. Top up your futures wallet.")

        try:
            info = await ex.fapiPrivateGetAccount()
            can_trade = info.get("canTrade", False)
            pos_mode  = "Hedge" if info.get("dualSidePosition", False) else "One-way"
            print(f"  [OK ] canTrade={can_trade} | posMode={pos_mode} | feeTier={info.get('feeTier')}")
            if not can_trade:
                print("  [WARN] canTrade=False -- enable Futures on this API key in Binance settings")
        except Exception as e:
            print(f"  [WARN] fapiPrivateGetAccount failed: {e}")

        # Funding rate quick check
        try:
            pr = await ex.fetch_funding_rate("BTC/USDT:USDT")
            rate = pr.get("fundingRate", None)
            print(f"  [OK ] Funding rate API works: BTC/USDT rate={rate}")
        except Exception as e:
            print(f"  [WARN] Funding rate fetch failed: {e}")

        print(f"\n{sep}")
        print("  RESULT: Key is VALID. Bot is ready to trade.")
        print(sep)

    except ccxt.AuthenticationError as e:
        print(f"  [FAIL] Authentication error (-2015/-2014): {e}")
        print("  --> The Ed25519 private key does NOT match this API key on Binance,")
        print("      OR the key was revoked. Generate a new Ed25519 key pair on Binance.")
    except ccxt.PermissionDenied as e:
        print(f"  [FAIL] Permission denied: {e}")
        print("  --> Key valid but 'Enable Futures' is unchecked. Edit key on Binance.")
    except Exception as e:
        print(f"  [FAIL] {type(e).__name__}: {e}")
    finally:
        await ex.close()

if __name__ == "__main__":
    asyncio.run(run())
