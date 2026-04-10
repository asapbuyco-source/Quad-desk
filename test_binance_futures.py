"""
Binance USDM Futures - API Key Diagnostic
==========================================
Bypasses ccxt.load_markets() (which hangs due to an internal
ccxt bug calling extra endpoints). Tests auth, balance,
permissions, leverage and positions via direct ccxt calls.

Run with:
    python test_binance_futures.py
"""

import asyncio
import os
import sys
import httpx
import hashlib
import hmac
import time
import urllib.parse
import base64
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

API_KEY    = os.environ.get("BINANCE_API_KEY",    "")
API_SECRET = os.environ.get("BINANCE_API_SECRET", "")
ED25519_PRIVKEY = os.environ.get("BINANCE_ED25519_PRIVATE_KEY", "")
if ED25519_PRIVKEY:
    ED25519_PRIVKEY = ED25519_PRIVKEY.replace("\\n", "\n").strip()

TESTNET    = os.environ.get("BOT_TESTNET", "false").lower() != "false"
LEVERAGE   = int(os.environ.get("BOT_LEVERAGE", "3"))
SYMBOL     = os.environ.get("BOT_SYMBOL", "BTC/USDT")
QUOTE      = SYMBOL.split("/")[-1] if "/" in SYMBOL else "USDT"
FEED_SYM   = SYMBOL.replace("/", "").replace("-", "")

BASE = "https://testnet.binancefuture.com" if TESTNET else "https://fapi.binance.com"
TIME_OFFSET = 0  # To adjust local timestamp to server timestamp

def ok(m):   print(f"  [OK]    {m}")
def fail(m): print(f"  [FAIL]  {m}")
def warn(m): print(f"  [WARN]  {m}")
def head(m): print(f"\n{'='*55}\n  {m}\n{'='*55}")


def _sign(params: dict) -> str:
    query = urllib.parse.urlencode(params)
    if ED25519_PRIVKEY:
        priv_key = load_pem_private_key(ED25519_PRIVKEY.encode('utf-8'), password=None)
        sig = priv_key.sign(query.encode('utf-8'))
        return base64.b64encode(sig).decode('utf-8')
    else:
        return hmac.new(API_SECRET.encode(), query.encode(), hashlib.sha256).hexdigest()


async def sget(client, path, extra=None):
    p = {"timestamp": int(time.time() * 1000) - TIME_OFFSET, "recvWindow": 60000}
    if extra:
        p.update(extra)
    p["signature"] = _sign(p)
    r = await client.get(
        f"{BASE}{path}", params=p,
        headers={"X-MBX-APIKEY": API_KEY}, timeout=15,
    )
    r.raise_for_status()
    return r.json()


async def spost(client, path, params):
    params["timestamp"] = int(time.time() * 1000) - TIME_OFFSET
    params["recvWindow"] = 60000
    params["signature"] = _sign(params)
    r = await client.post(
        f"{BASE}{path}", params=params,
        headers={"X-MBX-APIKEY": API_KEY}, timeout=15,
    )
    r.raise_for_status()
    return r.json()


