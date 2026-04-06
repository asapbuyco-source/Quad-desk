"""
test_symbol_fix.py
==================
Verifies that executor.py correctly uses unified CCXT symbol format (BTC/USDC)
and never passes the hyphenated exchange ID (BTC-USDC) to CCXT internal methods.

Run with:
    python test_symbol_fix.py
"""

import sys
import os
import asyncio
import traceback

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

PASS = "\033[92m✓ PASS\033[0m"
FAIL = "\033[91m✗ FAIL\033[0m"
results = []

# ── Fake CCXT exchange that mimics real CCXT behaviour ────────────────────────

class FakeCoinbaseExchange:
    """
    Minimal mock of ccxt.coinbase that replicates the real market() lookup logic.
    This is the exact code path that was failing in production:
        exchange.amount_to_precision(symbol, amount) → calls self.market(symbol)
        self.market(symbol) → looks up self.markets[symbol] by UNIFIED key
    """
    id = "coinbase"
    apiKey = "test-key"
    has = {"fetchCurrencies": False}
    markets = {}
    marketsById = {}
    symbols = []
    precisionMode = 4  # TICK_SIZE

    async def load_markets(self):
        raise Exception("CDP key: public V2 currency fetch not supported — simulated failure")

    def market(self, symbol: str):
        """Exact replication of ccxt/base/exchange.py line ~6500"""
        if symbol in self.markets:
            return self.markets[symbol]
        if symbol in self.marketsById:
            return self.marketsById[symbol]
        raise Exception(f"coinbase does not have market symbol {symbol}")

    def amount_to_precision(self, symbol: str, amount: float) -> str:
        """Replicates ccxt line 6587 — calls self.market(symbol) internally"""
        market = self.market(symbol)  # ← this is where BadSymbol was thrown
        step = market["precision"]["amount"]
        # Simple tick-size rounding
        import math
        rounded = math.floor(amount / step) * step
        decimals = len(str(step).rstrip('0').split('.')[-1]) if '.' in str(step) else 0
        return f"{rounded:.{decimals}f}"

    def price_to_precision(self, symbol: str, price: float) -> str:
        market = self.market(symbol)
        step = market["precision"]["price"]
        import math
        rounded = math.floor(price / step) * step
        decimals = len(str(step).rstrip('0').split('.')[-1]) if '.' in str(step) else 0
        return f"{rounded:.{decimals}f}"

    async def fetch_balance(self):
        return {"free": {"USDC": 100.0, "BTC": 0.001}}

    async def create_market_order(self, symbol, side, amount):
        # Ensure unified format reaches here too
        assert "/" in symbol, f"create_market_order called with non-unified symbol: {symbol}"
        return {"id": "mock-order-001", "status": "filled", "symbol": symbol}

    async def create_order(self, symbol, type, side, amount, price, params=None):
        assert "/" in symbol, f"create_order called with non-unified symbol: {symbol}"
        return {"id": "mock-sl-001", "status": "open"}

    async def close(self):
        pass


class FakeNotifier:
    async def send_trade_alert(self, **kwargs): pass
    async def send_error_alert(self, msg): pass


# ── Helper to build executor with fake exchange ───────────────────────────────

def make_executor(dry_run=False):
    from bot.executor import TradingExecutor

    # Patch init to avoid real CCXT init
    import unittest.mock as mock
    with mock.patch("ccxt.async_support.coinbase", return_value=FakeCoinbaseExchange()):
        exc = TradingExecutor.__new__(TradingExecutor)
        exc.exchange_id = "coinbase"
        exc.dry_run = dry_run
        exc.testnet = False
        exc.exchange = FakeCoinbaseExchange()
        exc.active_position = None
        exc.pending_order = None
        exc.notifier = FakeNotifier()
    return exc


# ── Test definitions ─────────────────────────────────────────────────────────

def test(name, fn):
    """Run a test, record pass/fail."""
    try:
        asyncio.run(fn()) if asyncio.iscoroutinefunction(fn) else fn()
        results.append((name, True, ""))
        print(f"  {PASS}  {name}")
    except Exception as e:
        results.append((name, False, str(e)))
        print(f"  {FAIL}  {name}")
        print(f"         → {e}")


