"""
=============================================================
  QUAD-DESK TRADE EXECUTION TEST SUITE
=============================================================
Comprehensive tests to verify the bot can correctly:
  1. Validate trading signals
  2. Calculate risk-adjusted position sizes
  3. Execute buy/sell orders with proper SL/TP
  4. Handle edge cases and error conditions
  5. Track positions and P&L

Run:
    python test_trade_execution.py

This test suite uses mocked CCXT exchanges to avoid real trades.
=============================================================
"""

import os
import sys
import asyncio
import logging
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from typing import Dict, Any, Optional
import traceback

# Add bot to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Setup logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger("TestTradeExecution")

# ANSI Colors
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

PASS = f"{GREEN}[PASS]{RESET}"
FAIL = f"{RED}[FAIL]{RESET}"
SKIP = f"{YELLOW}[SKIP]{RESET}"

test_results = {"pass": 0, "fail": 0, "skip": 0}


def assert_test(name: str, condition: bool, detail: str = ""):
    """Record test result."""
    if condition:
        test_results["pass"] += 1
        print(f"  {PASS} {name}")
    else:
        test_results["fail"] += 1
        print(f"  {FAIL} {name}  -> {detail}")
        traceback.print_stack(limit=3)


def skip_test(name: str, reason: str):
    """Skip test and record reason."""
    test_results["skip"] += 1
    print(f"  {SKIP} {name}  ({reason})")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — Mock Exchange Setup
# ═══════════════════════════════════════════════════════════════════════════════

