"""
bot/heartbeat.py
================
Writes the bot's live status to Firebase Firestore every 10 seconds.
The frontend dashboard listens to this document via onSnapshot to show
a real-time "VERIFIED ONLINE" indicator.

Required environment variable:
    FIREBASE_ADMIN_CREDENTIALS — the full JSON string of a Firebase
    service account key (download from Firebase Console →
    Project Settings → Service Accounts → Generate New Private Key).

If the variable is missing the heartbeat is silently skipped; the bot
continues to trade normally.
"""

import os
import json
import logging
import asyncio
import time as _time
from typing import Optional, Any

logger = logging.getLogger(__name__)

# Module-level Firestore client (initialised once)
_db: Optional[Any] = None

_LOCAL_STATS_PATH = "/tmp/quad_bot_stats.json"
_LOCAL_TRADES_PATH = "/tmp/quad_bot_trades.jsonl"
_write_buffer: list = []
_consecutive_failures: int = 0
_use_local_fallback: bool = False
MAX_BUFFER_SIZE = 500


def _buffered_append(entry: dict) -> None:
    """Append to write buffer with a size cap — drop oldest on overflow."""
    global _write_buffer
    if len(_write_buffer) >= MAX_BUFFER_SIZE:
        _write_buffer.pop(0)
    _write_buffer.append(entry)


