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


def init_firebase() -> Optional[Any]:
    """
    Initialise Firebase Admin SDK.
    Returns a Firestore client on success, None on any failure.
    """
    global _db
    cred_json = os.environ.get("FIREBASE_ADMIN_CREDENTIALS", "").strip()
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
        if not firebase_admin._apps:
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)

        _db = fs.client()
        logger.info("[Heartbeat] Firebase connected ✓ — dashboard sync active.")
        return _db

    except json.JSONDecodeError:
        logger.error("[Heartbeat] FIREBASE_ADMIN_CREDENTIALS is not valid JSON.")
    except Exception as e:
        logger.error(f"[Heartbeat] Firebase init failed: {e}")
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
        self.log_queue = queue.Queue()
        self.worker_thread = threading.Thread(target=self._log_worker, daemon=True)
        self.worker_thread.start()

    def _log_worker(self):
        while True:
            try:
                record = self.log_queue.get()
                if record is None:
                    break
                    
                if _db is None:
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
                self.log_queue.task_done()
            except Exception:
                # Silently catch errors so logs do not crash the worker thread
                pass
                
    def emit(self, record):
        # We only care about root logger outputs from the bot strategies
        # (mostly from main.py, quant_engine, and executor)
        if record.name.startswith("bot.") or record.name == "__main__":
            self.log_queue.put(record)


def get_db() -> Optional[Any]:
    """Return the initialised Firestore client (or None if not available)."""
    return _db


async def run_heartbeat(stats: dict) -> None:
    """
    Continuously writes bot status to Firestore every 10 s.
    `stats` is a shared dict mutated by the main execution loop.
    Gracefully exits if Firebase is not initialised.
    """
    if _db is None:
        return

    from firebase_admin import firestore as fs
    doc_ref = _db.collection("botStatus").document("live")

    while True:
        try:
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
            logger.error(f"[Heartbeat] Firebase sync error: {e}")

        try:
            await asyncio.sleep(10)
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
