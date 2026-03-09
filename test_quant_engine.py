"""
=============================================================
  QUAD-DESK QUANT ENGINE — COMPREHENSIVE TEST SUITE
=============================================================
Tests every calculation in QuantEngine individually, then runs
integration smoke tests against the live backend if available.

Run:
    python test_quant_engine.py
=============================================================
"""

import os
import sys
import math
import time
import asyncio
import traceback
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv(".env")

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

PASS = f"{GREEN}[PASS]{RESET}"
FAIL = f"{RED}[FAIL]{RESET}"
SKIP = f"{YELLOW}[SKIP]{RESET}"
INFO = f"{CYAN}[INFO]{RESET}"

results = {"pass": 0, "fail": 0, "skip": 0}

def assert_test(name: str, condition: bool, detail: str = ""):
    if condition:
        results["pass"] += 1
        print(f"  {PASS} {name}")
    else:
        results["fail"] += 1
        print(f"  {FAIL} {name}  ← {detail}")

def skip_test(name: str, reason: str):
    results["skip"] += 1
    print(f"  {SKIP} {name}  ({reason})")


# ═══════════════════════════════════════════════════════════════════════════════
# MOCK DATA HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def make_candles(n: int = 60, base_price: float = 95_000.0, trend: float = 0.0) -> list:
    """Return n synthetic OHLCV dicts with mild noise."""
    rng = np.random.default_rng(42)
    candles = []
    price = base_price
    for i in range(n):
        close = price * (1 + trend + rng.normal(0, 0.002))
        high  = close * (1 + abs(rng.normal(0, 0.001)))
        low   = close * (1 - abs(rng.normal(0, 0.001)))
        vol   = rng.uniform(5, 20)
        candles.append({
            "time":   int(time.time()) - (n - i) * 60,
            "open":   price,
            "high":   high,
            "low":    low,
            "close":  close,
            "volume": vol,
        })
        price = close
    return candles

def make_state(candles: list = None, bids: dict = None, asks: dict = None,
               trades: list = None):
    """Minimal duck-typed object matching MarketState interface."""
    class _State:
        pass
    s = _State()
    s.symbol = "BTCUSDT"
    s.candles = candles if candles is not None else make_candles()
    s.bids = bids if bids is not None else {}
    s.asks = asks if asks is not None else {}
    s.recent_trades = trades if trades is not None else []
    s.cvd = 0.0
    return s


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1  —  SKEWNESS
# ═══════════════════════════════════════════════════════════════════════════════

