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
import asyncio
from pathlib import Path
from datetime import datetime

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

# ── Logging globals ───────────────────────────────────────────────────────────
LOG_FILE_PATH = Path("logs/launcher_combined.log")
LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
_log_lock = threading.Lock()


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
    Also append it to the shared log file.
    """
    assert proc.stdout is not None
    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip("\n").rstrip("\r")
            formatted = f"{prefix} {line}"
            print(formatted, flush=True)
            with _log_lock:
                with LOG_FILE_PATH.open("a", encoding="utf-8") as f:
                    f.write(formatted + "\n")
    except Exception:
        pass


def _start_bot(symbol: str) -> subprocess.Popen:
    """Launch a single bot subprocess for `symbol`."""
    # Inherit all current env vars but override the symbol-specific ones
    env = os.environ.copy()
    env["BOT_SYMBOL"] = symbol
    env["SEND_DAILY_LOG_TO_TELEGRAM"] = "false"  # Disable child bot log spam

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


def _log_delivery_worker():
    """Background thread that uploads the combined log to Telegram every 6 hours."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("[Launcher] Missing Telegram credentials, log delivery disabled.", flush=True)
        return
        
    # Lazy import to avoid circular dependencies
    from bot.notifier import Notifier
    notifier = Notifier(token, chat_id)
    
    interval_hours = max(0.25, float(os.environ.get("BOT_LOG_SEND_INTERVAL_HOURS", "6")))
    interval_seconds = int(interval_hours * 3600)
    print(f"[Launcher] Log delivery enabled every {interval_hours}h.", flush=True)
    
    async def upload_log():
        if not LOG_FILE_PATH.exists() or LOG_FILE_PATH.stat().st_size == 0:
            return
            
        # Safely copy and truncate the log
        with _log_lock:
            log_data = LOG_FILE_PATH.read_bytes()
            LOG_FILE_PATH.write_bytes(b"") # Truncate
            
        # If > 15MB, split into multiple parts
        MAX_BYTES = 15 * 1024 * 1024
        parts = [log_data[i:i + MAX_BYTES] for i in range(0, len(log_data), MAX_BYTES)]
        
        for i, part in enumerate(parts):
            part_path = Path(f"logs/launcher_upload_part{i+1}.log")
            part_path.write_bytes(part)
            caption = f"[LIVE] Quad Desk {len(SYMBOLS)} Pairs - Part {i+1}/{len(parts)} - {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            await notifier.send_document(str(part_path), caption=caption, critical=True)
            try:
                part_path.unlink()
            except OSError:
                pass
                
    while not _shutdown_event.is_set():
        # Sleep in small increments to allow fast shutdown
        for _ in range(interval_seconds):
            if _shutdown_event.is_set():
                return
            time.sleep(1)
            
        try:
            asyncio.run(upload_log())
        except Exception as e:
            print(f"[Launcher] Log upload failed: {e}", flush=True)

# ── Register signal handlers ──────────────────────────────────────────────────
signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT,  _shutdown)

# ── Launch all bots ───────────────────────────────────────────────────────────
_STARTUP_STAGGER_S = 30
for i, sym in enumerate(SYMBOLS):
    _processes.append(_start_bot(sym))
    if i < len(SYMBOLS) - 1:
        print(f"[Launcher] Waiting {_STARTUP_STAGGER_S}s before next symbol to avoid rate limits…", flush=True)
        time.sleep(_STARTUP_STAGGER_S)

_log_thread = threading.Thread(target=_log_delivery_worker, daemon=True, name="launcher-log-delivery")
_log_thread.start()

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
