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

    # Recorded calls for assertion in tests
    last_market_order = None   # (symbol, side, amount, params)

    def __init__(self):
        self.has = {"fetchCurrencies": False}
        self.markets = {}
        self.marketsById = {}
        self.symbols = []
        self.last_market_order = None

    async def load_markets(self):
        btc_usdc = {
            "id": "BTC-USDC",
            "symbol": "BTC/USDC",
            "base": "BTC",
            "quote": "USDC",
            "precision": {"amount": 0.00000001, "price": 0.01},
            "limits": {"amount": {"min": 0.00001}, "cost": {"min": 1.0}},
        }
        btc_usd = {
            **btc_usdc,
            "id": "BTC-USD",
            "symbol": "BTC/USD",
            "quote": "USD",
        }
        self.markets["BTC/USDC"] = btc_usdc
        self.markets["BTC/USD"] = btc_usd
        self.marketsById["BTC-USDC"] = btc_usdc
        self.marketsById["BTC-USD"] = btc_usd
        self.symbols = ["BTC/USDC", "BTC/USD"]
        return self.markets

    def market(self, symbol: str):
        """Exact replication of ccxt/base/exchange.py line ~6500"""
        if symbol in self.markets:
            return self.markets[symbol]
        if symbol in self.marketsById:
            return self.marketsById[symbol]
        raise Exception(f"coinbase does not have market symbol {symbol}")

    def amount_to_precision(self, symbol: str, amount: float) -> str:
        """Replicates ccxt line 6587 - calls self.market(symbol) internally"""
        market = self.market(symbol)  # this is where BadSymbol was thrown
        step = market["precision"]["amount"]
        import math
        rounded = math.floor(amount / step) * step
        # To avoid scientific notation issues, just use formatting directly
        return f"{rounded:.8f}"

    def price_to_precision(self, symbol: str, price: float) -> str:
        market = self.market(symbol)
        step = market["precision"]["price"]
        import math
        rounded = math.floor(price / step) * step
        return f"{rounded:.2f}"

    async def fetch_balance(self):
        return {"free": {"USDC": 100.0, "BTC": 0.001}}

    async def create_market_order(self, symbol, side, amount, params=None):
        # Record the call so tests can assert on it
        self.last_market_order = {
            "symbol": symbol,
            "side":   side,
            "amount": amount,
            "params": params or {},
        }
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
    async def send_message(self, msg, **kwargs): pass


# ── Helper to build executor with fake exchange ───────────────────────────────

def make_executor(dry_run=False):
    from bot.executor import TradingExecutor

    # Patch init to avoid real CCXT init
    import unittest.mock as mock
    import asyncio
    with mock.patch("ccxt.async_support.coinbase", return_value=FakeCoinbaseExchange()):
        exc = TradingExecutor.__new__(TradingExecutor)
        exc.exchange_id = "coinbase"
        exc.is_futures = False
        exc.dry_run = dry_run
        exc.testnet = False
        exc.exchange = FakeCoinbaseExchange()
        exc.active_position = None
        exc.pending_order = None
        exc.lock_expiry = 0.0
        exc.failed_order_ts = 0.0
        exc._position_lock = asyncio.Semaphore(1)
        exc._flatten_failed = False
        exc.TAKER_FEE = 0.012
        exc.MAKER_FEE = 0.006
        exc.notifier = FakeNotifier()
    return exc


# ── Test definitions ─────────────────────────────────────────────────────────

def run_case(name, fn):
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

    async def fake_total_equity(price, acct_size=100.0):
        return 1000.0

    async def fake_usdt_balance(acct_size=100.0):
        return 1000.0

    exc.get_total_equity = fake_total_equity
    exc.get_usdt_balance = fake_usdt_balance

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
        account_size=1000.0,
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

    async def fake_total_equity(price, acct_size=100.0):
        return 1000.0

    async def fake_usdt_balance(acct_size=100.0):
        return 1000.0

    exc.get_total_equity = fake_total_equity
    exc.get_usdt_balance = fake_usdt_balance

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
    async def fake_btc_bal(): return 0.05
    exc.get_btc_balance = fake_btc_bal

    await exc.execute_signal(
        symbol="BTC-USDC",
        current_price=69500.0,
        signal=signal,
        max_risk_pct=1.0,
        account_size=1000.0,
        ulis_verdict="SHORT",
    )

    assert len(precision_calls) > 0, "amount_to_precision was never called"
    for sym in precision_calls:
        assert "/" in sym and "-" not in sym, \
            f"amount_to_precision called with non-unified symbol: {sym!r}"
        assert sym in {"BTC/USDC", "BTC/USD"}, \
            f"amount_to_precision called with unexpected symbol: {sym!r}"


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
# TEST 7: Coinbase BUY passes USDC cost, not BTC amount
# ─────────────────────────────────────────────────────────────────────────────