def _normalize_pem(raw_key: str) -> str:
    """
    Normalize a PEM private key string from any storage encoding to a valid PEM.
    Includes handling for double-escaped newlines (\\\\n) and re-wrapping long
    base64 strings to 64 chars to avoid InvalidPadding errors in the cryptography lib.
    """
    if not raw_key: return ""

    # Step 1: Broad cleaning of escaping and quoting
    # Handle literal backslash-n, literal double-backslash-n, and true newlines
    key = str(raw_key).replace("\\\\n", "\n").replace("\\n", "\n")
    key = key.replace("\\r\\n", "\n").replace("\r\n", "\n").strip()
    key = key.strip('"').strip("'")

    # Step 2: Extract core body and headers
    lines = [l.strip() for l in key.splitlines() if l.strip()]
    if not lines: return ""

    header, footer = "", ""
    body_parts = []
    
    for l in lines:
        if "BEGIN" in l: 
            header = l
        elif "END" in l: 
            footer = l
        else:
            # [STRICTER] Base64 body should ONLY contain: A-Z, a-z, 0-9, +, /, and =
            # Any other characters (like backslashes or spaces) are artifacts.
            clean_part = "".join([c for c in l if c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="])
            if clean_part:
                body_parts.append(clean_part)

    if not header or not footer:
        return key

    # Step 3: Flatten body and re-wrap strictly at 64 chars
    full_body = "".join(body_parts).rstrip("=")

    # 1.6 FIX: Validate key body length before padding.
    # Firebase RSA-2048 private key body = ~1700 base64 chars.
    # A body under 200 chars is almost certainly truncated by the secret manager.
    body_len = len(full_body)
    if body_len < 200:
        logger.error(
            f"[Heartbeat] Private key body is only {body_len} chars — "
            "likely truncated by Railway/secret manager character limit. "
            "Firebase RSA keys require ~1700 base64 chars. "
            "Paste the FULL JSON file content as the env var value."
        )
        return ""  # Return empty; caller will skip Firebase init cleanly

    remainder = len(full_body) % 4
    if remainder == 2:
        full_body += "=="
    elif remainder == 3:
        full_body += "="
    elif remainder == 1:
        # remainder=1 is structurally invalid in base64 — key is definitely truncated.
        # Padding with '===' would produce a structurally valid but cryptographically
        # wrong key, hiding the real error. Fail loudly instead.
        logger.error(
            "[Heartbeat] Base64 body has remainder=1 — key is definitely truncated. "
            "Do NOT try to pad it. Store the COMPLETE JSON key as the env var."
        )
        return ""

    wrapped_body = [full_body[i:i+64] for i in range(0, len(full_body), 64)]

    final_pem = "\n".join([header] + wrapped_body + [footer])
    return final_pem



def _validate_pem(key: str) -> bool:
    """
    Quick structural validation of a PEM private key without full cryptographic
    loading. Checks that the key has a BEGIN header, END footer, and at least
    one line of base64-encoded content between them.
    Returns True if the key looks valid, False otherwise.
    """
    lines = [l.strip() for l in key.splitlines() if l.strip()]
    if len(lines) < 3:
        return False
    has_header = any("BEGIN" in l for l in lines)
    has_footer = any("END" in l for l in lines)
    has_body   = len(lines) >= 3  # at least header + 1 body line + footer
    return has_header and has_footer and has_body


def init_firebase() -> Optional[Any]:
    """
    Initialise Firebase Admin SDK.
    Returns a Firestore client on success, None on any failure.

    Credential source priority:
    1. FIREBASE_ADMIN_CREDENTIALS — full JSON string of service account key
    2. FIREBASE_CREDENTIALS        — legacy alias (same format)
    """
    global _db
    cred_json = (
        os.environ.get("FIREBASE_ADMIN_CREDENTIALS", "").strip() or
        os.environ.get("FIREBASE_CREDENTIALS", "").strip()
    )
    if not cred_json:
        logger.warning(
            "[Heartbeat] FIREBASE_ADMIN_CREDENTIALS not set — "
            "bot↔dashboard live sync is disabled."
        )
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs

        cred_dict = json.loads(cred_json)

        # ── Fix PEM newlines (the root cause of 'InvalidPadding') ──────────
        if "private_key" in cred_dict:
            raw = cred_dict["private_key"]
            normalized = _normalize_pem(raw)
            if not _validate_pem(normalized):
                logger.error(
                    "[Heartbeat] Firebase private_key PEM is malformed after normalization.\n"
                    "  → Re-export the service account JSON from Firebase Console and paste\n"
                    "    the raw file contents (not the escaped string) into FIREBASE_ADMIN_CREDENTIALS."
                )
                return None
            cred_dict["private_key"] = normalized

        if not firebase_admin._apps:
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)

        _db = fs.client()
        logger.info("[Heartbeat] Firebase connected ✓ — dashboard sync active.")
        return _db

    except json.JSONDecodeError:
        logger.error(
            "[Heartbeat] FIREBASE_ADMIN_CREDENTIALS is not valid JSON. "
            "Ensure the entire service account JSON is set as a single-line env var."
        )
    except Exception as e:
        logger.error(
            f"[Heartbeat] Firebase init failed: {e}\n"
            "  → Fix: Re-export the service account key from Firebase Console → "
            "Project Settings → Service Accounts → Generate New Private Key.\n"
            "  → Then set FIREBASE_ADMIN_CREDENTIALS to the full raw JSON content."
        )
    return None

import threading
import queue

class FirestoreLogHandler(logging.Handler):
    """
    A custom logging handler that forwards log records to the 'botLogs'
    Firestore collection asynchronously using a background thread.
    """
    def __init__(self):
        super().__init__()
        self.log_queue = queue.Queue(maxsize=500)
        self.worker_thread = threading.Thread(target=self._log_worker, daemon=True)
        self.worker_thread.start()

    def _log_worker(self):
        while True:
            try:
                record = self.log_queue.get()
                if record is None:
                    break
                    
                # Wait for Firebase to be initialised if it isn't yet (race condition fix)
                if _db is None:
                    import time
                    import queue
                    time.sleep(1)
                    try:
                        self.log_queue.put_nowait(record)
                    except queue.Full:
                        pass
                    self.log_queue.task_done()
                    continue

                from firebase_admin import firestore as fs
                payload = {
                    "level": record.levelname,
                    "message": self.format(record),
                    "timestamp": fs.SERVER_TIMESTAMP,
                    "ts_ms": int(record.created * 1000)
                }
                _db.collection("botLogs").add(payload)
            except Exception:
                # Silently catch errors so logs do not crash the worker thread
                pass
            finally:
                self.log_queue.task_done()
                
    def emit(self, record):
        # FIXED: Only forward ERROR+ to Firestore to stay under 20K/day quota.
        # WARNING and below stays in Railway/local logs only.
        # Errors (SL failures, order rejections, Firebase outages) still reach Firestore.
        if record.levelno < logging.ERROR:
            return
        if record.name.startswith("bot.") or record.name == "__main__":
            try:
                self.log_queue.put_nowait(record)
            except queue.Full:
                pass


def get_db() -> Optional[Any]:
    """Return the initialised Firestore client (or None if not available)."""
    return _db


async def _telegram_fallback_alert(token: str, chat_id: str) -> None:
    """
    H1 FIX: Fire-and-forget Telegram alert when Firebase goes dark.
    Uses a properly-managed AsyncClient context so connections are closed.
    """
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": (
                        "⚠️ Quad-Desk: Firebase is DARK\n"
                        "3 consecutive write failures.\n"
                        "Trade data → local /tmp fallback only.\n"
                        "Check Firestore quota or credentials."
                    )
                }
            )
    except Exception:
        pass