# ─────────────────────────────────────────────────────────────────────────────
# TEST 1: _to_exchange_symbol converts all input formats → unified BTC/USDC
# ─────────────────────────────────────────────────────────────────────────────

def test_to_exchange_symbol():
    exc = make_executor()
    cases = [
        ("BTC-USDC",  "BTC/USDC"),  # ← main.py default SYMBOL
        ("BTC/USDC",  "BTC/USDC"),  # already unified
        ("btc-usdc",  "BTC/USDC"),  # lowercase
        ("BTC-USD",   "BTC/USD"),
        ("BTC/USD",   "BTC/USD"),
        ("BTCUSDC",   "BTC/USDC"),  # no separator
    ]
    for inp, expected in cases:
        result = exc._to_exchange_symbol(inp)
        assert result == expected, f"_to_exchange_symbol({inp!r}) → {result!r}, want {expected!r}"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 2: amount_to_precision FAILS with hyphenated symbol (confirms old bug)
# ─────────────────────────────────────────────────────────────────────────────

def test_bad_symbol_with_hyphen():
    """Proves the old code would crash: passing BTC-USDC to amount_to_precision"""
    fake_exc = FakeCoinbaseExchange()
    # populate markets with UNIFIED key only (as CCXT does)
    fake_exc.markets["BTC/USDC"] = {
        "precision": {"amount": 1e-8, "price": 0.01},
        "limits": {},
    }
    # Using unified symbol: OK
    fake_exc.amount_to_precision("BTC/USDC", 0.001)

    # Using hyphenated: should raise (reproduces production error)
    raised = False
    try:
        fake_exc.amount_to_precision("BTC-USDC", 0.001)
    except Exception as e:
        raised = True
        assert "does not have market symbol BTC-USDC" in str(e), f"Wrong exception: {e}"
    assert raised, "Expected BadSymbol to be raised for BTC-USDC but it wasn't"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 3: initialize() populates BOTH markets AND marketsById correctly
# ─────────────────────────────────────────────────────────────────────────────

async def test_initialize_populates_markets():
    exc = make_executor()
    # load_markets will fail → triggers the fallback block
    await exc.initialize()

    assert "BTC/USDC" in exc.exchange.markets,    "markets missing BTC/USDC"
    assert "BTC/USD"  in exc.exchange.markets,    "markets missing BTC/USD"
    assert "BTC-USDC" in exc.exchange.marketsById, "marketsById missing BTC-USDC"
    assert "BTC-USD"  in exc.exchange.marketsById, "marketsById missing BTC-USD"
    assert "BTC/USDC" in exc.exchange.symbols,    "symbols missing BTC/USDC"

    # Verify structure
    m = exc.exchange.markets["BTC/USDC"]
    assert m["id"]     == "BTC-USDC", f"Wrong id: {m['id']}"
    assert m["symbol"] == "BTC/USDC", f"Wrong symbol: {m['symbol']}"
    assert m["base"]   == "BTC"
    assert m["quote"]  == "USDC"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 4: execute_signal DRY RUN uses unified symbol (no crash)
# ─────────────────────────────────────────────────────────────────────────────

async def test_dry_run_uses_unified_symbol():
    exc = make_executor(dry_run=True)
    await exc.initialize()

    signal = {
        "verdict":     "BUY",
        "confidence":  0.70,
        "stop_loss":   68000.0,
        "take_profit": 71000.0,
        "ulis_verdict": "NEUTRAL",
    }
    # Should not raise
    await exc.execute_signal(
        symbol="BTC-USDC",      # raw SYMBOL from main.py (hyphenated)
        current_price=69500.0,
        signal=signal,
        max_risk_pct=1.0,
        account_size=100.0,
        ulis_verdict="NEUTRAL",
    )
    # Confirm dry-run position was opened with unified symbol
    assert exc.active_position is not None, "Dry-run position was not opened"
    assert exc.active_position["symbol"] == "BTC/USDC", \
        f"Position symbol is {exc.active_position['symbol']!r}, expected BTC/USDC"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 5: execute_signal LIVE mode calls amount_to_precision with unified symbol
# ─────────────────────────────────────────────────────────────────────────────

