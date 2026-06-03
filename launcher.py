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

print(f"[Launcher] Starting {len(SYMBOLS)} bot instance(s): {', '.join(SYMBOLS)}", flush=True)

# ── Process registry ──────────────────────────────────────────────────────────
_processes: list[subprocess.Popen] = []
_shutdown_event = threading.Event()


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
for sym in SYMBOLS:
    _processes.append(_start_bot(sym))
    # Small stagger so all bots don't hit Binance REST at the exact same instant
    time.sleep(2)


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
