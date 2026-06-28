"""
Global risk helpers for multi-symbol launcher deployments.

Launch-time validation + runtime cross-process exposure halt.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

RISK_DIR = Path(os.environ.get("GLOBAL_RISK_DIR", "/tmp/global_risk"))
RISK_DIR.mkdir(parents=True, exist_ok=True)
STALE_AFTER_S = 30


@dataclass(frozen=True)
class GlobalRiskConfig:
    max_symbols: int
    max_total_risk_pct: float
    per_symbol_risk_pct: float


def load_global_risk_config() -> GlobalRiskConfig:
    return GlobalRiskConfig(
        max_symbols=int(os.environ.get("BOT_MAX_SYMBOLS", "3")),
        max_total_risk_pct=float(os.environ.get("BOT_GLOBAL_MAX_RISK_PCT", "2.0")),
        per_symbol_risk_pct=float(os.environ.get("BOT_MAX_RISK_PCT", "1.0")),
    )


def validate_symbols_against_global_risk(symbols: list[str], cfg: GlobalRiskConfig | None = None) -> None:
    cfg = cfg or load_global_risk_config()
    if not symbols:
        raise ValueError("No symbols configured.")
    if len(symbols) > cfg.max_symbols:
        raise ValueError(
            f"BOT_SYMBOLS has {len(symbols)} symbols but BOT_MAX_SYMBOLS={cfg.max_symbols}."
        )
    aggregate_risk = len(symbols) * cfg.per_symbol_risk_pct
    if aggregate_risk > cfg.max_total_risk_pct:
        raise ValueError(
            f"Aggregate configured risk {aggregate_risk:.2f}% exceeds "
            f"BOT_GLOBAL_MAX_RISK_PCT={cfg.max_total_risk_pct:.2f}% "
            f"({len(symbols)} symbols x {cfg.per_symbol_risk_pct:.2f}%)."
        )


# D FIX: Runtime cross-process exposure tracking.
# Each bot instance writes its realized drawdown to a shared /tmp file.
# check_aggregate_exposure_or_halt() is called before every new order to
# prevent aggregate drawdown from exceeding the global cap across processes.

def publish_exposure(symbol: str, unrealized_pnl_pct: float, realized_dd_pct: float) -> None:
    """Write this symbol's exposure to a shared file for cross-process aggregation."""
    (RISK_DIR / f"{symbol.replace('/', '_')}.json").write_text(json.dumps({
        "symbol": symbol,
        "unrealized_pnl_pct": unrealized_pnl_pct,
        "realized_dd_pct": realized_dd_pct,
        "ts": time.time(),
    }))


def check_aggregate_exposure_or_halt(cfg: GlobalRiskConfig = None) -> bool:
    """Return True if aggregate realized drawdown across all processes exceeds cap.
    
    Stale files (>STALE_AFTER_S old) are ignored — dead processes don't count.
    """
    cfg = cfg or load_global_risk_config()
    now = time.time()
    total_dd = 0.0
    for path in RISK_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if now - data.get("ts", 0) > STALE_AFTER_S:
            continue
        total_dd += abs(data.get("realized_dd_pct", 0.0))
    if total_dd > cfg.max_total_risk_pct:
        (RISK_DIR / "HALT.flag").touch()
        return True
    return (RISK_DIR / "HALT.flag").exists()
