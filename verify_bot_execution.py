#!/usr/bin/env python3
"""
Quick test verification script - Run this to verify bot execution works
Usage: python verify_bot_execution.py
"""

import subprocess
import sys
import time
from pathlib import Path

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def run_command(cmd, timeout=60):
    """Run a command and return success status."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=Path(__file__).parent
        )
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, "", "TIMEOUT"
    except Exception as e:
        return False, "", str(e)

def main():
    print(f"\n{BOLD}{CYAN}{'='*70}")
    print(f"   QUAD-DESK BOT EXECUTION VERIFICATION")
    print(f"{'='*70}{RESET}\n")
    
    tests = [
        {
            "name": "Unit Tests (Position Sizing, Signal Validation, etc.)",
            "cmd": "python test_trade_execution.py",
            "timeout": 60,
        },
        {
            "name": "E2E Integration Tests (Full Pipeline)",
            "cmd": "python test_integration_e2e.py",
            "timeout": 30,
        },
    ]
    
    results = []
    
    for i, test in enumerate(tests, 1):
        print(f"{BOLD}[{i}/{len(tests)}] {test['name']}{RESET}")
        print(f"    Running: {test['cmd']}")
        print()
        
        start_time = time.time()
        success, stdout, stderr = run_command(test['cmd'], timeout=test['timeout'])
        elapsed = time.time() - start_time
        
        # Extract summary from output
        summary_line = ""
        if "pass rate" in stdout.lower():
            for line in stdout.split('\n'):
                if "pass rate" in line.lower() or "PASS" in line:
                    summary_line = line.strip()
                    break
        
        if success:
            results.append(("✅", test['name'], f"{elapsed:.1f}s"))
            status = f"{GREEN}✅ PASSED{RESET}"
        else:
            results.append(("❌", test['name'], f"{elapsed:.1f}s"))
            status = f"{RED}❌ FAILED{RESET}"
            if "TIMEOUT" in stderr:
                status += f" (timeout after {test['timeout']}s)"
        
        print(f"    Status: {status}")
        if summary_line:
            print(f"    {summary_line}")
        print()
    
    # Summary
    print(f"{BOLD}{CYAN}{'='*70}")
    print(f"   VERIFICATION SUMMARY")
    print(f"{'='*70}{RESET}\n")
    
    for status, name, duration in results:
        status_symbol = status
        if "✅" in status:
            print(f"  {status} {name} ({duration})")
        else:
            print(f"  {status} {name} ({duration})")
    
    passed = sum(1 for s, _, _ in results if "✅" in s)
    total = len(results)
    
    print(f"\n  Total: {passed}/{total} test suites passed")
    
    if passed == total:
        print(f"\n{GREEN}{BOLD}✅ ALL TESTS PASSED - BOT IS READY!{RESET}")
        print(f"\n{CYAN}Next steps:{RESET}")
        print(f"  1. Review TEST_SUITE_DOCUMENTATION.md for detailed results")
        print(f"  2. Set up Binance testnet credentials for live testing")
        print(f"  3. Run: python -m bot.main (with BOT_TESTNET=true)")
        return 0
    else:
        print(f"\n{RED}{BOLD}❌ SOME TESTS FAILED - REVIEW OUTPUT ABOVE{RESET}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