def section_skewness():
    print(f"\n{BOLD}{CYAN}── 1. Log-Return Skewness ──────────────────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    # 1a) Normal candles → finite, bounded value
    state = make_state(make_candles(60))
    df = pd.DataFrame(state.candles)
    engine = QuantEngine(state)
    sk = engine._skewness(df)
    assert_test("Returns a float", isinstance(sk, float), f"got {type(sk)}")
    assert_test("Value is finite (not NaN/Inf)", math.isfinite(sk), f"got {sk}")
    assert_test("Reasonable range (-10 to +10)", -10 < sk < 10, f"got {sk:.4f}")

    # 1b) Strongly uptrending data → positive skew expected
    df_up = pd.DataFrame(make_candles(60, trend=0.005))
    sk_up = engine._skewness(df_up)
    # Not a strict pass – just informational since randomness may vary
    print(f"  {INFO} Uptrend skewness = {sk_up:.4f} (positive bias expected)")

    # 1c) Insufficient data → 0.0 returned, no crash
    short_df = pd.DataFrame(make_candles(10))
    sk_short = engine._skewness(short_df)
    assert_test("Short data → returns 0.0", sk_short == 0.0, f"got {sk_short}")

    # 1d) Flat data (no returns) → 0.0, no division error
    flat = [{"time": i, "open": 100.0, "high": 100.0, "low": 100.0,
              "close": 100.0, "volume": 1.0} for i in range(60)]
    df_flat = pd.DataFrame(flat)
    sk_flat = engine._skewness(df_flat)
    assert_test("Flat prices → 0.0 or finite", math.isfinite(sk_flat), f"got {sk_flat}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2  —  VWAP Z-SCORE
# ═══════════════════════════════════════════════════════════════════════════════

def section_vwap_zscore():
    print(f"\n{BOLD}{CYAN}── 2. VWAP-Anchored Z-Score ─────────────────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    state = make_state(make_candles(60))
    df = pd.DataFrame(state.candles)
    engine = QuantEngine(state)

    current_price = float(df['close'].iloc[-1])
    z = engine._vwap_z_score(df, current_price)

    assert_test("Returns a float", isinstance(z, float))
    assert_test("Value is finite", math.isfinite(z), f"got {z}")
    assert_test("Reasonable range (-10 to +10)", -10 < z < 10, f"got {z:.4f}")
    print(f"  {INFO} VWAP Z-Score = {z:.4f}")

    # Flat data → VWAP std = 0 → should return 0.0 safely
    flat = [{"time": i, "open": 100, "high": 100, "low": 100,
              "close": 100, "volume": 1} for i in range(30)]
    df_flat = pd.DataFrame(flat)
    z_flat = engine._vwap_z_score(df_flat, 100.0)
    assert_test("Flat prices → Z = 0.0", z_flat == 0.0, f"got {z_flat}")

    # Price far above VWAP → large positive Z
    candles_hi = make_candles(25, base_price=95_000)
    df_hi = pd.DataFrame(candles_hi)
    z_hi = engine._vwap_z_score(df_hi, 110_000.0)
    assert_test("Price >> VWAP → Z > 0", z_hi > 0, f"got {z_hi:.4f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3  —  RSI
# ═══════════════════════════════════════════════════════════════════════════════

def section_rsi():
    print(f"\n{BOLD}{CYAN}── 3. RSI (14-period) ───────────────────────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    engine = QuantEngine(make_state())
    df = pd.DataFrame(make_candles(60))
    rsi = engine._rsi(df)

    assert_test("Returns float", isinstance(rsi, float))
    assert_test("In [0, 100]", 0.0 <= rsi <= 100.0, f"got {rsi:.2f}")
    print(f"  {INFO} RSI = {rsi:.2f}")

    # Pure uptrend → RSI should be high
    up_closes = [100.0 + i for i in range(60)]
    df_up = pd.DataFrame([{"time": i, "open": v, "high": v+1,
                            "low": v-0.5, "close": v, "volume": 1}
                          for i, v in enumerate(up_closes)])
    rsi_up = engine._rsi(df_up)
    assert_test("Pure uptrend → RSI ≥ 90", rsi_up >= 90.0, f"got {rsi_up:.2f}")

    # Pure downtrend → RSI should be low
    down_closes = [100.0 - i * 0.5 for i in range(60)]
    df_dn = pd.DataFrame([{"time": i, "open": v, "high": v+0.5,
                            "low": v-1, "close": v, "volume": 1}
                          for i, v in enumerate(down_closes)])
    rsi_dn = engine._rsi(df_dn)
    assert_test("Pure downtrend → RSI ≤ 10", rsi_dn <= 10.0, f"got {rsi_dn:.2f}")

    # Flat market → RSI = 50.0
    flat_closes = [100.0] * 60
    df_fl = pd.DataFrame([{"time": i, "open": v, "high": v,
                            "low": v, "close": v, "volume": 1}
                          for i, v in enumerate(flat_closes)])
    rsi_fl = engine._rsi(df_fl)
    assert_test("Flat market → RSI = 50.0", rsi_fl == 50.0, f"got {rsi_fl:.2f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4  —  TAPE METRICS
# ═══════════════════════════════════════════════════════════════════════════════

def section_tape():
    print(f"\n{BOLD}{CYAN}── 4. Tape Speed & Dominant Side ────────────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    now_ms = time.time() * 1000

    # 4a) No trades → fallback
    engine = QuantEngine(make_state(trades=[]))
    speed, dom = engine._tape_metrics()
    assert_test("Empty trades → ('NORMAL', 'NO DATA')",
                dom == "NO DATA", f"got ({speed}, {dom})")

    # 4b) Heavy BUY pressure in last 10s → BUY dominant
    heavy_buy = [
        {"side": "BUY",  "usd_volume": 500_000, "time": now_ms - 2_000},
        {"side": "BUY",  "usd_volume": 500_000, "time": now_ms - 4_000},
        {"side": "SELL", "usd_volume":   5_000, "time": now_ms - 6_000},
        {"side": "BUY",  "usd_volume": 400_000, "time": now_ms - 3_000},
        {"side": "SELL", "usd_volume":   5_000, "time": now_ms - 5_000},
    ]
    engine_buy = QuantEngine(make_state(trades=heavy_buy))
    speed_b, dom_b = engine_buy._tape_metrics()
    assert_test("Heavy buy → dominant BUY", "BUY" in dom_b, f"got '{dom_b}'")
    print(f"  {INFO} Buy dom result: speed={speed_b}, dom={dom_b}")

    # 4c) Heavy SELL pressure
    heavy_sell = [
        {"side": "SELL", "usd_volume": 900_000, "time": now_ms - 1_000},
        {"side": "SELL", "usd_volume": 800_000, "time": now_ms - 2_000},
        {"side": "BUY",  "usd_volume":   5_000, "time": now_ms - 3_000},
        {"side": "SELL", "usd_volume": 700_000, "time": now_ms - 4_000},
        {"side": "BUY",  "usd_volume":   5_000, "time": now_ms - 5_000},
    ]
    engine_sell = QuantEngine(make_state(trades=heavy_sell))
    speed_s, dom_s = engine_sell._tape_metrics()
    assert_test("Heavy sell → dominant SELL", "SELL" in dom_s, f"got '{dom_s}'")

    # 4d) Screaming tape (> $2M in 10s)
    screaming = [
        {"side": "BUY", "usd_volume": 1_500_000, "time": now_ms - 1_000},
        {"side": "BUY", "usd_volume": 1_000_000, "time": now_ms - 2_000},
        {"side": "BUY", "usd_volume":   500_000, "time": now_ms - 3_000},
        {"side": "BUY", "usd_volume":   500_000, "time": now_ms - 4_000},
        {"side": "BUY", "usd_volume":   500_000, "time": now_ms - 5_000},
    ]
    engine_scream = QuantEngine(make_state(trades=screaming))
    speed_sc, _ = engine_scream._tape_metrics()
    assert_test("$3.5M in 10s → SCREAMING", speed_sc == "SCREAMING", f"got '{speed_sc}'")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5  —  LOB (Anti-Spoofing + OFI)
# ═══════════════════════════════════════════════════════════════════════════════

def section_lob():
    print(f"\n{BOLD}{CYAN}── 5. LOB Metrics / Anti-Spoofing Filter ────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    price = 95_000.0

    # 5a) Deep spoof orders (>0.5% away) must be excluded from OFI
    bids = {
        94_900.0: 2.0,   # within 0.5% → valid
        94_800.0: 1.5,   # within 0.5% → valid
        90_000.0: 999.0, # >5% away   → SPOOFING — must be excluded
    }
    asks = {
        95_100.0: 1.0,   # within 0.5% → valid
        100_000.0: 999.0 # far away   → SPOOFING — must be excluded
    }
    state = make_state(bids=bids, asks=asks)
    engine = QuantEngine(state)
    ofi, wall_ctx, all_walls = engine._lob_metrics(price)

    # OFI from valid orders = 2.0+1.5 - 1.0 = 2.5
    expected_ofi = 2.0 + 1.5 - 1.0
    assert_test(
        f"Spoof filtering: OFI = {expected_ofi} (excl. deep orders)",
        abs(ofi - expected_ofi) < 0.01,
        f"got {ofi:.4f}"
    )
    assert_test("Wall context is a string", isinstance(wall_ctx, str))
    assert_test("All-walls is a string", isinstance(all_walls, str))

    # 5b) Empty book → OFI = 0, no crash
    state_empty = make_state(bids={}, asks={})
    engine_e = QuantEngine(state_empty)
    ofi_e, _, _ = engine_e._lob_metrics(price)
    assert_test("Empty book → OFI = 0", ofi_e == 0.0, f"got {ofi_e}")

    # 5c) Wall detection: one very large bid above threshold
    bids_wall = {
        94_950.0: 1.0,
        94_900.0: 50.0,  # large → wall
        94_850.0: 1.0,
    }
    state_wall = make_state(bids=bids_wall, asks={95_050.0: 1.0})
    engine_w = QuantEngine(state_wall)
    ofi_w, ctx_w, walls_w = engine_w._lob_metrics(price)
    assert_test("Large bid detected as wall context", "BUY" in ctx_w or "Wall" in ctx_w or "94900" in ctx_w,
                f"ctx='{ctx_w}', walls='{walls_w}'")
    print(f"  {INFO} Wall context: {ctx_w}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6  —  BAYESIAN POSTERIOR
# ═══════════════════════════════════════════════════════════════════════════════

def section_bayesian():
    print(f"\n{BOLD}{CYAN}── 6. Bayesian Posterior P(Bull|Evidence) ───────────────{RESET}")
    from bot.quant_engine import QuantEngine

    engine = QuantEngine(make_state())

    # 6a) All bullish signals → P > 0.5
    p_bull = engine._bayesian(rsi=70, ofi=50, z_score=-2, skewness=0.5)
    assert_test("All bullish → P > 0.5", p_bull > 0.5, f"got {p_bull:.4f}")
    print(f"  {INFO} All-bull posterior = {p_bull:.4f}")

    # 6b) All bearish signals → P < 0.5
    p_bear = engine._bayesian(rsi=30, ofi=-50, z_score=2, skewness=-0.5)
    assert_test("All bearish → P < 0.5", p_bear < 0.5, f"got {p_bear:.4f}")
    print(f"  {INFO} All-bear posterior = {p_bear:.4f}")

    # 6c) Neutral signals → P ≈ 0.5
    p_neutral = engine._bayesian(rsi=50, ofi=0, z_score=0, skewness=0)
    assert_test("Neutral → P ≈ 0.50",
                abs(p_neutral - 0.5) < 0.05, f"got {p_neutral:.4f}")

    # 6d) Output always in [0, 1]
    for rsi, ofi, z, sk in [(100,100,-5,-2), (0,-100,5,2), (50,0,0,0)]:
        p = engine._bayesian(rsi, ofi, z, sk)
        assert_test(f"Bounded [0,1] rsi={rsi} ofi={ofi} z={z:.0f} sk={sk}",
                    0.0 <= p <= 1.0, f"got {p}")

    # 6e) Known-value check — matches store/index.ts formula exactly
    # L_rsi=3.0 (rsi>55), L_ofi=1.5 (ofi>10), L_z=1.0 (|z|<1.5), L_skew=1.0 (|sk|<0.3)
    bull_odds = 3.0 * 1.5 * 1.0 * 1.0  # = 4.5
    expected = bull_odds / (bull_odds + 1.0)  # = 4.5 / 5.5 ≈ 0.8182
    actual = engine._bayesian(rsi=60, ofi=20, z_score=0.5, skewness=0.1)
    assert_test(f"Known-value: expected ≈ {expected:.4f}",
                abs(actual - expected) < 0.0001, f"got {actual:.4f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7  —  FULL compute_metrics() INTEGRATION
# ═══════════════════════════════════════════════════════════════════════════════

def section_compute_metrics():
    print(f"\n{BOLD}{CYAN}── 7. compute_metrics() Full Integration ────────────────{RESET}")
    from bot.quant_engine import QuantEngine

    now_ms = time.time() * 1000
    mock_trades = [
        {"side": "BUY",  "usd_volume": 100_000, "time": now_ms - 5_000},
        {"side": "SELL", "usd_volume":  80_000, "time": now_ms - 6_000},
        {"side": "BUY",  "usd_volume":  60_000, "time": now_ms - 7_000},
        {"side": "SELL", "usd_volume":  50_000, "time": now_ms - 8_000},
        {"side": "BUY",  "usd_volume":  40_000, "time": now_ms - 9_000},
    ]
    state = make_state(
        candles=make_candles(60),
        bids={94_900.0: 2.0, 94_800.0: 1.5},
        asks={95_100.0: 1.0, 95_200.0: 0.8},
        trades=mock_trades
    )
    state.cvd = 150.5
    engine = QuantEngine(state)
    result = engine.compute_metrics()

    assert_test("Returns dict (not None)", result is not None, "returned None — need 51+ candles")
    if result is None:
        return

    REQUIRED_KEYS = ["symbol","price","skewness","bayesianPosterior",
                     "zScore","rsi","ofi","cvd","tapeSpeed","tapeDominant",
                     "wallContext","allWalls"]
    for k in REQUIRED_KEYS:
        assert_test(f"Key '{k}' present", k in result, f"keys={list(result.keys())}")

    assert_test("symbol = BTCUSDT", result["symbol"] == "BTCUSDT")
    assert_test("price > 0", result["price"] > 0, f"got {result['price']}")
    assert_test("rsi in [0,100]", 0 <= result["rsi"] <= 100, f"got {result['rsi']:.2f}")
    assert_test("bayesianPosterior in [0,1]",
                0 <= result["bayesianPosterior"] <= 1, f"got {result['bayesianPosterior']:.4f}")
    assert_test("cvd = 150.5", result["cvd"] == 150.5, f"got {result['cvd']}")
    assert_test("tapeSpeed valid", result["tapeSpeed"] in ("NORMAL","SCREAMING"),
                f"got '{result['tapeSpeed']}'")

    print(f"\n  {INFO} Full metrics snapshot:")
    for k, v in result.items():
        val = f"{v:.4f}" if isinstance(v, float) else v
        print(f"       {CYAN}{k:20s}{RESET} = {val}")

    # 7b) Insufficient candles → None
    short_state = make_state(candles=make_candles(10))
    short_state.recent_trades = []
    r_short = QuantEngine(short_state).compute_metrics()
    assert_test("< 51 candles → returns None", r_short is None, f"got {r_short}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8  —  BACKEND API SMOKE TESTS (live, optional)
# ═══════════════════════════════════════════════════════════════════════════════

async def section_backend():
    print(f"\n{BOLD}{CYAN}── 8. Backend API Smoke Tests (live) ────────────────────{RESET}")
    try:
        import httpx
    except ImportError:
        skip_test("All backend tests", "httpx not installed")
        return

    API_BASE = os.getenv("VITE_API_URL", "http://localhost:8000")
    print(f"  {INFO} Target: {API_BASE}")

    async with httpx.AsyncClient(timeout=12.0) as client:

        # 8a) Health check
        try:
            r = await client.get(f"{API_BASE}/health")
            assert_test("GET /health → 200", r.status_code == 200,
                        f"status={r.status_code}")
        except Exception as e:
            skip_test("GET /health", f"backend offline: {e}")
            print(f"  {YELLOW}  Remaining backend tests skipped (backend offline).{RESET}")
            return

        # 8b) Market analysis
        try:
            r = await client.get(f"{API_BASE}/analyze",
                                 params={"symbol": "BTCUSDT", "model": "gemini-2.0-flash"})
            assert_test("GET /analyze → 200", r.status_code == 200,
                        f"status={r.status_code}")
            data = r.json()
            assert_test("/analyze has 'verdict'", "verdict" in data, f"keys={list(data.keys())}")
        except Exception as e:
            skip_test("GET /analyze", str(e))

        # 8c) Order-flow analysis
        try:
            payload = {"symbol":"BTCUSDT","price":95000,"netDelta":150,
                       "totalVolume":2000,"pocPrice":94800,"cvdTrend":"UP",
                       "candleCount":60,"model":"gemini-2.0-flash"}
            r = await client.post(f"{API_BASE}/analyze/flow", json=payload)
            assert_test("POST /analyze/flow → 200", r.status_code == 200,
                        f"status={r.status_code}")
            data = r.json()
            assert_test("/analyze/flow has 'verdict'", "verdict" in data,
                        f"keys={list(data.keys())}")
        except Exception as e:
            skip_test("POST /analyze/flow", str(e))

        # 8d) Macro strategy
        try:
            payload = {"symbol":"BTCUSDT","price":95000,"skewness":-0.2,
                       "bayesianPosterior":0.62,"zScore":1.1,"rsi":57,
                       "ofi":25,"cvd":300,"tapeSpeed":"NORMAL",
                       "tapeDominant":"BUY (ASK HIT)",
                       "wallContext":"Nearest Buy Wall: 94500 (-0.53%)",
                       "model":"gemini-2.0-flash"}
            r = await client.post(f"{API_BASE}/analyze/strategy", json=payload)
            assert_test("POST /analyze/strategy → 200", r.status_code == 200,
                        f"status={r.status_code}")
            data = r.json()
            assert_test("/analyze/strategy has 'verdict'", "verdict" in data,
                        f"keys={list(data.keys())}")
            if "model_used" in data:
                print(f"  {INFO} Strategy model_used = {data['model_used']}")
        except Exception as e:
            skip_test("POST /analyze/strategy", str(e))

        # 8e) Alerts evaluate (fallback model test — high scores trigger AI)
        try:
            payload = {"symbol":"BTCUSDT","price":95000,"zScore":2.8,
                       "tacticalProbability":0.82,"aiScore":0.88,
                       "model":"gemini-2.0-flash"}
            r = await client.post(f"{API_BASE}/alerts/evaluate", json=payload)
            assert_test("POST /alerts/evaluate → 200", r.status_code == 200,
                        f"status={r.status_code}")
            data = r.json()
            assert_test("shouldAlert key present", "shouldAlert" in data, f"keys={list(data.keys())}")
            assert_test("shouldAlert = True (all 3 conditions met)", data.get("shouldAlert") is True,
                        f"score={data.get('score')}")
            if data.get("aiAnalysis") and "model_used" in data["aiAnalysis"]:
                print(f"  {INFO} Alert model_used = {data['aiAnalysis']['model_used']}")
        except Exception as e:
            skip_test("POST /alerts/evaluate", str(e))

        # 8f) Heatmap (Binance upstream)
        try:
            r = await client.get(f"{API_BASE}/heatmap")
            assert_test("GET /heatmap → 200", r.status_code == 200,
                        f"status={r.status_code}")
            data = r.json()
            assert_test("/heatmap returns list", isinstance(data, list), f"got {type(data)}")
        except Exception as e:
            skip_test("GET /heatmap", str(e))

        # 8g) AI Fallback chain test — request gemini-3-pro-preview, must not error
        try:
            r = await client.get(f"{API_BASE}/analyze",
                                 params={"symbol":"BTCUSDT","model":"gemini-3-pro-preview"})
            assert_test("Fallback: gemini-3-pro-preview doesn't crash → 200",
                        r.status_code == 200, f"status={r.status_code}")
            data = r.json()
            mu = data.get("model_used", "unknown")
            print(f"  {INFO} Fallback model_used = {mu}")
            assert_test("model_used is a string", isinstance(mu, str) and len(mu) > 0,
                        f"got {mu!r}")
        except Exception as e:
            skip_test("Fallback chain test", str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print(f"\n{BOLD}{'═'*60}")
    print(f"  QUAD-DESK QUANT ENGINE — TEST SUITE")
    print(f"{'═'*60}{RESET}")

    sections = [
        ("Skewness",          section_skewness),
        ("VWAP Z-Score",      section_vwap_zscore),
        ("RSI",               section_rsi),
        ("Tape Metrics",      section_tape),
        ("LOB / OFI",         section_lob),
        ("Bayesian",          section_bayesian),
        ("compute_metrics()", section_compute_metrics),
    ]

    for name, fn in sections:
        try:
            fn()
        except Exception:
            print(f"  {FAIL} {name} CRASHED:")
            traceback.print_exc()
            results["fail"] += 1

    # Async backend tests
    asyncio.run(section_backend())

    # Summary
    total = results["pass"] + results["fail"] + results["skip"]
    print(f"\n{BOLD}{'═'*60}")
    print(f"  RESULTS: {GREEN}{results['pass']} passed{RESET}  "
          f"{RED}{results['fail']} failed{RESET}  "
          f"{YELLOW}{results['skip']} skipped{RESET}  "
          f"/ {total} total")
    print(f"{'═'*60}{RESET}\n")

    if results["fail"] > 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
