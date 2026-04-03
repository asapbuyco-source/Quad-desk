#!/usr/bin/env python3
"""
Quick test to verify bot can execute trades on Coinbase.
Run this before going live.
"""

import asyncio
import os
import sys
from bot.executor import TradingExecutor

async def test_trading():
    print("=" * 60)
    print("TRADING BOT - CONNECTION & EXECUTION TEST")
    print("=" * 60)
    
    # Get credentials from environment
    key_name = os.getenv("COINBASE_API_KEY_NAME")
    private_key = os.getenv("COINBASE_PRIVATE_KEY")
    
    if not key_name or not private_key:
        print("❌ ERROR: Missing Coinbase credentials in environment variables")
        print("   Set COINBASE_API_KEY_NAME and COINBASE_PRIVATE_KEY")
        return False
    
    # Initialize executor (DRY-RUN by default for safety)
    print("\n[1/5] Initializing executor (DRY-RUN mode)...")
    executor = TradingExecutor(
        api_key="",
        api_secret="",
        exchange_id="coinbase",
        coinbase_key_name=key_name,
        coinbase_private_key=private_key,
        dry_run=True  # SAFE: No real orders
    )
    print("✅ Executor initialized")
    
    # Test 1: Check balance
    print("\n[2/5] Checking account balance...")
    try:
        usdc_balance = await executor.get_usdt_balance()
        btc_balance = await executor.get_balance("BTC")
        print(f"   USDC: ${usdc_balance:.2f}")
        print(f"   BTC: {btc_balance:.6f}")
        
        if usdc_balance < 1 and btc_balance < 0.00001:
            print("❌ ERROR: Insufficient balance (need >$1 USDC or >0.00001 BTC)")
            return False
        print("✅ Balance check passed")
    except Exception as e:
        print(f"❌ ERROR fetching balance: {e}")
        return False
    
    # Test 2: Check market data
    print("\n[3/5] Fetching market data...")
    try:
        price = await executor.get_current_price("BTC/USDC")
        print(f"   BTC/USDC price: ${price:.2f}")
        if price <= 0:
            print("❌ ERROR: Invalid price")
            return False
        print("✅ Market data OK")
    except Exception as e:
        print(f"❌ ERROR fetching price: {e}")
        return False
    
    # Test 3: Calculate position size
    print("\n[4/5] Testing position size calculation...")
    try:
        current_price = price
        stop_loss = price * 0.98  # 2% below
        raw_size = executor.calculate_position_size(
            current_price=current_price,
            stop_loss=stop_loss,
            equity=usdc_balance,
            max_risk_pct=1.0
        )
        print(f"   Current price: ${current_price:.2f}")
        print(f"   Stop loss: ${stop_loss:.2f}")
        print(f"   Position size: {raw_size:.6f} BTC")
        print(f"   Notional: ${raw_size * current_price:.2f}")
        
        if raw_size <= 0:
            print("❌ ERROR: Position size is 0")
            return False
        print("✅ Position sizing OK")
    except Exception as e:
        print(f"❌ ERROR calculating position: {e}")
        return False
    
    # Test 4: Test dry-run execution (safe, no real trade)
    print("\n[5/5] Testing DRY-RUN trade execution...")
    try:
        await executor.execute_signal(
            symbol="BTC-USDC",
            verdict="BUY",
            current_price=current_price,
            stop_loss=stop_loss,
            take_profit=current_price * 1.02,
            max_risk_pct=1.0,
            account_size=usdc_balance,
            ulis_verdict="LONG"
        )
        print("✅ DRY-RUN execution completed (no real orders placed)")
    except Exception as e:
        print(f"❌ ERROR in dry-run execution: {e}")
        return False
    
    # Summary
    print("\n" + "=" * 60)
    print("✅ ALL TESTS PASSED - BOT IS READY")
    print("=" * 60)
    print("\nNext steps:")
    print("  1. Review the DRY-RUN log output above")
    print("  2. Check Coinbase dashboard (no orders should appear)")
    print("  3. To enable LIVE trading, change dry_run=True → dry_run=False")
    print("  4. Monitor bot/main.py logs for real trades")
    print("\nTo run LIVE test:")
    print("  Edit bot/main.py:")
    print("    executor = TradingExecutor(..., dry_run=False)")
    print("  Then restart the bot")
    print("\n" + "=" * 60)
    
    return True

if __name__ == "__main__":
    success = asyncio.run(test_trading())
    sys.exit(0 if success else 1)