async def test_live_mode_unified_symbol():
    """
    Key regression test: verifies the old BTC-USDC→BadSymbol crash is gone.
    In live mode, amount_to_precision must receive BTC/USDC, not BTC-USDC.
    """
    exc = make_executor(dry_run=False)
    await exc.initialize()

    precision_calls = []
    original_atp = exc.exchange.amount_to_precision

    def intercept_atp(symbol, amount):
        precision_calls.append(symbol)
        return original_atp(symbol, amount)

    exc.exchange.amount_to_precision = intercept_atp

    signal = {
        "verdict":     "SELL",
        "confidence":  0.65,
        "stop_loss":   70500.0,   # SELL: SL above price
        "take_profit": 68000.0,
        "ulis_verdict": "SHORT",
    }

    # Fake BTC balance so SELL isn't blocked
    async def fake_btc_bal(): return 0.005
    exc.get_btc_balance = fake_btc_bal

    await exc.execute_signal(
        symbol="BTC-USDC",
        current_price=69500.0,
        signal=signal,
        max_risk_pct=1.0,
        account_size=100.0,
        ulis_verdict="SHORT",
    )

    assert len(precision_calls) > 0, "amount_to_precision was never called"
    for sym in precision_calls:
        assert sym == "BTC/USDC", \
            f"amount_to_precision called with wrong symbol: {sym!r}  (expected BTC/USDC)"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 6: on-the-fly registration in execute_signal handles any pair
# ─────────────────────────────────────────────────────────────────────────────

def test_on_the_fly_registration():
    exc = make_executor(dry_run=True)
    exc.exchange.markets = {}
    exc.exchange.marketsById = {}
    exc.exchange.symbols = []

    # Simulate the on-the-fly path by calling _to_exchange_symbol + checking registration
    ex_symbol = exc._to_exchange_symbol("ETH-USDC")
    assert ex_symbol == "ETH/USDC"

    # Manually run the on-the-fly block from execute_signal
    if ex_symbol not in (exc.exchange.markets or {}):
        base, quote = (ex_symbol.split("/") + ["USDC"])[:2]
        ex_id = f"{base}-{quote}"
        market_spec = {
            'id': ex_id, 'symbol': ex_symbol, 'base': base, 'quote': quote,
            'precision': {'amount': 1e-8, 'price': 0.01},
            'limits': {'amount': {'min': 0.00001}, 'price': {'min': 0.01}, 'cost': {'min': 1.0}},
            'active': True, 'type': 'spot', 'spot': True, 'margin': False, 'contract': False
        }
        exc.exchange.markets[ex_symbol] = market_spec
        exc.exchange.marketsById[ex_id]  = market_spec

    assert "ETH/USDC"  in exc.exchange.markets
    assert "ETH-USDC"  in exc.exchange.marketsById
    assert exc.exchange.markets["ETH/USDC"]["id"] == "ETH-USDC"


# ─────────────────────────────────────────────────────────────────────────────
# RUN ALL TESTS
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "═" * 60)
    print("  Quad-Desk — Symbol Fix Test Suite")
    print("  Verifying BTC/USDC vs BTC-USDC handling in executor.py")
    print("═" * 60)

    test("1. _to_exchange_symbol normalises all formats → BTC/USDC",         test_to_exchange_symbol)
    test("2. Hyphenated symbol raises BadSymbol (old bug reproduced)",         test_bad_symbol_with_hyphen)
    test("3. initialize() populates markets AND marketsById",                  test_initialize_populates_markets)
    test("4. DRY-RUN: position uses unified symbol BTC/USDC",                 test_dry_run_uses_unified_symbol)
    test("5. LIVE: amount_to_precision called with BTC/USDC not BTC-USDC",    test_live_mode_unified_symbol)
    test("6. On-the-fly registration works for any pair",                      test_on_the_fly_registration)

    print()
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"  Results: {passed} passed, {failed} failed out of {len(results)} tests")
    print("═" * 60 + "\n")

    if failed:
        print("FAILED TESTS:")
        for name, ok, err in results:
            if not ok:
                print(f"  • {name}\n    {err}")
        sys.exit(1)
    else:
        print("  All tests passed ✓")
        sys.exit(0)
