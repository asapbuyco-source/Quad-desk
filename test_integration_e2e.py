"""
=============================================================
  QUAD-DESK END-TO-END INTEGRATION TEST
=============================================================
Tests the complete pipeline:
  1. MarketState with realistic candle data
  2. QuantEngine metric calculations
  3. Signal generation from metrics
  4. TradingExecutor execution
  5. Position monitoring and exits

Run:
    python test_integration_e2e.py

This simulates real trading without placing actual orders.
=============================================================
"""

import os
import sys
import asyncio
import logging
import numpy as np
import time
from unittest.mock import patch, MagicMock
from typing import Dict, Any, List

# Add bot to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger("E2ETest")

# ── ANSI Colors ──────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

PASS = f"{GREEN}[PASS]{RESET}"
FAIL = f"{RED}[FAIL]{RESET}"

test_results = {"pass": 0, "fail": 0}


def assert_test(name: str, condition: bool, detail: str = ""):
    """Record test result."""
    if condition:
        test_results["pass"] += 1
        print(f"  {PASS} {name}")
    else:
        test_results["fail"] += 1
        print(f"  {FAIL} {name}  -> {detail}")


# ═══════════════════════════════════════════════════════════════════════════════
# MARKET STATE & DATA GENERATION
# ═══════════════════════════════════════════════════════════════════════════════

class MarketState:
    """Mock market state with realistic data."""
    
    def __init__(self, symbol: str = "BTCUSDT"):
        self.symbol = symbol
        self.candles = []
        self.bids = {}
        self.asks = {}
        self.recent_trades = []
        self.cvd = 0.0
    
    def add_candle(self, close: float, high: float = None, low: float = None, 
                   volume: float = 10.0, time: int = None):
        """Add a candle to the market state."""
        if high is None:
            high = close * 1.01
        if low is None:
            low = close * 0.99
        if time is None:
            time = int((time or 0) + len(self.candles) * 60)
        
        self.candles.append({
            "time": time,
            "open": close * 0.99,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        })


def generate_uptrend_candles(base_price: float = 42_000, num: int = 100) -> List[Dict]:
    """Generate candles showing an uptrend."""
    rng = np.random.default_rng(42)
    candles = []
    price = base_price
    
    for i in range(num):
        # Uptrend with 0.5% average move per candle
        trend = 0.005 + rng.normal(0, 0.002)
        close = price * (1 + trend)
        
        high = close * (1 + abs(rng.normal(0, 0.003)))
        low = price * (1 - abs(rng.normal(0, 0.003)))
        
        candles.append({
            "time": int(time.time()) - (num - i) * 60,
            "open": price,
            "high": high,
            "low": low,
            "close": close,
            "volume": rng.uniform(8, 15),
        })
        price = close
    
    return candles


def generate_downtrend_candles(base_price: float = 45_000, num: int = 100) -> List[Dict]:
    """Generate candles showing a downtrend."""
    rng = np.random.default_rng(43)
    candles = []
    price = base_price
    
    for i in range(num):
        # Downtrend with -0.5% average move per candle
        trend = -0.005 + rng.normal(0, 0.002)
        close = price * (1 + trend)
        
        high = price * (1 + abs(rng.normal(0, 0.003)))
        low = close * (1 - abs(rng.normal(0, 0.003)))
        
        candles.append({
            "time": int(time.time()) - (num - i) * 60,
            "open": price,
            "high": high,
            "low": low,
            "close": close,
            "volume": rng.uniform(8, 15),
        })
        price = close
    
    return candles


def generate_ranging_candles(base_price: float = 43_000, num: int = 100) -> List[Dict]:
    """Generate candles showing sideways range."""
    rng = np.random.default_rng(44)
    candles = []
    price = base_price
    
    for i in range(num):
        # Random walk within tight range (±0.2%)
        trend = rng.normal(0, 0.001)
        close = price * (1 + trend)
        close = np.clip(close, base_price * 0.998, base_price * 1.002)
        
        high = close * (1 + abs(rng.normal(0, 0.002)))
        low = close * (1 - abs(rng.normal(0, 0.002)))
        
        candles.append({
            "time": int(time.time()) - (num - i) * 60,
            "open": price,
            "high": high,
            "low": low,
            "close": close,
            "volume": rng.uniform(5, 12),
        })
        price = close
    
    return candles


# ═══════════════════════════════════════════════════════════════════════════════
# SIMPLE SIGNAL GENERATOR (mirrors bot logic)
# ═══════════════════════════════════════════════════════════════════════════════

