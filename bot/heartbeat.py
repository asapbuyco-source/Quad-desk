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
from typing import Optional, Any

logger = logging.getLogger(__name__)

# Module-level Firestore client (initialised once)
_db: Optional[Any] = None


def _normalize_pem(raw_key: str) -> str:
    """
    Normalize a PEM private key string from any storage encoding to a valid PEM.

    Environment variables can encode newlines as:
      - Literal \\n (single backslash-n, standard JSON)  → replace with \n
      - Literal \\\\n (double backslash-n, some CI/CD tools) → replace with \n
      - \\r\\n (Windows line endings)                     → replace with \n

    The 'InvalidData(InvalidPadding)' Firebase error is caused by a PEM key
    that has its header/footer on separate lines but the base64 body is a
    single long string (missing internal newlines). All three patterns above
    produce that broken structure if not normalized correctly.
    """
    # Step 1: collapse any double-escaped sequences first (\\\\n → \\n)
    key = raw_key.replace("\\\\n", "\n")
    # Step 2: replace remaining single-escaped (\\n → \n) and Windows (\\r\\n)
    key = key.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
    return key.strip()


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
                    time.sleep(1)
                    continue

                from firebase_admin import firestore as fs
                payload = {
                    "level": record.levelname,
                    "message": self.format(record),
                    "timestamp": fs.SERVER_TIMESTAMP,
                    "ts_ms": int(record.created * 1000)
                }
                _db.collection("botLogs").add(payload)
                self.log_queue.task_done()
            except Exception:
                # Silently catch errors so logs do not crash the worker thread
                pass
                
    def emit(self, record):
        # We only care about root logger outputs from the bot strategies
        # (mostly from main.py, quant_engine, and executor)
        if record.name.startswith("bot.") or record.name == "__main__":
            msg = record.getMessage()
            # Filter out high-frequency cyclic logs to stay under Firebase 20K/day free tier quota
            if record.levelno < logging.WARNING and (
                msg.startswith("[Metrics]") or msg.startswith("[Regime]") or 
                msg.startswith("[Sweep]") or msg.startswith("[MetaModel]") or 
                msg.startswith("[BayesFusion]") or msg.startswith("[SweepStrat]") or
                "[Main] WAIT" in msg or "strategy_analysis" in msg
            ):
                return
                
            try:
                self.log_queue.put_nowait(record)
            except queue.Full:
                pass # Silently drop logs under severe backpressure to protect memory


def get_db() -> Optional[Any]:
    """Return the initialised Firestore client (or None if not available)."""
    return _db


async def run_heartbeat(stats: dict) -> None:
    """
    Continuously writes bot status to Firestore every 60 s.
    `stats` is a shared dict mutated by the main execution loop.
    Gracefully exits if Firebase is not initialised.

    If Firebase was not available at startup (e.g. bad credentials), this
    function will retry initialisation every 5 minutes so a credential fix
    at runtime is picked up automatically without restarting the bot.
    """
    from firebase_admin import firestore as fs

    RETRY_INTERVAL   = 300   # seconds between init retries when _db is None
    WRITE_INTERVAL   = 60    # seconds between heartbeat writes
    retry_countdown  = 0

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
            }
            # firebase-admin is sync → run in a thread so we don't block the loop
            await asyncio.to_thread(doc_ref.set, payload)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"[Heartbeat] Firebase sync error (will retry): {e}")

        try:
            await asyncio.sleep(WRITE_INTERVAL)
        except asyncio.CancelledError:
            break


async def write_offline(stats: dict) -> None:
    """
    Writes a final 'bot stopped' document to Firestore on clean shutdown.
    Call this from the main finally block.
    """
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