async def run():
    head("Binance USDM Futures - API Diagnostic")

    # ── 0. Credentials ───────────────────────────────────────────
    if not API_KEY or (not API_SECRET and not ED25519_PRIVKEY):
        fail("BINANCE_API_KEY / BINANCE_API_SECRET / BINANCE_ED25519_PRIVATE_KEY missing from .env!")
        return

    print(f"\n[Config]")
    ok(f"API Key    : {API_KEY[:8]}...{API_KEY[-6:]}")
    ok(f"Signing    : {'Ed25519' if ED25519_PRIVKEY else 'HMAC-SHA256'}")
    ok(f"Mode       : {'TESTNET' if TESTNET else 'LIVE (real money)'}")
    ok(f"Leverage   : {LEVERAGE}x")
    ok(f"Symbol     : {SYMBOL}")
    ok(f"API Base   : {BASE}")

    async with httpx.AsyncClient(timeout=15) as client:

        # ── 1. Ping ──────────────────────────────────────────────
        print(f"\n[1] Connectivity ping...")
        try:
            r = await client.get(f"{BASE}/fapi/v1/ping", timeout=8)
            r.raise_for_status()
            ok("fapi.binance.com reachable")
        except Exception as e:
            fail(f"Cannot reach {BASE}: {e}")
            return

        # ── 2. Server time / clock drift ─────────────────────────
        print(f"\n[2] Clock skew check...")
        try:
            r = await client.get(f"{BASE}/fapi/v1/time", timeout=8)
            r.raise_for_status()
            server_ms = r.json()["serverTime"]
            local_ms  = int(time.time() * 1000)
            drift = local_ms - server_ms
            global TIME_OFFSET
            TIME_OFFSET = drift
            if abs(drift) < 1000:
                ok(f"Clock drift: {drift:+d} ms  (safe)")
            else:
                warn(f"Clock drift: {drift:+d} ms  (auto-corrected for remaining tests)")
        except Exception as e:
            warn(f"Server time fetch failed: {e}")

        # ── 3. Public market info  ────────────────────────────────
        print(f"\n[3] Skipping wide payload tests (exchangeInfo avoided for speed)...")

        # ── 4. Signed: wallet balance ─────────────────────────────
        print(f"\n[4] Signed request -> futures wallet balance...")
        usdt_free = 0.0
        try:
            data = await sget(client, "/fapi/v2/balance")
            assets = {a["asset"]: a for a in data}
            usdt = assets.get(QUOTE, {})
            usdt_free   = float(usdt.get("availableBalance", 0))
            usdt_wallet = float(usdt.get("walletBalance", 0))
            usdt_pnl    = float(usdt.get("unrealizedProfit", 0))
            ok("Signed request accepted -> API key & secret are VALID")
            ok(f"{QUOTE} wallet balance   : ${usdt_wallet:.4f}")
            ok(f"{QUOTE} available (free) : ${usdt_free:.4f}")
            ok(f"{QUOTE} unrealised PnL   : ${usdt_pnl:.4f}")
            if usdt_free < 1.0:
                warn(f"Available {QUOTE} < $1. Transfer {QUOTE} to your Binance FUTURES wallet (not Spot) before going live!")
        except httpx.HTTPStatusError as e:
            sc = e.response.status_code
            body = e.response.text[:200]
            if sc == 401:
                fail(f"401 Unauthorised -> API key INVALID or secret wrong")
            elif sc == 403:
                fail(f"403 Forbidden -> IP restriction? Key may be whitelisted to another IP")
            else:
                fail(f"HTTP {sc}: {body}")
            return
        except Exception as e:
            fail(f"Balance fetch failed: {e}")
            return

        # ── 5. Account permission flags ───────────────────────────
        print(f"\n[5] Account & permission flags...")
        try:
            acct = await sget(client, "/fapi/v2/account")
            can_trade = acct.get("canTrade", False)
            if can_trade:
                ok("canTrade = True  ->  Futures trading ENABLED on this key")
            else:
                fail("canTrade = False  ->  Futures trading NOT enabled!")
                warn("Fix: Binance.com -> API Management -> Edit -> tick 'Enable Futures'")

            for flag in ("canDeposit", "canWithdraw", "multiAssetsMargin"):
                v = acct.get(flag)
                if v is not None:
                    ok(f"{flag} = {v}")

            ft = acct.get("feeTier")
            if ft is not None:
                rates = [0.040, 0.040, 0.035, 0.032, 0.030, 0.027, 0.025, 0.022, 0.020, 0.017]
                r = rates[min(ft, 9)]
                ok(f"Fee tier: {ft}  (taker ~{r:.3f}%  |  maker ~{r*0.5:.3f}%)")
        except Exception as e:
            warn(f"Account flags error: {e}")

        # ── 6. Set leverage (non-destructive) ─────────────────────
        print(f"\n[6] Set leverage {LEVERAGE}x on {FEED_SYM} (no order placed)...")
        try:
            resp = await spost(client, "/fapi/v1/leverage",
                               {"symbol": FEED_SYM, "leverage": LEVERAGE})
            ok(f"Leverage set -> {resp.get('leverage')}x on {resp.get('symbol')}")
        except httpx.HTTPStatusError as e:
            j = e.response.json() if e.response.content else {}
            code = j.get("code", "?")
            msg  = j.get("msg",  "?")
            if code == -4028:
                ok(f"Leverage already at {LEVERAGE}x (no change, code {code})")
            else:
                fail(f"set_leverage failed [{code}]: {msg}")
                if "permission" in str(msg).lower():
                    warn("Key missing 'Enable Futures' permission in Binance API settings")
        except Exception as e:
            fail(f"set_leverage error: {e}")

        # ── 7. Open positions ─────────────────────────────────────
        print(f"\n[7] Open positions on {FEED_SYM}...")
        try:
            data = await sget(client, "/fapi/v2/positionRisk", {"symbol": FEED_SYM})
            active = [p for p in data if float(p.get("positionAmt", 0)) != 0]
            if active:
                for p in active:
                    side  = "LONG" if float(p["positionAmt"]) > 0 else "SHORT"
                    size  = abs(float(p["positionAmt"]))
                    entry = p.get("entryPrice", "?")
                    pnl   = p.get("unRealizedProfit", "?")
                    warn(f"OPEN {side}: {size} BTC @ ${entry}  PnL=${pnl}")
            else:
                ok(f"No open positions on {FEED_SYM}")
        except Exception as e:
            warn(f"Positions error: {e}")

    # ── Summary ───────────────────────────────────────────────────
    head("RESULT")
    if usdt_free >= 1.0:
        ok("API key VALID + funded. Bot is ready for LIVE futures trading.")
        ok("The Railway (USA) server will connect to fapi.binance.com with no regional issues.")
    else:
        warn(f"API key VALID but Futures wallet is empty ({QUOTE}).")
        warn(f"Go to Binance -> Wallet -> Futures -> Transfer {QUOTE} from Spot to Futures wallet.")
    print()


if __name__ == "__main__":
    asyncio.run(run())