async def run_heartbeat(stats: dict) -> None:
    """
    Continuously writes bot status to Firestore every 60 s.
    `stats` is a shared dict mutated by the main execution loop.
    Gracefully exits if Firebase is not initialised.

    If Firebase was not available at startup (e.g. bad credentials), this
    function will retry initialisation every 5 minutes so a credential fix
    at runtime is picked up automatically without restarting the bot.

    PHASE-6.1: Batches writes to reduce Firestore usage. On 429 (quota exceeded),
    uses exponential backoff and falls back to local JSON when Firebase is
    consistently unavailable.
    """
    global _db, _write_buffer, _consecutive_failures, _use_local_fallback

    from firebase_admin import firestore as fs

    RETRY_INTERVAL   = 300   # seconds between init retries when _db is None
    WRITE_INTERVAL   = 60    # seconds between heartbeat writes
    BATCH_FLUSH_SECS = 300   # flush buffer to local JSON every 5 minutes
    retry_countdown  = 0
    last_batch_flush = 0.0
    backoff = 0

    while True:
        try:
            # ── Retry init if Firebase not yet connected ───────────────────
            if _db is None:
                if retry_countdown <= 0:
                    logger.info("[Heartbeat] Retrying Firebase initialisation…")
                    init_firebase()
                    retry_countdown = RETRY_INTERVAL
                else:
                    retry_countdown -= WRITE_INTERVAL
                await asyncio.sleep(WRITE_INTERVAL)
                continue

            doc_ref = _db.collection("botStatus").document("live")
            payload = {
                "isRunning":       True,
                "lastHeartbeat":   fs.SERVER_TIMESTAMP,
                "symbol":          stats.get("symbol",         "UNKNOWN"),
                "mode":            stats.get("mode",           "DRY-RUN"),
                "environment":     stats.get("environment",    "TESTNET"),
                "activePositions": 1 if stats.get("active_position") else 0,
                "totalTrades":     stats.get("total_trades",  0),
                "lastSignal":      stats.get("last_signal",   "WAIT"),
                "exchange":        stats.get("exchange",       "coinbase").lower(),
                "lastUlis":        stats.get("last_ulis",      "—"),
                "sessionPnl":      stats.get("session_pnl",   0.0),
                "dailyPnl":        stats.get("daily_pnl",     0.0),
                "gateStats":       stats.get("gate_stats",    {}),
            }

            if _use_local_fallback:
                # BUG-6 FIX: Replace fs.SERVER_TIMESTAMP with numeric timestamp for JSON serialization
                status_doc = dict(payload)
                status_doc["lastHeartbeat"] = _time.time()
                status_doc["timestamp"] = _time.time()
                _buffered_append({"type": "status", **status_doc, "ts": _time.time()})
            else:
                try:
                    await asyncio.to_thread(doc_ref.set, payload)
                    _consecutive_failures = 0
                    if backoff > 0:
                        logger.info(f"[Heartbeat] Firebase recovered — backoff reset.")
                        backoff = 0
                except Exception as e:
                    _consecutive_failures += 1
                    logger.warning(f"[Heartbeat] Firebase write error: {e}")
                    if _consecutive_failures >= 3:
                        _use_local_fallback = True
                        logger.warning("[Heartbeat] 3 consecutive failures — switching to local JSON fallback.")
                        # FIXED: Alert operator that dashboard is dark
                        _tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
                        _tg_chat  = os.environ.get("TELEGRAM_CHAT_ID", "")
                        if _tg_token and _tg_chat:
                            try:
                                import httpx as _httpx
                                asyncio.create_task(
                                    _telegram_fallback_alert(_tg_token, _tg_chat)
                                )
                            except Exception:
                                pass
                    else:
                        backoff = min(backoff * 2 + 30, 300)
                        logger.info(f"[Heartbeat] Exponential backoff: {backoff}s")

            # 5.2: Equity curve time-series point (every heartbeat cycle)
            equity_doc = {
                "equity":     stats.get("account_equity", 0.0),
                "sessionPnl": stats.get("session_pnl",    0.0),
                "dailyPnl":   stats.get("daily_pnl",      0.0),
                "timestamp":  fs.SERVER_TIMESTAMP,
            }
            if _use_local_fallback:
                # BUG-6 FIX: Use numeric timestamp for JSON serialization
                equity_doc["timestamp"] = _time.time()
                _buffered_append({"type": "equity", **equity_doc, "ts": _time.time()})
            else:
                # P2-2 FIX: Day-bucketed documents instead of equity_ref.add() per minute.
                # Old: 1 new Firestore doc/minute = 86,400 docs after 60 days.
                # New: 1 doc/day with arrayUnion; merge=True creates doc if missing.
                try:
                    from datetime import datetime
                    _day_key = datetime.utcnow().strftime("%Y-%m-%d")
                    _equity_point = {k: v for k, v in equity_doc.items() if k != "timestamp"}
                    _equity_point["ts"] = _time.time()
                    _equity_day_ref = _db.collection("equityCurve").document(_day_key)
                    await asyncio.to_thread(
                        _equity_day_ref.set,
                        {"points": fs.ArrayUnion([_equity_point]), "date": _day_key},
                        True,
                    )
                except Exception as e:
                    _consecutive_failures += 1
                    logger.warning(f"[Heartbeat] Equity write error: {e}")

            # Flush buffer to local JSON every BATCH_FLUSH_SECS
            now = _time.time()
            if _use_local_fallback and _write_buffer and (now - last_batch_flush) >= BATCH_FLUSH_SECS:
                _flush_local_buffer()
                last_batch_flush = now

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"[Heartbeat] Firebase sync error (will retry): {e}")

        try:
            await asyncio.sleep(WRITE_INTERVAL)
        except asyncio.CancelledError:
            break