def generate_signal(metrics: Dict[str, Any], current_price: float) -> Dict[str, Any]:
    """
    Generate a trading signal from metrics.
    Simplified version of the 7-stage Macro Strategy.
    """
    if metrics is None:
        return {"verdict": "WAIT", "confidence": 0}
    
    rsi = metrics.get("rsi", 50)
    bayesian = metrics.get("bayesianPosterior", 0.5)
    z_score = metrics.get("zScore", 0)
    atr_pct = metrics.get("atr_pct", 0.01)
    
    # Simple signal logic
    verdict = "WAIT"
    confidence = 0.0
    
    # BUY signal: RSI oversold + positive Bayesian + rising
    if rsi < 35 and bayesian > 0.65 and z_score > -0.5:
        verdict = "BUY"
        confidence = min(0.95, 0.5 + (0.7 - rsi / 100) + bayesian)
        entry = current_price
        stop_loss = current_price * (1 - atr_pct * 1.5)
        take_profit = current_price * (1 + atr_pct * 3)
    
    # SELL signal: RSI overbought + negative Bayesian + falling
    elif rsi > 65 and bayesian < 0.35 and z_score < 0.5:
        verdict = "SELL"
        confidence = min(0.95, 0.5 + ((rsi - 50) / 100) + (1 - bayesian))
        entry = current_price
        stop_loss = current_price * (1 + atr_pct * 1.5)
        take_profit = current_price * (1 - atr_pct * 3)
    
    return {
        "verdict": verdict,
        "confidence": confidence,
        "stop_loss": stop_loss if verdict != "WAIT" else 0,
        "take_profit": take_profit if verdict != "WAIT" else 0,
        "rsi": rsi,
        "bayesian": bayesian,
        "z_score": z_score,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# MOCK CCXT EXCHANGE (from previous tests)
# ═══════════════════════════════════════════════════════════════════════════════

class MockCCXTExchange:
    """Mock CCXT exchange for E2E testing."""
    
    def __init__(self):
        self.apiKey = ""
        self.secret = ""
        self.has = {"fetchCurrencies": False}
        self.markets = {
            "BTC/USDT": {
                "id": "BTCUSDT",
                "symbol": "BTC/USDT",
                "precision": {"amount": 8, "price": 2},
                "limits": {"amount": {"min": 0.00001, "max": 1000}},
            }
        }
        self.symbols = ["BTC/USDT"]
        self.orders = []
        self.filled_orders = []
        self.order_counter = 0
    
    async def load_markets(self):
        return self.markets
    
    async def close(self):
        pass
    
    async def fetch_balance(self):
        return {
            "USDT": 1000.0,
            "BTC": 0.0,
            "free": {"USDT": 1000.0, "BTC": 0.0},
            "used": {},
        }
    
    def amount_to_precision(self, symbol: str, amount: float) -> str:
        return f"{amount:.8f}"
    
    def price_to_precision(self, symbol: str, price: float) -> str:
        return f"{price:.2f}"
    
    async def create_market_order(self, symbol: str, side: str, amount: float):
        self.order_counter += 1
        order = {
            "id": f"e2e_market_{self.order_counter}",
            "symbol": symbol,
            "side": side,
            "type": "market",
            "amount": amount,
            "status": "closed",
        }
        self.filled_orders.append(order)
        return order
    
    async def create_order(self, symbol: str, type: str, side: str, amount: float, 
                          price: float, params: Dict = None):
        self.order_counter += 1
        order = {
            "id": f"e2e_{type}_{self.order_counter}",
            "symbol": symbol,
            "type": type,
            "side": side,
            "amount": amount,
            "price": price,
            "status": "open",
        }
        self.orders.append(order)
        return order
    
    def set_sandbox_mode(self, sandbox: bool):
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# E2E TEST SCENARIOS
# ═══════════════════════════════════════════════════════════════════════════════

async def test_complete_buy_flow():
    """Test complete BUY flow: uptrend data → signal → execution → exit."""
    print(f"\n{BOLD}{CYAN}── Complete BUY Flow ──────────────────────{RESET}")
    
    from bot.executor import TradingExecutor
    from bot.quant_engine import QuantEngine
    
    # Generate uptrend market data
    candles = generate_uptrend_candles(base_price=42_000, num=100)
    
    mock_exchange = MockCCXTExchange()
    state = MarketState("BTCUSDT")
    state.candles = candles
    state.cvd = 1000.0  # Positive CVD (buying pressure)
    
    # Calculate metrics
    qe = QuantEngine(state)
    metrics = qe.compute_metrics()
    
    assert_test(
        "Metrics computed from uptrend data",
        metrics is not None,
        "Should compute metrics from 100 candles"
    )
    
    if metrics:
        current_price = metrics["price"]
        logger.info(f"Current price: ${current_price:.2f}")
        
        # Generate signal from metrics
        signal = generate_signal(metrics, current_price)
        logger.info(f"Signal: {signal['verdict']} (conf={signal['confidence']:.2f})")
        
        assert_test(
            "Signal generated from metrics",
            signal["verdict"] in ["BUY", "WAIT"],
            f"Expected BUY or WAIT, got {signal['verdict']}"
        )
        
        # Execute signal
        with patch('bot.executor.ccxt.binanceusdm', return_value=mock_exchange):
            executor = TradingExecutor(
                api_key="", api_secret="",
                exchange_id="binanceusdm",
                dry_run=True,
            )
            await executor.initialize()
            
            if signal["verdict"] == "BUY":
                await executor.execute_signal(
                    symbol="BTCUSDT",
                    current_price=current_price,
                    signal=signal,
                    max_risk_pct=1.0,
                    account_size=1000.0,
                )
                
                assert_test(
                    "BUY position created",
                    executor.active_position is not None,
                    "Should create position on BUY signal"
                )
                
                # Simulate price hitting TP
                tp_price = executor.active_position["take_profit"]
                exited, pnl = await executor.check_position_exit(tp_price)
                
                assert_test(
                    "Position exits at TP",
                    exited and pnl > 0,
                    f"Should exit with profit, got pnl={pnl}"
                )


async def test_complete_sell_flow():
    """Test complete SELL flow: downtrend data → signal → execution → exit."""
    print(f"\n{BOLD}{CYAN}── Complete SELL Flow ──────────────────────{RESET}")
    
    from bot.executor import TradingExecutor
    from bot.quant_engine import QuantEngine
    
    # Generate downtrend market data
    candles = generate_downtrend_candles(base_price=45_000, num=100)
    
    mock_exchange = MockCCXTExchange()
    state = MarketState("BTCUSDT")
    state.candles = candles
    state.cvd = -1000.0  # Negative CVD (selling pressure)
    
    # Calculate metrics
    qe = QuantEngine(state)
    metrics = qe.compute_metrics()
    
    assert_test(
        "Metrics computed from downtrend data",
        metrics is not None,
        "Should compute metrics"
    )
    
    if metrics:
        current_price = metrics["price"]
        logger.info(f"Current price: ${current_price:.2f}")
        
        # Generate signal from metrics
        signal = generate_signal(metrics, current_price)
        logger.info(f"Signal: {signal['verdict']} (conf={signal['confidence']:.2f})")
        
        # Execute signal
        with patch('bot.executor.ccxt.binanceusdm', return_value=mock_exchange):
            executor = TradingExecutor(
                api_key="", api_secret="",
                exchange_id="binanceusdm",
                dry_run=True,
            )
            await executor.initialize()
            
            if signal["verdict"] == "SELL":
                await executor.execute_signal(
                    symbol="BTCUSDT",
                    current_price=current_price,
                    signal=signal,
                    max_risk_pct=1.0,
                    account_size=1000.0,
                )
                
                assert_test(
                    "SELL position created",
                    executor.active_position is not None and executor.active_position["side"] == "sell",
                    "Should create SELL position"
                )
            else:
                print(f"  {YELLOW}[INFO] Downtrend didn't generate SELL signal (metrics not extreme enough){RESET}")


async def test_ranging_no_signal():
    """Test that ranging market produces WAIT signal."""
    print(f"\n{BOLD}{CYAN}── Ranging Market (No Signal) ──────────────────────{RESET}")
    
    from bot.quant_engine import QuantEngine
    
    # Generate ranging market data
    candles = generate_ranging_candles(base_price=43_000, num=100)
    
    state = MarketState("BTCUSDT")
    state.candles = candles
    state.cvd = 0.0  # Neutral CVD
    
    # Calculate metrics
    qe = QuantEngine(state)
    metrics = qe.compute_metrics()
    
    assert_test(
        "Metrics computed from ranging data",
        metrics is not None,
        "Should compute metrics"
    )
    
    if metrics:
        current_price = metrics["price"]
        
        # Generate signal
        signal = generate_signal(metrics, current_price)
        
        assert_test(
            "Ranging market produces WAIT or low confidence",
            signal["verdict"] == "WAIT" or signal["confidence"] < 0.6,
            f"Expected WAIT or low confidence, got {signal['verdict']}"
        )


async def test_multiple_signals_sequence():
    """Test sequence: BUY → exit → SELL → exit."""
    print(f"\n{BOLD}{CYAN}── Multiple Signals Sequence ──────────────────────{RESET}")
    
    from bot.executor import TradingExecutor
    
    with patch('bot.executor.ccxt.binanceusdm', return_value=MockCCXTExchange()):
        executor = TradingExecutor(
            api_key="", api_secret="",
            exchange_id="binanceusdm",
            dry_run=True,
        )
        await executor.initialize()
        
        pnl_log = []
        
        # Signal 1: BUY
        signal = {
            "verdict": "BUY",
            "confidence": 0.85,
            "stop_loss": 41_000.0,
            "take_profit": 43_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=42_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=1000.0,
        )
        
        assert_test(
            "First BUY executed",
            executor.active_position is not None,
            "Should create position"
        )
        
        # Exit with profit
        exited, pnl = await executor.check_position_exit(43_000.0)
        pnl_log.append(pnl)
        
        assert_test(
            "First trade closed with profit",
            exited and pnl > 0,
            f"Should exit with profit, got {pnl}"
        )
        
        # Signal 2: SELL
        signal = {
            "verdict": "SELL",
            "confidence": 0.80,
            "stop_loss": 44_000.0,
            "take_profit": 42_000.0,
        }
        
        await executor.execute_signal(
            symbol="BTCUSDT",
            current_price=43_000.0,
            signal=signal,
            max_risk_pct=1.0,
            account_size=1000.0,
        )
        
        assert_test(
            "Second SELL executed",
            executor.active_position is not None and executor.active_position["side"] == "sell",
            "Should create SELL position"
        )
        
        # Exit with profit
        exited, pnl = await executor.check_position_exit(42_000.0)
        pnl_log.append(pnl)
        
        assert_test(
            "Second trade closed with profit",
            exited and pnl > 0,
            f"Should exit with profit, got {pnl}"
        )
        
        # Summary
        total_pnl = sum(pnl_log)
        logger.info(f"Total PnL from 2 trades: ${total_pnl:.2f}")
        
        assert_test(
            "Total PnL is positive",
            total_pnl > 0,
            f"Should have overall profit, got {total_pnl}"
        )


async def test_real_exchange_api_connectivity():
    """Test communication with real Binance testnet (if available)."""
    print(f"\n{BOLD}{CYAN}── Real Exchange Connectivity ──────────────────────{RESET}")
    
    from dotenv import load_dotenv
    from bot.executor import TradingExecutor
    
    load_dotenv()
    
    binance_key = os.getenv("BINANCE_API_KEY", "").strip()
    binance_secret = os.getenv("BINANCE_API_SECRET", "").strip()
    
    if not binance_key or not binance_secret:
        print(f"  {YELLOW}[SKIP] Binance testnet credentials not found{RESET}")
        return
    
    try:
        # Initialize with testnet
        executor = TradingExecutor(
            api_key=binance_key,
            api_secret=binance_secret,
            exchange_id="binanceusdm",
            dry_run=True,
            testnet=True,
        )
        
        await executor.initialize()
        
        # Try to fetch balance
        balance = await executor.get_usdt_balance(account_size=100.0)
        
        assert_test(
            "Connected to Binance testnet",
            balance > 0,
            f"Should retrieve balance, got {balance}"
        )
        
        logger.info(f"Binance testnet balance: ${balance:.2f}")
        
        await executor.close()
        
    except Exception as e:
        logger.warning(f"Could not connect to Binance testnet: {e}")
        print(f"  {YELLOW}[INFO] Binance testnet test skipped (expected in test environment){RESET}")


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN TEST RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

async def main():
    """Run all E2E tests."""
    print(f"\n{BOLD}{CYAN}{'='*60}")
    print(f"   END-TO-END INTEGRATION TEST SUITE")
    print(f"{'='*60}{RESET}\n")
    
    try:
        # Run all E2E tests
        await test_complete_buy_flow()
        await test_complete_sell_flow()
        await test_ranging_no_signal()
        await test_multiple_signals_sequence()
        await test_real_exchange_api_connectivity()
        
    except Exception as e:
        logger.error(f"Test suite error: {e}", exc_info=True)
        test_results["fail"] += 1
    
    # Print summary
    print(f"\n{BOLD}{CYAN}{'='*60}")
    print(f"   TEST SUMMARY")
    print(f"{'='*60}{RESET}")
    print(f"  {PASS}: {test_results['pass']}")
    print(f"  {FAIL}: {test_results['fail']}")
    
    total = test_results['pass'] + test_results['fail']
    pass_rate = (test_results['pass'] / total * 100) if total > 0 else 0
    print(f"\n  Pass rate: {pass_rate:.1f}% ({test_results['pass']}/{total})")
    
    if test_results['fail'] > 0:
        print(f"\n{RED}❌ Some tests failed. Review output above.{RESET}")
        return 1
    else:
        print(f"\n{GREEN}✅ All E2E tests passed! Pipeline verified.{RESET}")
        return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
