"""
Global risk helpers for multi-symbol launcher deployments.

This module is intentionally lightweight: it validates launch-time exposure caps
before child bots start. Runtime cross-process coordination can build on this
without changing launcher semantics.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


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