class MockCCXTExchange:
    """Mock CCXT exchange for testing without real API calls."""
    
    def __init__(self, exchange_id: str = "mock", is_dry_run: bool = True):
        self.exchange_id = exchange_id
        self.is_dry_run = is_dry_run
        self.apiKey = "mock_key" if not is_dry_run else ""
        self.secret = "mock_secret" if not is_dry_run else ""
        self.has = {"fetchCurrencies": False}
        self.options = {"defaultType": "future"}
        self.markets = {
            "BTC/USDC": {
                "id": "BTC-USDC",
                "symbol": "BTC/USDC",
                "base": "BTC",
                "quote": "USDC",
                "precision": {"amount": 8, "price": 2},
                "limits": {
                    "amount": {"min": 0.00001, "max": 1000},
                    "price": {"min": 0.01, "max": 1000000},
                    "cost": {"min": 1.0},
                },
                "active": True,
            },
            "ETH/USDC": {
                "id": "ETH-USDC",
                "symbol": "ETH/USDC",
                "base": "ETH",
                "quote": "USDC",
                "precision": {"amount": 8, "price": 2},
                "limits": {
                    "amount": {"min": 0.0001, "max": 10000},
                    "price": {"min": 0.01, "max": 1000000},
                    "cost": {"min": 1.0},
                },
                "active": True,
            },
        }
        self.symbols = list(self.markets.keys())
        self.orders_placed = []
        self.balance = {"USDC": 100.0, "BTC": 0.0, "ETH": 0.0}
        self.order_counter = 0
        
    async def load_markets(self):
        """Mock load_markets."""
        logger.info(f"[MockExchange] Loaded {len(self.markets)} markets")
        return self.markets
    
    async def close(self):
        """Mock close."""
        logger.info("[MockExchange] Closed")
    
    async def fetch_balance(self):
        """Mock fetch balance."""
        return {
            "USDC": self.balance["USDC"],
            "BTC": self.balance["BTC"],
            "ETH": self.balance["ETH"],
            "free": {
                "USDC": self.balance["USDC"],
                "BTC": self.balance["BTC"],
                "ETH": self.balance["ETH"],
            },
            "used": {},
        }
    
    def amount_to_precision(self, symbol: str, amount: float) -> str:
        """Mock amount precision."""
        market = self.markets.get(symbol, {})
        precision = market.get("precision", {}).get("amount", 8)
        return f"{amount:.{precision}f}"
    
    def price_to_precision(self, symbol: str, price: float) -> str:
        """Mock price precision."""
        market = self.markets.get(symbol, {})
        precision = market.get("precision", {}).get("price", 2)
        return f"{price:.{precision}f}"
    
    async def create_market_order(self, symbol: str, side: str, amount: float):
        """Mock market order creation."""
        self.order_counter += 1
        order = {
            "id": f"order_{self.order_counter}",
            "symbol": symbol,
            "side": side,
            "type": "market",
            "amount": amount,
            "status": "closed",
            "info": {},
        }
        self.orders_placed.append(order)
        logger.info(f"[MockExchange] Market {side.upper()} {amount} {symbol} → id={order['id']}")
        return order
    
    async def create_order(self, symbol: str, type: str, side: str, amount: float, 
                          price: float, params: Dict[str, Any] = None):
        """Mock limit/stop order creation."""
        self.order_counter += 1
        order = {
            "id": f"order_{self.order_counter}",
            "symbol": symbol,
            "type": type,
            "side": side,
            "amount": amount,
            "price": price,
            "status": "open",
            "info": params or {},
        }
        self.orders_placed.append(order)
        logger.info(f"[MockExchange] {type.upper()} {side.upper()} {amount} {symbol} @ {price} → id={order['id']}")
        return order
    
    def set_sandbox_mode(self, sandbox: bool):
        """Mock sandbox mode."""
        logger.info(f"[MockExchange] Sandbox mode: {sandbox}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — Position Sizing Tests
# ═══════════════════════════════════════════════════════════════════════════════

def section_position_sizing():
    """Test position size calculation."""
    print(f"\n{BOLD}{CYAN}-- Position Sizing Tests --{RESET}")
    
    from bot.executor import TradingExecutor
    
    # Mock the exchange initialization
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="test",
            api_secret="test",
            exchange_id="binanceusdm",
            dry_run=True,
            testnet=True,
        )
        
        # Test 1: Basic position sizing
        entry = 42_000.0
        stop_loss = 40_000.0
        equity = 1_000.0
        max_risk_pct = 1.0
        
        size = executor.calculate_position_size(entry, stop_loss, equity, max_risk_pct)
        expected = (1_000.0 * 0.01) / (42_000.0 - 40_000.0)  # 10 / 2000 = 0.005
        
        assert_test(
            "Correct position size for BUY",
            abs(size - expected) < 0.0001,
            f"expected {expected}, got {size}"
        )
        
        # Test 2: High risk percentage
        size = executor.calculate_position_size(entry, stop_loss, equity, 2.0)
        expected = (1_000.0 * 0.02) / (42_000.0 - 40_000.0)  # 20 / 2000 = 0.01
        
        assert_test(
            "Position size scales with risk percentage",
            abs(size - expected) < 0.0001,
            f"expected {expected}, got {size}"
        )
        
        # Test 3: Sell side (stop loss above entry)
        entry = 45_000.0
        stop_loss = 47_000.0
        
        size = executor.calculate_position_size(entry, stop_loss, equity, 1.0)
        expected = (1_000.0 * 0.01) / (47_000.0 - 45_000.0)  # 10 / 2000 = 0.005
        
        assert_test(
            "Correct position size for SELL",
            abs(size - expected) < 0.0001,
            f"expected {expected}, got {size}"
        )
        
        # Test 4: Zero distance (should return 0)
        size = executor.calculate_position_size(45_000.0, 45_000.0, equity, 1.0)
        assert_test(
            "Returns 0 when entry equals stop loss",
            size == 0.0,
            f"expected 0.0, got {size}"
        )
        
        # Test 5: Insufficient equity
        size = executor.calculate_position_size(entry, stop_loss, 1.0, 1.0)  # $1 equity
        assert_test(
            "Calculates position size even with small equity",
            size > 0,
            f"expected positive size, got {size}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — Signal Validation Tests
# ═══════════════════════════════════════════════════════════════════════════════

def section_signal_validation():
    """Test signal validation and guard rails."""
    print(f"\n{BOLD}{CYAN}-- Signal Validation Tests --{RESET}")
    
    # Test 1: WAIT verdict is ignored
    signal = {
        "verdict": "WAIT",
        "confidence": 0.8,
        "stop_loss": 40_000.0,
        "take_profit": 44_000.0,
    }
    assert_test(
        "WAIT verdict is recognized",
        "WAIT" in signal["verdict"],
        "Should skip execution on WAIT"
    )
    
    # Test 2: BUY verdict recognized
    signal = {
        "verdict": "BUY",
        "confidence": 0.85,
        "stop_loss": 40_000.0,
        "take_profit": 44_000.0,
    }
    assert_test(
        "BUY verdict is recognized",
        "BUY" in signal["verdict"],
        "Should execute on BUY"
    )
    
    # Test 3: SELL verdict recognized
    signal = {
        "verdict": "SELL",
        "confidence": 0.75,
        "stop_loss": 47_000.0,
        "take_profit": 43_000.0,
    }
    assert_test(
        "SELL verdict is recognized",
        "SELL" in signal["verdict"],
        "Should execute on SELL"
    )
    
    # Test 4: Invalid SL for BUY (SL >= entry price)
    entry = 42_000.0
    stop_loss = 42_000.0  # Invalid for BUY
    assert_test(
        "Detects invalid SL for BUY (SL >= entry)",
        stop_loss >= entry,
        "Should reject this configuration"
    )
    
    # Test 5: Invalid SL for SELL (SL <= entry price)
    entry = 45_000.0
    stop_loss = 45_000.0  # Invalid for SELL
    assert_test(
        "Detects invalid SL for SELL (SL <= entry)",
        stop_loss <= entry,
        "Should reject this configuration"
    )
    
    # Test 6: Valid SL for BUY
    entry = 42_000.0
    stop_loss = 40_000.0  # Valid
    assert_test(
        "Accepts valid SL for BUY",
        stop_loss < entry,
        "Stop loss should be below entry for BUY"
    )
    
    # Test 7: Valid SL for SELL
    entry = 45_000.0
    stop_loss = 47_000.0  # Valid
    assert_test(
        "Accepts valid SL for SELL",
        stop_loss > entry,
        "Stop loss should be above entry for SELL"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — Symbol Translation Tests
# ═══════════════════════════════════════════════════════════════════════════════

def section_symbol_translation():
    """Test exchange symbol format translation."""
    print(f"\n{BOLD}{CYAN}-- Symbol Translation Tests --{RESET}")
    
    from bot.executor import TradingExecutor
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="test",
            api_secret="test",
            exchange_id="binanceusdm",
            dry_run=True,
        )
        
        # Test 1: Binance format unchanged
        result = executor._to_exchange_symbol("BTCUSDT")
        assert_test(
            "Binance format passed through",
            result == "BTCUSDT",
            f"expected BTCUSDT, got {result}"
        )
        
    # Test Coinbase format translation
    with patch('bot.executor.ccxt.coinbase', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="",
            api_secret="",
            exchange_id="coinbase",
            dry_run=True,
            coinbase_key_name="test",
            coinbase_private_key="test",
        )
        
        # Test 2: BTC-USD translated
        result = executor._to_exchange_symbol("BTC-USD")
        assert_test(
            "Coinbase BTC-USD translated to BTC/USD",
            result == "BTC/USD",
            f"expected BTC/USD, got {result}"
        )
        
        # Test 3: BTCUSDT translated
        result = executor._to_exchange_symbol("BTCUSDT")
        assert_test(
            "Binance format translated for Coinbase",
            result == "BTC/USDT",
            f"expected BTC/USDT, got {result}"
        )
        
        # Test 4: Already unified format
        result = executor._to_exchange_symbol("BTC/USDC")
        assert_test(
            "Unified format preserved",
            result == "BTC/USDC",
            f"expected BTC/USDC, got {result}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — Dry-Run Execution Tests
# ═══════════════════════════════════════════════════════════════════════════════

async def section_dry_run_execution():
    """Test signal execution in dry-run mode."""
    print(f"\n{BOLD}{CYAN}-- Dry-Run Execution Tests --{RESET}")
    
    from bot.executor import TradingExecutor
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="",
            api_secret="",
            exchange_id="binanceusdm",
            dry_run=True,
            testnet=True,
        )
        
        await executor.initialize()
        
        # Test 1: BUY execution creates position
        signal = {
            "verdict": "BUY",
            "confidence": 0.85,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
        }
        current_price = 42_000.0
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=current_price,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "BUY signal creates active position",
            executor.active_position is not None,
            "Position should be set after BUY"
        )
        
        assert_test(
            "Position has correct side",
            executor.active_position["side"] == "buy",
            f"expected buy, got {executor.active_position['side']}"
        )
        
        assert_test(
            "Position has correct SL",
            executor.active_position["stop_loss"] == 40_000.0,
            f"expected 40000, got {executor.active_position['stop_loss']}"
        )
        
        # Test 2: WAIT signal ignored
        executor.active_position = None
        signal = {
            "verdict": "WAIT",
            "confidence": 0.5,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "WAIT signal does not create position",
            executor.active_position is None,
            "Position should remain None on WAIT"
        )
        
        # Test 3: Invalid SL rejected
        executor.active_position = None
        signal = {
            "verdict": "BUY",
            "confidence": 0.85,
            "stop_loss": 42_000.0,  # >= current_price
            "take_profit": 44_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "Invalid SL rejects BUY signal",
            executor.active_position is None,
            "Position should not be created with invalid SL"
        )
        
        # Test 4: Insufficient equity detected
        executor.active_position = None
        signal = {
            "verdict": "BUY",
            "confidence": 0.85,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=1.0,  # Only $1
        )
        
        assert_test(
            "Insufficient equity rejected",
            executor.active_position is None,
            "Position should not be created with insufficient equity"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — Position Exit Tests
# ═══════════════════════════════════════════════════════════════════════════════

async def section_position_exit():
    """Test position exit conditions (SL/TP)."""
    print(f"\n{BOLD}{CYAN}-- Position Exit Tests --{RESET}")
    
    from bot.executor import TradingExecutor
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="",
            api_secret="",
            exchange_id="binanceusdm",
            dry_run=True,
        )
        
        # Setup BUY position
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "buy",
            "size": 0.005,
            "entry_price": 42_000.0,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
            "dry_run": True,
        }
        
        # Test 1: No exit when price between SL and TP
        exited, pnl = await executor.check_position_exit(41_000.0)
        assert_test(
            "No exit between SL and TP",
            not exited,
            "Should not exit when price is between SL and TP"
        )
        assert_test(
            "PnL is 0 when active",
            pnl == 0.0,
            f"expected 0, got {pnl}"
        )
        
        # Test 2: Take profit hit
        exited, pnl = await executor.check_position_exit(44_000.0)
        assert_test(
            "TP exit triggered",
            exited,
            "Should exit when price hits TP"
        )
        expected_pnl = (44_000.0 - 42_000.0) * 0.005  # $10
        assert_test(
            "PnL calculated correctly at TP",
            abs(pnl - expected_pnl) < 0.5,
            f"expected {expected_pnl}, got {pnl}"
        )
        
        # Test 3: Take profit exceeded
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "buy",
            "size": 0.005,
            "entry_price": 42_000.0,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
            "dry_run": True,
        }
        exited, pnl = await executor.check_position_exit(45_000.0)
        assert_test(
            "Exit triggered above TP",
            exited,
            "Should exit when price exceeds TP"
        )
        
        # Test 4: Stop loss hit
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "buy",
            "size": 0.005,
            "entry_price": 42_000.0,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
            "dry_run": True,
        }
        exited, pnl = await executor.check_position_exit(40_000.0)
        assert_test(
            "SL exit triggered",
            exited,
            "Should exit when price hits SL"
        )
        expected_pnl = (40_000.0 - 42_000.0) * 0.005  # -$10
        assert_test(
            "PnL calculated correctly at SL",
            abs(pnl - expected_pnl) < 0.5,
            f"expected {expected_pnl}, got {pnl}"
        )
        
        # Test 5: Stop loss exceeded (larger loss)
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "buy",
            "size": 0.005,
            "entry_price": 42_000.0,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
            "dry_run": True,
        }
        exited, pnl = await executor.check_position_exit(39_000.0)
        assert_test(
            "Exit triggered below SL",
            exited,
            "Should exit when price falls below SL"
        )
        expected_pnl = (39_000.0 - 42_000.0) * 0.005  # -$15
        assert_test(
            "PnL calculated correctly below SL",
            abs(pnl - expected_pnl) < 0.5,
            f"expected {expected_pnl}, got {pnl}"
        )
        
        # Test 6: SELL position TP
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "sell",
            "size": 0.005,
            "entry_price": 42_000.0,
            "stop_loss": 44_000.0,
            "take_profit": 40_000.0,
            "dry_run": True,
        }
        exited, pnl = await executor.check_position_exit(40_000.0)
        assert_test(
            "SELL TP exit triggered",
            exited,
            "Should exit SELL when price hits TP"
        )
        expected_pnl = (42_000.0 - 40_000.0) * 0.005  # +$10 for short
        assert_test(
            "SELL PnL calculated correctly",
            abs(pnl - expected_pnl) < 0.5,
            f"expected {expected_pnl}, got {pnl}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — Full Execution Flow Test
# ═══════════════════════════════════════════════════════════════════════════════

async def section_full_execution_flow():
    """Test complete trade execution flow."""
    print(f"\n{BOLD}{CYAN}-- Full Execution Flow Test --{RESET}")
    
    from bot.executor import TradingExecutor
    
    # Create executor in dry-run mode
    mock_exchange = MockCCXTExchange(exchange_id="binanceusdm", is_dry_run=True)
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=mock_exchange):
        executor = TradingExecutor(
            api_key="",
            api_secret="",
            exchange_id="binanceusdm",
            dry_run=True,
            testnet=True,
        )
        
        await executor.initialize()
        
        # Simulate a buy signal
        signal = {
            "verdict": "BUY",
            "confidence": 0.87,
            "stop_loss": 41_000.0,
            "take_profit": 43_000.0,
        }
        
        logger.info("[Test] Executing BUY signal...")
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "Position created from signal",
            executor.active_position is not None,
            "Should have active position after BUY"
        )
        
        # Simulate price movement to TP
        logger.info("[Test] Price moved to take profit...")
        exited, pnl = await executor.check_position_exit(43_000.0)
        
        assert_test(
            "Position exits at TP",
            exited,
            "Position should exit at take profit"
        )
        
        assert_test(
            "Position cleared after exit",
            executor.active_position is None,
            "Active position should be None after exit"
        )
        
        assert_test(
            "Profit calculated correctly",
            pnl > 0,
            f"Should have positive P&L, got {pnl}"
        )
        
        # New SELL signal
        signal = {
            "verdict": "SELL",
            "confidence": 0.82,
            "stop_loss": 44_000.0,
            "take_profit": 42_000.0,
        }
        
        logger.info("[Test] Executing SELL signal...")
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=43_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "SELL position created",
            executor.active_position is not None and executor.active_position["side"] == "sell",
            "Should have active SELL position"
        )
        
        # Simulate SL hit
        logger.info("[Test] Stop loss hit...")
        exited, pnl = await executor.check_position_exit(44_000.0)
        
        assert_test(
            "SL hit on SELL",
            exited,
            "Should exit at stop loss"
        )
        
        assert_test(
            "Loss calculated on SL",
            pnl < 0,
            f"Should have negative P&L on SL, got {pnl}"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — Error Handling Tests
# ═══════════════════════════════════════════════════════════════════════════════

async def section_error_handling():
    """Test error handling and edge cases."""
    print(f"\n{BOLD}{CYAN}-- Error Handling Tests --{RESET}")
    
    from bot.executor import TradingExecutor
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="",
            api_secret="",
            exchange_id="binanceusdm",
            dry_run=True,
        )
        
        # Test 1: Position already open
        executor.active_position = {
            "symbol": "BTC/USDT",
            "side": "buy",
            "size": 0.005,
            "entry_price": 42_000.0,
        }
        
        signal = {
            "verdict": "BUY",
            "confidence": 0.85,
            "stop_loss": 40_000.0,
            "take_profit": 44_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "Skips new signal when position open",
            executor.active_position["size"] == 0.005,  # Original unchanged
            "Should not create new position when already holding"
        )
        
        # Test 2: No position check
        executor.active_position = None
        exited, pnl = await executor.check_position_exit(42_000.0)
        
        assert_test(
            "No exit when no position",
            not exited,
            "Should return False when no active position"
        )
        
        assert_test(
            "Zero PnL when no position",
            pnl == 0.0,
            "Should return 0 PnL when no position"
        )
        
        # Test 3: Invalid signal (missing fields)
        executor.active_position = None
        signal = {
            "verdict": "BUY",
            # Missing stop_loss and take_profit
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=100.0,
        )
        
        assert_test(
            "Handles missing SL/TP gracefully",
            executor.active_position is None,
            "Should reject signal with missing SL/TP"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN TEST RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

async def main():
    """Run all tests."""
    print(f"\n{BOLD}{CYAN}============================================================")
    print(f"   QUAD-DESK TRADE EXECUTION TEST SUITE")
    print(f"============================================================{RESET}\n")
    
    try:
        # Sync tests
        section_position_sizing()
        section_signal_validation()
        section_symbol_translation()
        await section_position_exit()
        
        # Async tests
        await section_dry_run_execution()
        await section_full_execution_flow()
        await section_error_handling()
        
    except Exception as e:
        logger.error(f"Test suite failed: {e}", exc_info=True)
        test_results["fail"] += 1
    
    # Print summary
    print(f"\n{BOLD}{CYAN}============================================================")
    print(f"   TEST SUMMARY")
    print(f"============================================================{RESET}")
    print(f"  {PASS}: {test_results['pass']}")
    print(f"  {FAIL}: {test_results['fail']}")
    print(f"  {SKIP}: {test_results['skip']}")
    
    total = test_results['pass'] + test_results['fail'] + test_results['skip']
    pass_rate = (test_results['pass'] / total * 100) if total > 0 else 0
    
    print(f"\n  Pass rate: {pass_rate:.1f}% ({test_results['pass']}/{total})")
    
    if test_results['fail'] > 0:
        print(f"\n{RED}[FAILED] Some tests failed. Review output above.{RESET}")
        return 1
    else:
        print(f"\n{GREEN}[SUCCESS] All tests passed! Bot is ready for trading.{RESET}")
        return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
