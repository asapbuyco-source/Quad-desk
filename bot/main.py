"""
Macro Strategy Execution Bot — Orchestrator
============================================
Launch with:
    python -m bot.main

Environment variables:
    GEMINI_API_KEY       — Required for AI inference (falls back to WAIT without it)
    BINANCE_API_KEY      — Optional; bot runs in dry-run mode without it
    BINANCE_API_SECRET   — Optional; bot runs in dry-run mode without it
    BOT_SYMBOL           — Default: BTCUSDT
    BOT_TESTNET          — Default: true  (set to "false" for live)
    BOT_MAX_RISK_PCT     — Default: 2.0
    BOT_ANALYSIS_INTERVAL— Default: 10  (seconds between AI evaluations)
    BOT_MIN_CONFIDENCE   — Default: 0.70
"""

import asyncio
import logging
import os
import signal
from typing import Dict, Any

from dotenv import load_dotenv
load_dotenv()

from bot.data_feed import BinanceDataFeed
from bot.quant_engine import QuantEngine
from bot.agent import QuantAgent
from bot.executor import TradingExecutor
from bot import heartbeat

# ──────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger("bot.main")

# ──────────────────────────────────────────────────────────────────────
# Config from environment
# ──────────────────────────────────────────────────────────────────────
SYMBOL            = os.environ.get("BOT_SYMBOL",            "BTCUSDT")
TESTNET           = os.environ.get("BOT_TESTNET",           "true").lower() != "false"
MAX_RISK_PCT      = float(os.environ.get("BOT_MAX_RISK_PCT",      "2.0"))
ANALYSIS_INTERVAL = int(os.environ.get("BOT_ANALYSIS_INTERVAL",  "10"))
MIN_CONFIDENCE    = float(os.environ.get("BOT_MIN_CONFIDENCE",    "0.70"))

API_KEY    = os.environ.get("BINANCE_API_KEY",    "")
API_SECRET = os.environ.get("BINANCE_API_SECRET", "")
DRY_RUN    = not (API_KEY and API_SECRET)

# ──────────────────────────────────────────────────────────────────────
# Shared stats — mutated by execution_loop, read every 10 s by heartbeat
# ──────────────────────────────────────────────────────────────────────
BOT_STATS: Dict[str, Any] = {
    "symbol":          SYMBOL,
    "mode":            "LIVE" if not DRY_RUN else "DRY-RUN",
    "environment":     "TESTNET" if TESTNET else "MAINNET",
    "active_position": None,
    "total_trades":    0,
    "last_signal":     "WAIT",
}