def _flush_local_buffer():
    """Write buffered entries to local JSON files."""
    global _write_buffer
    if not _write_buffer:
        return
    count = len(_write_buffer)
    try:
        with open(_LOCAL_STATS_PATH, "a") as f:
            for entry in _write_buffer:
                f.write(json.dumps(entry) + "\n")
        _write_buffer.clear()
        logger.info(f"[Heartbeat] Flushed {count} entries to {_LOCAL_STATS_PATH}")
    except Exception as e:
        logger.warning(f"[Heartbeat] Local JSON write failed: {e}")




async def write_offline(stats: dict) -> None:
    """
    Writes a final 'bot stopped' document to Firestore on clean shutdown.
    Call this from the main finally block.
    """
    global _write_buffer
    if _use_local_fallback and _write_buffer:
        _flush_local_buffer()

    if _db is None:
        return

    try:
        from firebase_admin import firestore as fs
        doc_ref = _db.collection("botStatus").document("live")
        await asyncio.to_thread(doc_ref.set, {
            "isRunning":       False,
            "lastHeartbeat":   fs.SERVER_TIMESTAMP,
            "symbol":          stats.get("symbol",       "UNKNOWN"),
            "mode":            stats.get("mode",         "DRY-RUN"),
            "environment":     stats.get("environment",  "TESTNET"),
            "activePositions": 0,
            "totalTrades":     stats.get("total_trades", 0),
            "lastSignal":      "BOT_STOPPED",
            "exchange":        stats.get("exchange",      "coinbase").lower(),
            "lastUlis":        "—",
        })
        logger.info("[Heartbeat] Offline status written to Firebase ✓")
    except Exception as e:
        logger.error(f"[Heartbeat] Offline write failed: {e}")
