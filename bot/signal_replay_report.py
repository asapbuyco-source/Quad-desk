"""
Replay live/dry-run bot logs into a signal-edge report.

Usage:
    python -m bot.signal_replay_report C:\\path\\logs.json C:\\path\\logs.log
    python -m bot.signal_replay_report logs/*.log --out reports/replay.json --csv reports/replay.csv

The report is intentionally log-based: it validates what the deployed bot actually
did, including gate blocks, fills, partials, MFE/MAE observed in the log stream,
and final outcomes.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


SYMBOL_RE = re.compile(r"\b(BTC|ETH|SOL|BNB|AVAX|DOGE|PEPE|WIF|INJ|ARB|OP)[/-]?USDT(?::USDT)?\b", re.I)
TIME_RE = re.compile(r"(?P<h>\d{2}):(?P<m>\d{2}):(?P<s>\d{2})")
SIGNAL_RE = re.compile(
    r"\[Signal\]\s*>>\s*(?P<verdict>[A-Z_]+)\s*\|\s*conf=(?P<conf>\d+(?:\.\d+)?)%"
    r"\s*\|\s*SL=(?P<sl>[-+]?\d+(?:\.\d+)?)\s*TP=(?P<tp>[-+]?\d+(?:\.\d+)?)"
)
DRY_FILL_RE = re.compile(
    r"\[DRY-RUN\]\s+(?P<verdict>[A-Z_]+)\s+(?P<symbol>\S+)\s+\|\s+qty=(?P<size>[-+]?\d+(?:\.\d+)?)"
    r".*?\|\s+fill~(?P<fill>[-+]?\d+(?:\.\d+)?)"
)
LIVE_FILL_RE = re.compile(r"Fill price:\s*(?P<fill>[-+]?\d+(?:\.\d+)?)")
MARKET_RE = re.compile(r"Placing MARKET\s+(?P<side>BUY|SELL)\s+(?P<size>[-+]?\d+(?:\.\d+)?)\s+(?P<symbol>\S+)", re.I)
REGIME_RE = re.compile(
    r"\[Regime\]\s+(?P<regime>[A-Z_]+)\s+\|\s+Z=(?P<z>[-+]?\d+(?:\.\d+)?)"
    r"\s+\|\s+ATR%=(?P<atr_pct>[-+]?\d+(?:\.\d+)?)%"
)
HTF_RE = re.compile(r"\[HTF\]\s+4H trend = (?P<htf>[A-Z_]+)")
REGIME_PARAMS_RE = re.compile(
    r"\[RegimeParams\].*?min_conf=(?P<min_conf>\d+)%.*?rr=(?P<rr>[-+]?\d+(?:\.\d+)?)"
)
BAYES_RE = re.compile(r"\[BayesFusion\]\s+direction=(?P<direction>[A-Z_]+)\s+\|\s+P=(?P<bayes>[-+]?\d+(?:\.\d+)?)%")
MAIN_ANALYSIS_RE = re.compile(
    r"Regime=(?P<regime>[A-Z_]+)\s+Strategy=(?P<strategy>[A-Z_]+).*?"
    r"Z=(?P<z>[-+]?\d+(?:\.\d+)?).*?OFI=(?P<ofi>[-+]?\d+(?:\.\d+)?).*?"
    r"CVD=(?P<cvd>[-+]?\d+(?:\.\d+)?).*?ATR=(?P<atr>[-+]?\d+(?:\.\d+)?)"
)
EXIT_RE = re.compile(
    r"(?:Position flat on exchange|(?P<sim_type>SL|TP) HIT).*?(?:type=(?P<type>SL|TP))?"
    r".*?PnL=\$?(?P<pnl>[-+]?\d+(?:\.\d+)?)|pnl=\$?(?P<pnl2>[-+]?\d+(?:\.\d+)?)"
)
FILL_EXIT_RE = re.compile(r"fill=(?P<fill>[-+]?\d+(?:\.\d+)?)")
EXCHANGE_PNL_RE = re.compile(
    r"Exchange PnL:\s*(?:gross=\$?(?P<gross>[-+]?\d+(?:\.\d+)?)\s+fees=\$?(?P<fees>[-+]?\d+(?:\.\d+)?)\s+net=\$?(?P<net>[-+]?\d+(?:\.\d+)?)|\$?(?P<pnl>[-+]?\d+(?:\.\d+)?))\s+fill=(?P<fill>[-+]?\d+(?:\.\d+)?)",
    re.I,
)
PARTIAL_RE = re.compile(r"Partial TP logged: size=(?P<size>[-+]?\d+(?:\.\d+)?) @ (?P<price>[-+]?\d+(?:\.\d+)?) PnL=(?P<pnl>[-+]?\d+(?:\.\d+)?)")
PRICE_RE = re.compile(r"(?:price|mark|last|current_price)[=:]\s*(?P<price>[-+]?\d+(?:\.\d+)?)", re.I)
HIGH_RE = re.compile(r"(?:high|candle_high)[=:]\s*(?P<high>[-+]?\d+(?:\.\d+)?)", re.I)
LOW_RE = re.compile(r"(?:low|candle_low)[=:]\s*(?P<low>[-+]?\d+(?:\.\d+)?)", re.I)
HOLDING_RE = re.compile(
    r"HOLDING\s+(?P<side>BUY|SELL)\s+@\s*(?P<entry>[-+]?\d+(?:\.\d+)?)"
    r"\s*\|\s*now=(?P<now>[-+]?\d+(?:\.\d+)?)"
    r"\s*\|\s*PnL=(?P<pnl_pct>[-+]?\d+(?:\.\d+)?)%",
    re.I,
)


GATE_PATTERNS = {
    "bayes_floor_veto": "BAYES FLOOR HALT",
    "throughput_thin": "ThroughputGate",
    "htf_counter_trend": "__HTF_COUNTER__",
    "derivatives_veto": "DerivGate] VETO",
    "cvd_divergence_veto": "CVD divergence veto",
    "confidence_below_threshold": "regime threshold",
    "consecutive_loss_halt": "CONSECUTIVE LOSSES",
    "atr_panic_halt": "ATR PANIC HALT",
    "signal_none": "no edge",
    "time_exit": "TIME EXIT",
    "partial_tp": "PARTIAL TP",
    "orphan_position": "Orphan position detected",
    "stale_feed": "Candle feed STALE",
}


def _norm_symbol(raw: str | None) -> str:
    if not raw:
        return "UNKNOWN"
    m = SYMBOL_RE.search(raw.replace("/", "").replace(":", ""))
    if m:
        return f"{m.group(1).upper()}USDT"
    m = SYMBOL_RE.search(raw)
    if m:
        return f"{m.group(1).upper()}USDT"
    return raw.upper().replace("/", "").replace(":USDT", "")


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        value = str(value).replace("%", "").replace(",", "")
        return float(value)
    except (TypeError, ValueError):
        return default


def _read_json_log(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            data = data.get("logs") or data.get("entries") or data.get("data") or [data]
        rows = data if isinstance(data, list) else []
    except json.JSONDecodeError:
        rows = []
        for line in text.splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append({"message": line})
    out = []
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            row = {"message": str(row)}
        msg = row.get("message") or row.get("msg") or row.get("log") or row.get("text") or ""
        ts = row.get("timestamp") or row.get("time") or row.get("ts") or row.get("createdAt")
        out.append({"source": str(path), "idx": idx, "ts": ts, "message": str(msg)})
    return out


def _read_text_log(path: Path) -> list[dict[str, Any]]:
    rows = []
    for idx, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines()):
        rows.append({"source": str(path), "idx": idx, "ts": None, "message": line})
    return rows


def load_entries(paths: Iterable[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        if path.suffix.lower() == ".json":
            rows.extend(_read_json_log(path))
        else:
            rows.extend(_read_text_log(path))
    seen: set[tuple[str, str]] = set()
    deduped = []
    for row in rows:
        key = (str(row.get("ts") or ""), row["message"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


@dataclass
class Context:
    symbol: str = "UNKNOWN"
    regime: str = ""
    strategy: str = ""
    htf: str = ""
    z_score: float | None = None
    bayes: float | None = None
    cvd: float | None = None
    ofi: float | None = None
    atr: float | None = None
    atr_pct: float | None = None
    min_conf: float | None = None
    rr: float | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "regime": self.regime,
            "strategy": self.strategy,
            "htf": self.htf,
            "z_score": self.z_score,
            "bayes": self.bayes,
            "cvd": self.cvd,
            "ofi": self.ofi,
            "atr": self.atr,
            "atr_pct": self.atr_pct,
            "min_conf": self.min_conf,
            "rr": self.rr,
        }


@dataclass
class Trade:
    id: int
    symbol: str
    verdict: str
    side: str
    signal_ts: str
    confidence: float
    stop_loss: float
    take_profit: float
    context: dict[str, Any]
    entry_price: float | None = None
    size: float | None = None
    exit_ts: str | None = None
    exit_price: float | None = None
    pnl: float | None = None
    outcome: str = "OPEN"
    partials: list[dict[str, Any]] = field(default_factory=list)
    mfe_pct: float = 0.0
    mae_pct: float = 0.0
    mfe_r: float | None = None
    mae_r: float | None = None
    max_price: float | None = None
    min_price: float | None = None

    def update_price(self, price: float | None, high: float | None = None, low: float | None = None) -> None:
        if self.entry_price is None or self.outcome != "OPEN":
            return
        samples = [v for v in (price, high, low) if v and math.isfinite(v)]
        for sample in samples:
            self.max_price = sample if self.max_price is None else max(self.max_price, sample)
            self.min_price = sample if self.min_price is None else min(self.min_price, sample)
        if self.max_price is None or self.min_price is None:
            return
        if self.side == "buy":
            mfe = self.max_price - self.entry_price
            mae = self.min_price - self.entry_price
        else:
            mfe = self.entry_price - self.min_price
            mae = self.entry_price - self.max_price
        self.mfe_pct = 100.0 * mfe / self.entry_price
        self.mae_pct = 100.0 * mae / self.entry_price
        risk = abs(self.entry_price - self.stop_loss)
        if risk > 0:
            self.mfe_r = mfe / risk
            self.mae_r = mae / risk

    def as_dict(self) -> dict[str, Any]:
        data = {
            "id": self.id,
            "symbol": self.symbol,
            "verdict": self.verdict,
            "side": self.side,
            "signal_ts": self.signal_ts,
            "entry_price": self.entry_price,
            "size": self.size,
            "confidence": self.confidence,
            "stop_loss": self.stop_loss,
            "take_profit": self.take_profit,
            "exit_ts": self.exit_ts,
            "exit_price": self.exit_price,
            "pnl": self.pnl,
            "outcome": self.outcome,
            "mfe_pct": round(self.mfe_pct, 4),
            "mae_pct": round(self.mae_pct, 4),
            "mfe_r": round(self.mfe_r, 4) if self.mfe_r is not None else None,
            "mae_r": round(self.mae_r, 4) if self.mae_r is not None else None,
            "partials": self.partials,
        }
        data.update(self.context)
        return data


def _line_ts(row: dict[str, Any]) -> str:
    if row.get("ts"):
        return str(row["ts"])
    m = TIME_RE.search(row["message"])
    return m.group(0) if m else f"{Path(row['source']).name}#{row['idx']}"


def _update_context(ctx: Context, msg: str) -> None:
    sym = SYMBOL_RE.search(msg)
    if sym:
        ctx.symbol = _norm_symbol(sym.group(0))
    if m := REGIME_RE.search(msg):
        ctx.regime = m.group("regime")
        ctx.z_score = _to_float(m.group("z"))
        ctx.atr_pct = _to_float(m.group("atr_pct")) / 100.0
    if m := HTF_RE.search(msg):
        ctx.htf = m.group("htf")
    if m := REGIME_PARAMS_RE.search(msg):
        ctx.min_conf = _to_float(m.group("min_conf")) / 100.0
        ctx.rr = _to_float(m.group("rr"))
    if m := BAYES_RE.search(msg):
        ctx.bayes = _to_float(m.group("bayes")) / 100.0
    if m := MAIN_ANALYSIS_RE.search(msg):
        ctx.regime = m.group("regime")
        ctx.strategy = m.group("strategy")
        ctx.z_score = _to_float(m.group("z"))
        ctx.ofi = _to_float(m.group("ofi"))
        ctx.cvd = _to_float(m.group("cvd"))
        ctx.atr = _to_float(m.group("atr"))


def replay(entries: list[dict[str, Any]]) -> dict[str, Any]:
    ctx = Context()
    trades: list[Trade] = []
    open_by_symbol: dict[str, Trade] = {}
    pending_by_symbol: dict[str, Trade] = {}
    recently_closed_by_symbol: dict[str, Trade] = {}
    gate_counts: dict[str, Counter] = defaultdict(Counter)
    global_counts = Counter()

    for row in entries:
        msg = row["message"]
        _update_context(ctx, msg)
        symbol = ctx.symbol
        sym_match = SYMBOL_RE.search(msg)
        if sym_match:
            symbol = _norm_symbol(sym_match.group(0))

        for gate, marker in GATE_PATTERNS.items():
            if gate == "htf_counter_trend":
                matched_gate = (
                    "Blocking LONG trend trade" in msg
                    or "Blocking SHORT trend trade" in msg
                    or "BUY sweep BLOCKED" in msg
                    or "SELL sweep BLOCKED" in msg
                    or "HTF=BEAR blocks" in msg
                    or "HTF=BULL blocks" in msg
                )
            else:
                matched_gate = marker in msg
            if matched_gate:
                gate_counts[symbol][gate] += 1
                global_counts[gate] += 1

        if m := SIGNAL_RE.search(msg):
            verdict = m.group("verdict")
            side = "buy" if ("BUY" in verdict or "LONG" in verdict) else "sell"
            trade = Trade(
                id=len(trades) + 1,
                symbol=symbol,
                verdict=verdict,
                side=side,
                signal_ts=_line_ts(row),
                confidence=_to_float(m.group("conf")) / 100.0,
                stop_loss=_to_float(m.group("sl")),
                take_profit=_to_float(m.group("tp")),
                context=ctx.snapshot(),
            )
            pending_by_symbol[symbol] = trade
            trades.append(trade)
            continue

        if m := MARKET_RE.search(msg):
            symbol = _norm_symbol(m.group("symbol"))
            trade = pending_by_symbol.get(symbol) or next((t for t in reversed(trades) if t.outcome == "OPEN" and t.entry_price is None), None)
            if trade:
                trade.symbol = symbol
                trade.size = _to_float(m.group("size"))
            continue

        fill_match = DRY_FILL_RE.search(msg) or LIVE_FILL_RE.search(msg)
        if fill_match:
            symbol_from_fill = _norm_symbol(fill_match.groupdict().get("symbol") or symbol)
            trade = pending_by_symbol.pop(symbol_from_fill, None)
            if trade is None:
                trade = next((t for t in reversed(trades) if t.outcome == "OPEN" and t.entry_price is None), None)
            if trade:
                trade.symbol = symbol_from_fill if symbol_from_fill != "UNKNOWN" else trade.symbol
                trade.entry_price = _to_float(fill_match.group("fill"))
                if "size" in fill_match.groupdict():
                    trade.size = _to_float(fill_match.group("size"))
                trade.max_price = trade.entry_price
                trade.min_price = trade.entry_price
                open_by_symbol[trade.symbol] = trade
            continue

        price = _to_float((PRICE_RE.search(msg) or {}).group("price") if PRICE_RE.search(msg) else None, None)
        high = _to_float((HIGH_RE.search(msg) or {}).group("high") if HIGH_RE.search(msg) else None, None)
        low = _to_float((LOW_RE.search(msg) or {}).group("low") if LOW_RE.search(msg) else None, None)
        if price or high or low:
            targets = [open_by_symbol.get(symbol)] if symbol in open_by_symbol else list(open_by_symbol.values())
            for trade in targets:
                if trade:
                    trade.update_price(price, high, low)

        if m := PARTIAL_RE.search(msg):
            trade = open_by_symbol.get(symbol) or next((t for t in reversed(trades) if t.outcome == "OPEN"), None)
            if trade:
                trade.partials.append({
                    "ts": _line_ts(row),
                    "size": _to_float(m.group("size")),
                    "price": _to_float(m.group("price")),
                    "pnl": _to_float(m.group("pnl")),
                })
            continue

        if m := HOLDING_RE.search(msg):
            trade = open_by_symbol.get(symbol)
            if trade:
                if trade.entry_price is None:
                    trade.entry_price = _to_float(m.group("entry"))
                trade.update_price(_to_float(m.group("now")))
            continue

        if m := EXCHANGE_PNL_RE.search(msg):
            trade = recently_closed_by_symbol.get(symbol) or open_by_symbol.get(symbol)
            if trade:
                pnl = _to_float(m.group("net") or m.group("pnl"))
                fill = _to_float(m.group("fill"))
                trade.exit_ts = _line_ts(row)
                trade.exit_price = fill
                trade.pnl = pnl
                if trade.outcome in ("OPEN", "CLOSED"):
                    trade.outcome = "WIN" if pnl > 0 else "LOSS"
                trade.update_price(fill, fill, fill)
                open_by_symbol.pop(trade.symbol, None)
                recently_closed_by_symbol[trade.symbol] = trade
            continue

        if "Position flat on exchange" in msg or " SL HIT" in msg or " TP HIT" in msg or "TIME EXIT" in msg:
            fill = None
            if m := FILL_EXIT_RE.search(msg):
                fill = _to_float(m.group("fill"))
            if sym_match:
                trade = open_by_symbol.get(symbol)
            elif fill:
                candidates = [t for t in open_by_symbol.values() if t.entry_price]
                trade = min(
                    candidates,
                    key=lambda t: abs(math.log(max(fill, 1e-9) / max(float(t.entry_price), 1e-9))),
                    default=None,
                )
            else:
                trade = next((t for t in reversed(trades) if t.outcome == "OPEN" and t.entry_price), None)
            if not trade:
                continue
            pnl = None
            if m := EXIT_RE.search(msg):
                pnl = _to_float(m.groupdict().get("pnl") or m.groupdict().get("pnl2"))
            trade.exit_ts = _line_ts(row)
            trade.exit_price = fill
            trade.pnl = pnl
            if "TIME EXIT" in msg:
                trade.outcome = "TIME_EXIT"
            elif pnl is not None:
                trade.outcome = "WIN" if pnl > 0 else "LOSS"
            elif "TP" in msg:
                trade.outcome = "WIN"
            elif "SL" in msg:
                trade.outcome = "LOSS"
            else:
                trade.outcome = "CLOSED"
            trade.update_price(fill, fill, fill)
            open_by_symbol.pop(trade.symbol, None)
            recently_closed_by_symbol[trade.symbol] = trade

    trade_rows = [t.as_dict() for t in trades]
    by_symbol = _summarize_by_symbol(trade_rows, gate_counts)
    return {
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "input_lines": len(entries),
        "trades": trade_rows,
        "gate_counts": {k: dict(v) for k, v in gate_counts.items()},
        "global_gate_counts": dict(global_counts),
        "by_symbol": by_symbol,
        "recommendations": _recommend(by_symbol),
    }


def _summarize_by_symbol(trades: list[dict[str, Any]], gate_counts: dict[str, Counter]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    symbols = sorted({t["symbol"] for t in trades} | set(gate_counts))
    for symbol in symbols:
        rows = [t for t in trades if t["symbol"] == symbol]
        closed = [t for t in rows if t["outcome"] not in ("OPEN",)]
        wins = [t for t in closed if t.get("pnl") is not None and t["pnl"] > 0]
        losses = [t for t in closed if t.get("pnl") is not None and t["pnl"] <= 0 or t["outcome"] == "LOSS"]
        pnl_values = [t["pnl"] for t in closed if t.get("pnl") is not None]
        mfe_values = [t["mfe_pct"] for t in rows if t.get("mfe_pct") is not None]
        mae_values = [t["mae_pct"] for t in rows if t.get("mae_pct") is not None]
        gaveback_losses = [
            t for t in losses
            if (t.get("mfe_pct") or 0.0) > 0.25 and not t.get("partials")
        ]
        out[symbol] = {
            "trades": len(rows),
            "closed": len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(len(wins) / len(closed), 4) if closed else None,
            "net_pnl": round(sum(pnl_values), 4) if pnl_values else None,
            "avg_mfe_pct": round(sum(mfe_values) / len(mfe_values), 4) if mfe_values else None,
            "avg_mae_pct": round(sum(mae_values) / len(mae_values), 4) if mae_values else None,
            "gaveback_loss_count": len(gaveback_losses),
            "gate_counts": dict(gate_counts.get(symbol, Counter())),
        }
    return out


def _recommend(by_symbol: dict[str, Any]) -> list[str]:
    recs: list[str] = []
    for symbol, s in by_symbol.items():
        gates = s.get("gate_counts", {})
        if s.get("closed", 0) >= 2 and (s.get("win_rate") or 0.0) < 0.45:
            recs.append(f"{symbol}: execution is active but recent closed-trade win rate is weak; keep probation/reduced risk until replay sample improves.")
        if s.get("gaveback_loss_count", 0) > 0:
            recs.append(f"{symbol}: trades showed positive MFE before closing red; partial TP/time-exit rules should be evaluated first.")
        if gates.get("bayes_floor_veto", 0) >= max(5, s.get("trades", 0) * 2):
            recs.append(f"{symbol}: Bayes floor is the dominant blocker; calibrate symbol-specific Bayes priors/posteriors before lowering the global floor.")
        if gates.get("throughput_thin", 0) >= 5:
            recs.append(f"{symbol}: throughput gate is frequently blocking; validate feed health and symbol-specific msg/min baseline.")
        if gates.get("htf_counter_trend", 0) >= 5:
            recs.append(f"{symbol}: HTF counter-trend filter is frequently blocking; report supports symbol/regime-specific HTF tuning.")
    if not recs:
        recs.append("No strong tuning recommendation from this log sample; collect more closed trades before changing thresholds.")
    return recs


def write_csv(report: dict[str, Any], path: Path) -> None:
    rows = report["trades"]
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = [
        "id", "symbol", "verdict", "side", "signal_ts", "entry_price", "size",
        "confidence", "regime", "strategy", "htf", "z_score", "bayes", "cvd",
        "ofi", "atr", "atr_pct", "stop_loss", "take_profit", "mfe_pct",
        "mae_pct", "mfe_r", "mae_r", "exit_ts", "exit_price", "pnl", "outcome",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay bot logs into a signal-edge report.")
    parser.add_argument("paths", nargs="+", type=Path, help="Log/JSON files to replay in chronological continuation order.")
    parser.add_argument("--out", type=Path, default=Path("reports/signal_replay_report.json"))
    parser.add_argument("--csv", dest="csv_path", type=Path, default=None)
    args = parser.parse_args()

    entries = load_entries(args.paths)
    report = replay(entries)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    if args.csv_path:
        write_csv(report, args.csv_path)
    print(f"Wrote {args.out} with {len(report['trades'])} trades from {report['input_lines']} lines")
    if args.csv_path:
        print(f"Wrote {args.csv_path}")


if __name__ == "__main__":
    main()