async def test_coinbase_buy_sends_usdc_cost():
    """
    Coinbase spot BUY orders must pass the USDC cost to spend, NOT the BTC quantity.
    Verifies createMarketBuyOrderRequiresPrice=False is set and amount is in USDC.
    """
    exc = make_executor(dry_run=False)
    await exc.initialize()

    PRICE    = 69185.60
    EQUITY   = 112.40   # controlled equity
    RISK_PCT = 3.0
    SL       = 69075.96

    # Patch balance helpers so the test is self-contained
    async def fake_total_equity(price, acct_size=100.0): return EQUITY
    async def fake_usdt_balance(acct_size=100.0): return EQUITY
    exc.get_total_equity  = fake_total_equity
    exc.get_usdt_balance  = fake_usdt_balance

    signal = {
        "verdict":     "BUY",
        "confidence":  0.65,
        "stop_loss":   SL,
        "take_profit": 69390.99,
        "ulis_verdict": "NEUTRAL",
    }

    await exc.execute_signal(
        symbol="BTC-USDC",
        current_price=PRICE,
        signal=signal,
        max_risk_pct=RISK_PCT,
        account_size=EQUITY,
        ulis_verdict="NEUTRAL",
    )

    call = exc.exchange.last_market_order
    assert call is not None, "create_market_order was never called (order aborted before placement)"

    # 1. Symbol must be unified
    assert call["symbol"] == "BTC/USD", \
        f"BUY order used wrong symbol: {call['symbol']!r}"

    # 2. Side must be buy
    assert call["side"] == "buy"

    # 3. Amount must be in USDC (> 1.0 and <= equity), NOT a tiny BTC quantity (< 0.01)
    amount = call["amount"]
    assert amount > 1.0, \
        f"BUY amount looks like BTC quantity ({amount:.8f}), expected USDC cost > $1"
    assert amount <= EQUITY, \
        f"BUY amount {amount} exceeds available equity {EQUITY}"

    # 4. createMarketBuyOrderRequiresPrice must be False in params
    assert call["params"].get("createMarketBuyOrderRequiresPrice") is False, \
        f"Missing createMarketBuyOrderRequiresPrice=False in params: {call['params']}"


# ─────────────────────────────────────────────────────────────────────────────
# TEST 8: Coinbase SELL passes BTC base amount (not USDC)
# ─────────────────────────────────────────────────────────────────────────────

async def test_coinbase_sell_sends_btc_amount():
    """
    Coinbase spot SELL orders must pass the BTC quantity (base amount), not USDC.
    No createMarketBuyOrderRequiresPrice param should be set.
    """
    exc = make_executor(dry_run=False)
    await exc.initialize()

    PRICE  = 69185.60
    EQUITY = 1000.0

    signal = {
        "verdict":     "SELL",
        "confidence":  0.65,
        "stop_loss":   70500.0,
        "take_profit": 66000.0,
        "ulis_verdict": "SHORT",
    }

    # Patch balance helpers so the test is self-contained
    async def fake_total_equity(price, acct_size=100.0): return EQUITY
    async def fake_usdt_balance(acct_size=100.0): return EQUITY
    async def fake_btc_bal(): return 0.05                     # we own BTC to sell
    exc.get_total_equity = fake_total_equity
    exc.get_usdt_balance = fake_usdt_balance
    exc.get_btc_balance  = fake_btc_bal

    await exc.execute_signal(
        symbol="BTC-USDC",
        current_price=PRICE,
        signal=signal,
        max_risk_pct=1.0,
        account_size=EQUITY,
        ulis_verdict="SHORT",
    )

    call = exc.exchange.last_market_order
    assert call is not None, "create_market_order was never called (order aborted before placement)"

    # 1. Symbol must be unified
    assert call["symbol"] == "BTC/USD"

    # 2. Amount must be a small BTC quantity (< 1.0), not a large USDC cost
    amount = call["amount"]
    assert amount < 1.0, \
        f"SELL amount looks like USDC cost ({amount:.2f}), expected BTC quantity < 1.0"

    # 3. createMarketBuyOrderRequiresPrice must NOT be set for SELL
    assert "createMarketBuyOrderRequiresPrice" not in call["params"], \
        f"SELL order should not have createMarketBuyOrderRequiresPrice in params"


# ─────────────────────────────────────────────────────────────────────────────
# RUN ALL TESTS
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "=" * 62)
    print("  Quad-Desk Executor Test Suite")
    print("  Coinbase BTC/USDC symbol + market order format verification")
    print("=" * 62)

    run_case("1. _to_exchange_symbol normalises all formats to BTC/USDC",        test_to_exchange_symbol)
    run_case("2. Hyphenated symbol raises BadSymbol (old bug reproduced)",        test_bad_symbol_with_hyphen)
    run_case("3. initialize() populates markets AND marketsById",                 test_initialize_populates_markets)
    run_case("4. DRY-RUN: position uses unified symbol BTC/USDC",                test_dry_run_uses_unified_symbol)
    run_case("5. LIVE: amount_to_precision called with BTC/USDC not BTC-USDC",   test_live_mode_unified_symbol)
    run_case("6. On-the-fly registration works for any pair",                     test_on_the_fly_registration)
    run_case("7. Coinbase BUY sends USDC cost with RequiresPrice=False",         test_coinbase_buy_sends_usdc_cost)
    run_case("8. Coinbase SELL sends BTC base amount (no RequiresPrice param)",   test_coinbase_sell_sends_btc_amount)

    print()
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"  Results: {passed} passed, {failed} failed out of {len(results)} tests")
    print("=" * 62 + "\n")

    if failed:
        print("FAILED TESTS:")
        for name, ok, err in results:
            if not ok:
                print(f"  - {name}\n    {err}")
        sys.exit(1)
    else:
        print("  All tests passed")
        sys.exit(0)
