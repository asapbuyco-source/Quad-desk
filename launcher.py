"""
launcher.py
===========
Multi-coin orchestrator for Quad-Desk.

Reads BOT_SYMBOLS (comma-separated) from the environment and spawns an
independent `python -m bot.main` subprocess for every symbol.  All child
processes share the same Railway log stream; each line is prefixed with
[SYMBOL] so you can filter or grep easily.

Environment variables:
    BOT_SYMBOLS   — comma-separated list of trading pairs to run simultaneously.
                    Example: BTC/USDT,ETH/USDT,SOL/USDT
                    Falls back to BOT_SYMBOL (singular) if BOT_SYMBOLS is not set,
                    so existing single-coin deployments continue to work with zero
                    configuration changes.

Usage:
    python launcher.py          (reads BOT_SYMBOLS from env / .env file)
"""

import os
import sys
import signal
import threading
import subprocess
import time

from dotenv import load_dotenv
load_dotenv()
from bot.global_risk import validate_symbols_against_global_risk

# ── Resolve which symbols to run ─────────────────────────────────────────────
_multi   = os.environ.get("BOT_SYMBOLS", "").strip()
_single  = os.environ.get("BOT_SYMBOL",  "BTC/USDT").strip()

if _multi:
    SYMBOLS = [s.strip() for s in _multi.split(",") if s.strip()]
else:
    SYMBOLS = [_single]

if not SYMBOLS:
    print("[Launcher] ERROR: No symbols configured. Set BOT_SYMBOLS or BOT_SYMBOL.", flush=True)
    sys.exit(1)

try:
    validate_symbols_against_global_risk(SYMBOLS)
except ValueError as exc:
    print(f"[Launcher] GLOBAL RISK BLOCK: {exc}", flush=True)
    sys.exit(1)

print(f"[Launcher] Starting {len(SYMBOLS)} bot instance(s): {', '.join(SYMBOLS)}", flush=True)

# ── Process registry ──────────────────────────────────────────────────────────
_processes: list[subprocess.Popen] = []
_shutdown_event = threading.Event()


def _send_tg_alert(message: str) -> None:
    """Send a synchronous Telegram alert on deep crashes."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    import urllib.request
    import json
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": message}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def _stream_output(proc: subprocess.Popen, prefix: str) -> None:
    """
    Forward every stdout/stderr line from `proc` to our stdout,
    prepending `prefix` so multi-coin logs are easy to distinguish.
    """
    assert proc.stdout is not None
    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip("\n").rstrip("\r")
            print(f"{prefix} {line}", flush=True)
    except Exception:
        pass


def _start_bot(symbol: str) -> subprocess.Popen:
    """Launch a single bot subprocess for `symbol`."""
    # Inherit all current env vars but override the symbol-specific ones
    env = os.environ.copy()
    env["BOT_SYMBOL"] = symbol

    # Use a sanitised tag for log prefixing: BTC/USDT → [BTC/USDT]
    tag = f"[{symbol}]"

    proc = subprocess.Popen(
        [sys.executable, "-m", "bot.main"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,   # merge stderr → stdout so one stream covers both
        text=True,
        bufsize=1,                  # line-buffered
    )

    # Each process gets its own thread to drain its output pipe
    t = threading.Thread(
        target=_stream_output,
        args=(proc, tag),
        daemon=True,
        name=f"log-{symbol.replace('/', '')}",
    )
    t.start()

    print(f"[Launcher] [OK] Started {symbol} (PID {proc.pid})", flush=True)
    return proc


def _shutdown(signum, frame) -> None:
    """Gracefully terminate all child bots on SIGTERM / SIGINT."""
    print(f"\n[Launcher] Signal {signum} received — shutting down all bots…", flush=True)
    _shutdown_event.set()
    for proc in _processes:
        try:
            proc.terminate()
        except Exception:
            pass


# ── Register signal handlers ──────────────────────────────────────────────────
signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT,  _shutdown)


# ── Launch all bots ───────────────────────────────────────────────────────────
# Each bot instance makes ~10+ REST calls on startup (load_markets, historical
# candles, funding rate, positions, balance, open interest, klines, etc.).
# With 3 symbols that's 30+ concurrent calls — guaranteed HTTP 418 IP ban.
# A 30s stagger gives each bot time to complete its boot REST calls before
# the next one starts, keeping us under Binance's 1200 req/min hard limit.
_STARTUP_STAGGER_S = 30
for i, sym in enumerate(SYMBOLS):
    _processes.append(_start_bot(sym))
    if i < len(SYMBOLS) - 1:   # no sleep after the last symbol
        print(f"[Launcher] Waiting {_STARTUP_STAGGER_S}s before next symbol to avoid rate limits…", flush=True)
        time.sleep(_STARTUP_STAGGER_S)


# ── Monitor loop — restart any crashed child ──────────────────────────────────
RESTART_DELAY = 15  # seconds to wait before restarting a crashed bot

while not _shutdown_event.is_set():
    time.sleep(5)

    for i, proc in enumerate(_processes):
        if _shutdown_event.is_set():
            break

        ret = proc.poll()
        if ret is not None:
            sym = SYMBOLS[i]
            print(
                f"[Launcher] [WARN] {sym} exited with code {ret}. "
                f"Restarting in {RESTART_DELAY}s…",
                flush=True,
            )
            if ret != 0:
                # Alert the user to a deep crash
                _send_tg_alert(
                    f"🚨 **Quad-Desk Launcher Alert**\n\n"
                    f"The `{sym}` bot process crashed unexpectedly (Exit Code: {ret}).\n"
                    f"It will be auto-restarted in {RESTART_DELAY} seconds."
                )
            
            time.sleep(RESTART_DELAY)
            if not _shutdown_event.is_set():
                _processes[i] = _start_bot(sym)


# ── Wait for all children to finish ──────────────────────────────────────────
print("[Launcher] Waiting for all bot processes to terminate…", flush=True)
for proc in _processes:
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()

print("[Launcher] All bots stopped. Goodbye.", flush=True)