# ──────────────────────────────────────────────────────────────────────
# Core execution loop
# ──────────────────────────────────────────────────────────────────────
async def execution_loop(
    feed: BinanceDataFeed,
    quant: QuantEngine,
    agent: QuantAgent,
    executor: TradingExecutor,
    stats: Dict[str, Any],
):
    await executor.initialize()

    mode = "DRY-RUN" if executor.dry_run else "LIVE"
    logger.info(
        f"╔══ Macro Strategy Bot ══╗\n"
        f"║  Symbol   : {SYMBOL}\n"
        f"║  Mode     : {mode} | {'TESTNET' if TESTNET else 'MAINNET'}\n"
        f"║  Risk/trade: {MAX_RISK_PCT}%\n"
        f"║  Min conf : {MIN_CONFIDENCE*100:.0f}%\n"
        f"║  Interval : every {ANALYSIS_INTERVAL}s\n"
        f"╚══════════════════════╝"
    )

    while True:
        try:
            await asyncio.sleep(ANALYSIS_INTERVAL)

            # ── Warmup guard ──────────────────────────────────────────
            n_candles = len(feed.state.candles)
            if n_candles < QuantEngine.MIN_CANDLES:
                logger.info(
                    f"[Main] Warming up… {n_candles}/{QuantEngine.MIN_CANDLES} candles"
                )
                continue

            # ── Position exit check (dry-run) ─────────────────────────
            current_price_approx = feed.state.candles[-1]['close']
            if executor.active_position and executor.dry_run:
                executor.check_position_exit(current_price_approx)

            # ── Sync live position state to shared stats ───────────────
            stats["active_position"] = executor.active_position

            # ── If already in a position, skip new entry signals ──────
            if executor.active_position:
                pos = executor.active_position
                pnl_pct = (
                    (current_price_approx - pos['entry_price']) / pos['entry_price'] * 100
                    if pos['side'] == 'buy' else
                    (pos['entry_price'] - current_price_approx) / pos['entry_price'] * 100
                )
                logger.info(
                    f"[Main] HOLDING {pos['side'].upper()} @ {pos['entry_price']:.2f}"
                    f" | now={current_price_approx:.2f} | PnL={pnl_pct:+.2f}%"
                    f" | SL={pos['stop_loss']} TP={pos['take_profit']}"
                )
                continue

            # ── Compute metrics ───────────────────────────────────────
            metrics = quant.compute_metrics()
            if metrics is None:
                continue

            logger.info(
                f"[Main] Metrics | P={metrics['price']:.2f}"
                f" RSI={metrics['rsi']:.1f}"
                f" Z={metrics['zScore']:.2f}"
                f" Bayes={metrics['bayesianPosterior']:.2%}"
                f" Skew={metrics['skewness']:.3f}"
                f" OFI={metrics['ofi']:.1f}"
                f" Tape={metrics['tapeSpeed']}"
            )

            # ── AI inference ──────────────────────────────────────────
            dynamic_model = stats.get("ai_model", agent.model)
            if agent.model != dynamic_model:
                logger.info(f"[Main] Switching AI Model to {dynamic_model}")
                agent = QuantAgent(model=dynamic_model)

            verdict_json = await agent.analyze(metrics)

            action     = verdict_json.get('verdict', 'WAIT')
            conf       = float(verdict_json.get('confidence', 0))
            stop_loss  = verdict_json.get('stop_loss', 0)
            take_profit= verdict_json.get('take_profit', 0)
            analysis   = verdict_json.get('analysis', '')

            # ── Update shared stats so heartbeat reflects latest signal ─
            stats["last_signal"]     = action

            logger.info(
                f"[AI]   {action} | conf={conf:.0%} | SL={stop_loss} TP={take_profit}"
            )
            logger.info(f"[AI]   {analysis}")

            # ── Execute if actionable ─────────────────────────────────
            is_actionable = action in ('BUY', 'SELL', 'MEAN_REVERSAL_LONG', 'MEAN_REVERSAL_SHORT')
            if is_actionable and conf >= MIN_CONFIDENCE:
                await executor.execute_signal(SYMBOL, metrics['price'], verdict_json, MAX_RISK_PCT)
                stats["total_trades"] += 1
            else:
                logger.info(
                    f"[Main] No trade. action={action} conf={conf:.0%} threshold={MIN_CONFIDENCE:.0%}"
                )

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"[Main] Execution loop error: {e}", exc_info=True)
            await asyncio.sleep(5)  # Brief pause before retrying


# ──────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────
async def main():
    feed     = BinanceDataFeed(symbol=SYMBOL, testnet=TESTNET)
    quant    = QuantEngine(feed.state)
    agent    = QuantAgent()                                     # tolerant; WAIT if no key
    executor = TradingExecutor(API_KEY, API_SECRET, testnet=TESTNET, dry_run=DRY_RUN)

    # Initialise Firebase heartbeat (no-op if credentials are missing)
    heartbeat.init_firebase()

    # Graceful shutdown on SIGINT / SIGTERM
    loop = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()

    def _handle_signal():
        logger.info("[Main] Shutdown signal received.")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass  # signal handlers not supported on Windows event loops

    tasks = [
        asyncio.create_task(feed.run(),                                                   name="data_feed"),
        asyncio.create_task(execution_loop(feed, quant, agent, executor, BOT_STATS),     name="exec_loop"),
        asyncio.create_task(heartbeat.run_heartbeat(BOT_STATS),                          name="heartbeat"),
    ]

    try:
        # Run until a shutdown signal is received
        await shutdown_event.wait()
    except asyncio.CancelledError:
        pass
    finally:
        logger.info("[Main] Stopping…")
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        feed.stop()
        await executor.close()
        await heartbeat.write_offline(BOT_STATS)   # tell dashboard bot is now offline
        logger.info("[Main] Bot stopped cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
