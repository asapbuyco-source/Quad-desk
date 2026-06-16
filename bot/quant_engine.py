import time
import logging
import math
import json
import os
import numpy as np
import pandas as pd
from collections import deque
from typing import Dict, Any, Optional
from bot.signal_config import OFI_WARMUP_CYCLES

logger = logging.getLogger(__name__)



class QuantEngine:
    """
    Computes the 7 core Macro Strategy metrics from a live MarketState.
    All calculations mirror the audited React store/index.ts logic.

    Enhancements (v2):
      - Beta(α,β) conjugate prior for self-calibrating Bayesian win rate
      - Student's t-distribution Z-score (fat-tail robust, replaces Gaussian)
      - funding_rate passed through from MarketState for ULIS signal
    """

    MIN_CANDLES = 51  # Need 51 to produce 50 log-returns

    def __init__(self, state):
        self.state = state

        # ── Per-Regime Beta Priors (P1 — HMM Spec Apr 2026) ──────────────────
        # Separate Beta(α,β) conjugate prior per HMM regime.
        # Tracks win rate independently for RANGE (mean-reversion),
        # TREND (momentum), and NEUTRAL/LIQUIDITY (mixed) regimes.
        # Mean = α/(α+β) = 0.5 at startup (uniform prior, no assumptions).
        self._regime_alpha: dict = {"RANGE": 5.0, "NEUTRAL": 5.0, "TREND": 5.0, "LIQUIDITY": 5.0}
        self._regime_beta:  dict = {"RANGE": 5.0, "NEUTRAL": 5.0, "TREND": 5.0, "LIQUIDITY": 5.0}
        self._regime_trade_count: dict = {"RANGE": 0, "NEUTRAL": 0, "TREND": 0, "LIQUIDITY": 0}
        # Keep global fallback for backwards compatibility with _bayesian()
        self._alpha: float = 5.0
        self._beta:  float = 5.0


        # ── OFI State (Three-Stage Pipeline) ──────────────────────────────
        # Stage 1: True OFI = delta of bid/ask depth between snapshots
        self._prev_bid_depth: float = 0.0
        self._prev_ask_depth: float = 0.0
        # Stage 2: MAD Persistence Filter
        self._ofi_history: deque = deque(maxlen=100)
        self._ofi_outlier_count: int = 0
        # Stage 3: EWMA normalisation + tanh soft saturation
        self._ofi_ewma_mu:  float = 0.0
        self._ofi_ewma_var: float = 1.0
        self._ofi_smooth:   float = 0.0
        self._ofi_cycle_count: int = 0  # Warm-up guard: OFI is unreliable for first N cycles after restart

        # ── ATR Percentile Rank (P2 — HMM Spec Apr 2026) ─────────────────
        # Rolling 30-day window (4 candles/hr × 24hr × 30d = 2880 candles)
        # Rank of current ATR within this window gives a normalised [0,1]
        # measure of how extreme current volatility is vs recent history.
        # Much more robust than raw ATR% which varies by price level.
        self._atr_history: deque = deque(maxlen=2880)

        # ── State variables extracted from main.py ──────────────────────────
        self._liquidity_consecutive: int = 0
        self._liquidity_cap_cooldown: int = 0   # prevents immediate LIQUIDITY re-entry after cap
        self._dead_market_cycles: int = 0    # consecutive RANGE+flat-Z cycles (dead market guard)

        # ── RSI History Cache (MED-1 fix) ─────────────────────────────────────
        # Caches the last 3 computed RSI values so rsi_prev/rsi_prev2 reflect
        # true historically-observed values rather than recomputed ones with
        # different EMA seeds.
        self._rsi_history: deque = deque(maxlen=3)

        # ── CVD Divergence Snapshot History ────────────────────────────────────
        # Per-candle snapshots of {candle_ts, close, low, high, cvd} taken at
        # the moment each new 15m candle is detected.  maxlen=12 (3 hours).
        # Needed because self.state.cvd is a running session total with no memory
        # of prior candle closes — divergence detection requires comparing CVD
        # at candle N vs candle N-k.
        self._cvd_candle_snapshots: deque = deque(maxlen=12)
        self._last_snapped_candle_ts: float = 0.0

        # ── CVD Delta EMA-Variance Normalization (Fix #1) ──────────────────────
        # Welford's online EMA for CVD delta normalization (replaces fragile
        # session-range denominator). λ=0.92 → half-life ≈ 8 observations (~2h).
        self._cvd_delta_ewma_mu:  float = 0.0
        self._cvd_delta_ewma_var: float = 1.0
        self._cvd_delta_ewma_n:   int   = 0

        # ── CVD Divergence Streak Tracker (Age Cap Fix) ─────────────────────────
        # If the SAME divergence direction fires for >8 consecutive candle snapshots
        # (~2 hours), it is measuring a macro TREND not a divergence.  Decay the
        # strength exponentially so the signal expires naturally.
        # exp(-0.15 × (12-8)) ≈ 0.55 — well below MIN_STRENGTH=0.28 at 12 candles.
        self._cvd_div_streak_dir:   str = "NONE"
        self._cvd_div_streak_count: int = 0

        # ── Consecutive-Loss Tracker (Prior Softening) ──────────────────────────
        self._consecutive_losses: int = 0

        # ── CVD Post-Reset Cooldown (Ghost Signal Fix 2026-05-13) ─────────────
        # Suppresses divergence detection for N cycles after the daily CVD reset.
        # Without this the reset artifact triggers a spurious BEARISH divergence
        # that persists for 100+ candles before expiring naturally (~22 min of
        # false bearish bias). Set to 0 at boot; reset_cvd_divergence_state()
        # sets it to 5 whenever the daily hook fires.
        self._cvd_post_reset_cooldown: int = 0

        # ── Session VWAP Anchor (Phase 2) ───────────────────────────────────
        # Rolling 24h window: each entry is (tp, volume, timestamp_seconds)
        # Max 96 entries at 15m candles (24h / 15m = 96)
        # HMM-SESSION-VWAP FIX: Replaced midnight-UTC session reset with a
        # proper 24h rolling window so VWAP is meaningful even when the bot
        # starts mid-day or runs across the UTC midnight boundary.
        self._vwap_rolling: deque = deque(maxlen=288)  # 288 × 15m = 72h max buffer
        self._vwap_num: float = 0.0    # Σ(tp × vol) for active window
        self._vwap_den: float = 0.0    # Σ(vol) for active window
        self._vwap_24h_anchor_ts: float = 0.0  # epoch seconds of last 24h reset

        # Persistence path — survives Railway restarts if /tmp is mounted
        # Symbol-isolated so multiple bots don't overwrite each other
        _raw_sym = os.environ.get("BOT_SYMBOL", "BTC/USDT")
        _safe_sym = _raw_sym.replace("/", "").replace(":", "").replace("-", "").upper()
        _default_path = f"/tmp/quad_bot_state_{_safe_sym}.json"
        self._persist_path = os.environ.get("BOT_STATE_PATH", _default_path)
        self._firestore_doc_id = f"quantEngine_{_safe_sym}"  # e.g. quantEngine_BTCUSDT
        self._load_state()

        # B2 FIX: Configurable RV/IV windows for normal vs high-vol conditions
        self._rv_iv_window_normal = int(os.environ.get("BOT_RV_IV_WINDOW_MS_NORMAL", "30000"))
        self._rv_iv_window_vol = int(os.environ.get("BOT_RV_IV_WINDOW_MS_VOL", "120000"))

    @staticmethod
    def _rv_iv_discriminant(
        trades,
        closes: np.ndarray,
        atr: float,
        current_price: float,
        now_ms: Optional[float] = None,
        window_ms: int = 30_000,
        min_ticks: int = 5,
    ) -> Dict[str, Any]:
        """Classify live realized volatility versus candle-implied volatility.

        B2 FIX: Added configurable window_ms and min_ticks parameters.
        Uses 30s window for normal conditions, 120s for high-vol/sparse-tape.
        """
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        recent_prices = [
            float(t.get("price"))
            for t in trades
            if (now_ms - float(t.get("time", now_ms)) < window_ms) and t.get("price")
        ]

        rv_data_stale = len(recent_prices) < min_ticks
        if not rv_data_stale:
            tick_returns = np.diff(np.log(recent_prices))
            rv = float(np.std(tick_returns)) * math.sqrt(max(len(tick_returns), 1))
        elif len(closes) >= 2:
            log_returns = np.diff(np.log(closes))
            rv = float(np.std(log_returns))
        else:
            rv = 0.001

        iv_proxy = atr / current_price if current_price > 0 else 0.001
        rv_iv_ratio = rv / iv_proxy if iv_proxy > 0 else 1.0
        vol_state = (
            "COMPRESSION"
            if rv_iv_ratio < 0.8
            else ("EXPANSION" if rv_iv_ratio > 1.2 else "NORMAL")
        )
        return {
            "rv": rv,
            "rv_iv_ratio": rv_iv_ratio,
            "vol_state": vol_state,
            "rv_data_stale": rv_data_stale,
            "rv_window_ms": window_ms,
            "rv_tick_count": len(recent_prices),
        }


    # ------------------------------------------------------------------
    # Public: update win-rate tracker after each trade
    # ------------------------------------------------------------------
    def update_win_rate(self, won: bool, regime: str = "NEUTRAL"):
        if won:
            self._alpha += 1.0
            self._regime_alpha[regime] = self._regime_alpha.get(regime, 1.0) + 1.0
            self._consecutive_losses = 0   # reset streak on any win
        else:
            self._beta += 1.0
            self._regime_beta[regime] = self._regime_beta.get(regime, 1.0) + 1.0
            self._consecutive_losses = getattr(self, "_consecutive_losses", 0) + 1
            # Prior-softening: after 3+ consecutive losses the Beta prior has drifted
            # too bearish to recover naturally. Pull it 15% toward Beta(5,5) each loss
            # so the bot can re-engage after a bad streak without a full cold-start reset.
            # NEW-FIX 1: softened at >= 3 to match the halt gate (also >= 3).
            # Previously used >= 2 which meant a 2-loss streak degraded the prior
            # without triggering the safety halt.
            if self._consecutive_losses >= 3:
                _target = 5.0
                self._alpha = self._alpha * 0.85 + _target * 0.15
                self._beta  = self._beta  * 0.85 + _target * 0.15
                if regime in self._regime_alpha:
                    self._regime_alpha[regime] = self._regime_alpha[regime] * 0.85 + _target * 0.15
                    self._regime_beta[regime] = self._regime_beta[regime] * 0.85 + _target * 0.15
                logger.warning(
                    f"[QuantEngine] Consecutive loss #{self._consecutive_losses} — "
                    f"softening prior toward Beta(5,5): "
                    f"α={self._alpha:.1f} β={self._beta:.1f} "
                    f"P(bull)={self._alpha/(self._alpha+self._beta):.1%}"
                )
        self._regime_trade_count[regime] = self._regime_trade_count.get(regime, 0) + 1
        p_bull = self._alpha / (self._alpha + self._beta)
        n = self._alpha + self._beta - 2
        logger.info(
            f"[QuantEngine] Win-rate updated: α={self._alpha:.0f} β={self._beta:.0f} "
            f"→ P(bull)={p_bull:.2%} | regime={regime}  (n={n:.0f} trades)"
        )
        self._save_state()

    def get_regime_trade_counts(self) -> dict:
        return dict(self._regime_trade_count)

    def reset_cvd_divergence_state(self) -> None:
        """
        Call this whenever the daily CVD accumulator is reset to zero.
        Prevents the divergence detector from comparing fresh post-reset CVD
        values against stale pre-reset snapshots, which would produce a false
        massive BULLISH spike.
        """
        self._cvd_candle_snapshots.clear()
        self._last_snapped_candle_ts = 0.0
        self._cvd_delta_ewma_mu  = 0.0
        self._cvd_delta_ewma_var = 1.0
        self._cvd_delta_ewma_n   = 0
        self._cvd_div_streak_dir   = "NONE"
        self._cvd_div_streak_count = 0
        self._cvd_post_reset_cooldown = 5
        logger.info("[QuantEngine] CVD divergence state cleared (daily reset hook). "
                    "Divergence suppressed for 5 candles to prevent ghost signal.")

    # ------------------------------------------------------------------
    # P1: Per-regime win rate accessor
    # ------------------------------------------------------------------
    def get_all_regime_priors(self) -> dict:
        """
        Returns dict of regime → win_rate_prior for all 4 regimes.
        Injected into metrics before _compute_signal() so _bayesian_fusion
        can blend per-regime prior with the base Bayesian posterior.
        """
        result = {}
        for regime in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
            a = self._regime_alpha.get(regime, 1.0)
            b = self._regime_beta.get(regime, 1.0)
            result[regime] = a / (a + b)   # Beta distribution mean
        return result

    # ------------------------------------------------------------------
    # State Persistence: Firestore primary, /tmp/ file fallback
    # Issue #3 FIX: /tmp/ is wiped on every Railway container restart.
    # Firestore survives indefinitely. Load order on boot:
    #   1. Firestore (botState/quantEngine document)
    #   2. /tmp/ local file (fast path for same-container warm restarts)
    #   3. Fresh Beta(5,5) prior (true cold start)
    # ------------------------------------------------------------------
    def _save_state(self):
        """
        Persist Bayesian priors and OFI EWMA state.
        Writes to Firestore in a background thread (non-blocking, won't
        slow down the main trading loop) and also writes to /tmp/ as a
        local cache for rapid same-container restarts.
        """
        import threading
        data = {
            "alpha":          self._alpha,
            "beta":           self._beta,
            "regime_alpha":   self._regime_alpha,
            "regime_beta":    self._regime_beta,
            "regime_count":   self._regime_trade_count,
            "ofi_ewma_mu":    self._ofi_ewma_mu,
            "ofi_ewma_var":   self._ofi_ewma_var,
            "ofi_smooth":     self._ofi_smooth,
            "saved_at":       time.time(),
        }

        # ── 1. Firestore write (background thread, non-blocking) ────────
        def _write_firestore(payload: dict) -> None:
            try:
                from bot.heartbeat import get_db
                db = get_db()
                if db is not None:
                    db.collection("botState").document(self._firestore_doc_id).set(payload)
                    logger.debug("[QuantEngine] State saved to Firestore ✓")
            except Exception as e:
                logger.warning(f"[QuantEngine] Firestore state save failed: {e}")

        threading.Thread(
            target=_write_firestore,
            args=(dict(data),),
            daemon=True,
            name="QuantEngine-FSWrite",
        ).start()

        # ── 2. /tmp/ file as local cache (synchronous) ──────────────────
        try:
            with open(self._persist_path, "w") as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning(f"[QuantEngine] Local state cache write failed: {e}")

    def _load_state(self):
        """
        Load Bayesian priors on startup.
        Tries Firestore first (survives Railway deploys), then falls back
        to the /tmp/ local file (useful for same-container warm restarts),
        then initialises a fresh Beta(5,5) prior.
        """
        import os
        if os.getenv("DEV_RESET", "False").lower() in ("true", "1", "yes"):
            logger.info("[QuantEngine] DEV_RESET=True - skipping Firestore/local cache. Starting with fresh Beta(5,5) prior.")
            return
        # ── 1. Try Firestore ────────────────────────────────────────────
        try:
            from bot.heartbeat import get_db
            db = get_db()
            if db is not None:
                doc = db.collection("botState").document(self._firestore_doc_id).get()
                if doc.exists:
                    data = doc.to_dict()
                    self._alpha = float(data.get("alpha", 5.0))
                    self._beta  = float(data.get("beta",  5.0))
                    saved_ra = data.get("regime_alpha", {})
                    saved_rb = data.get("regime_beta",  {})
                    saved_rc = data.get("regime_count", {})
                    for r in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
                        self._regime_alpha[r]       = float(saved_ra.get(r, 5.0))
                        self._regime_beta[r]        = float(saved_rb.get(r, 5.0))
                        self._regime_trade_count[r] = int(saved_rc.get(r, 0))

                    n_trades = sum(self._regime_trade_count.values())
                    p_bull   = self._alpha / (self._alpha + self._beta)
                    logger.info(
                        f"[QuantEngine] ✅ State loaded from Firestore — "
                        f"α={self._alpha:.0f} β={self._beta:.0f} "
                        f"P(bull)={p_bull:.1%} | "
                        f"n_trades={n_trades} "
                        f"(saved {(time.time() - float(data.get('saved_at', time.time()))):.0f}s ago)"
                    )
                    return  # ← success: stop here
                else:
                    logger.info("[QuantEngine] Firestore botState/quantEngine: no document yet — checking /tmp/")
        except Exception as e:
            logger.warning(f"[QuantEngine] Firestore state load failed: {e} — falling back to /tmp/")

        # ── 2. Try /tmp/ local file ─────────────────────────────────────
        try:
            if os.path.exists(self._persist_path):
                with open(self._persist_path) as f:
                    data = json.load(f)
                self._alpha = float(data.get("alpha", 5.0))
                self._beta  = float(data.get("beta",  5.0))
                saved_ra = data.get("regime_alpha", {})
                saved_rb = data.get("regime_beta",  {})
                saved_rc = data.get("regime_count", {})
                for r in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
                    self._regime_alpha[r]       = float(saved_ra.get(r, 5.0))
                    self._regime_beta[r]        = float(saved_rb.get(r, 5.0))
                    self._regime_trade_count[r] = int(saved_rc.get(r, 0))

                logger.info(
                    "[QuantEngine] ⚠️ State loaded from /tmp/ (Firestore unavailable). "
                    "Prior will be lost on next Railway deploy."
                )
                return  # ← success
        except Exception as e:
            logger.warning(f"[QuantEngine] /tmp/ state load error: {e}")

        # ── 3. Cold start — fresh Beta(5,5) ─────────────────────────────
        for r in ("RANGE", "NEUTRAL", "TREND", "LIQUIDITY"):
            self._regime_alpha[r]       = 5.0
            self._regime_beta[r]        = 5.0
            self._regime_trade_count[r] = 0
        self._alpha = 5.0
        self._beta  = 5.0
        logger.info("[QuantEngine] 🆕 Cold start: Beta(5,5) uninformed prior.")


    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def compute_metrics(self) -> Optional[Dict[str, Any]]:
        """
        Returns a fully-populated metrics dict, or None if not enough data.
        """
        if len(self.state.candles) < self.MIN_CANDLES:
            return None

        c_list = self.state.candles
        closes = np.array([c['close'] for c in c_list], dtype=float)
        highs  = np.array([c['high']  for c in c_list], dtype=float)
        lows   = np.array([c['low']   for c in c_list], dtype=float)
        vols   = np.array([c['volume']for c in c_list], dtype=float)

        current_price = closes[-1]

        # Calculate ATR and rank early for session VWAP and fix BUG-V3-03
        atr = self._atr(highs, lows, closes)
        self._atr_history.append(atr)
        arr = np.array(list(self._atr_history))
        atr_pct_rank = float(np.mean(arr <= atr))
        self._atr_pct_rank = atr_pct_rank  # make available to _cvd_divergence

        # B2 FIX: Select RV/IV window based on conditions
        # Use 120s window for high ATR rank, sparse tape, or volatile regime candidate
        last_trade_ts = getattr(self.state, '_last_trade_ts', 0.0)
        tape_sparse = (
            last_trade_ts > 0 and
            (time.time() - last_trade_ts) > 30.0
        ) or len(self.state.recent_trades) < 10
        use_vol_window = atr_pct_rank >= 0.80 or tape_sparse
        rv_window_ms = self._rv_iv_window_vol if use_vol_window else self._rv_iv_window_normal

        # PHASE 3: RV/IV Real-Time Discriminant
        # Calculate aggTrade realized variance for true micro-volatility.
        rv_iv = self._rv_iv_discriminant(
            list(self.state.recent_trades),
            closes,
            atr,
            current_price,
            window_ms=rv_window_ms,
        )
        rv_iv_ratio = rv_iv["rv_iv_ratio"]
        vol_state = rv_iv["vol_state"]

        skewness       = self._skewness(closes)
        z_score        = self._session_vwap_z(highs, lows, closes, vols, current_price, atr_pct_rank)
        zScore_prev    = getattr(self, "_last_z_score", z_score)
        self._last_z_score = z_score

        # MED-1 FIX: Use cached RSI history for rsi_prev/rsi_prev2.
        # Re-slicing closes[] and recomputing _rsi() produces a different Wilder EMA
        # seed each time — not the value that was observed last cycle. Cache instead.
        rsi = self._rsi(closes)
        self._rsi_history.append(rsi)
        rsi_prev  = self._rsi_history[-2] if len(self._rsi_history) >= 2 else rsi
        rsi_prev2 = self._rsi_history[-3] if len(self._rsi_history) >= 3 else rsi_prev

        tape_speed, dominant_side = self._tape_metrics()
        ofi, wall_context, all_walls_str, execution_price, valid_bids, valid_asks, nearest_bid, nearest_ask, top_bids, top_asks = self._lob_metrics(current_price)
        z_ret = self._log_return_z_score(closes)
        # Lightweight regime proxy for z_vel gating: |Z_t| > 1.5 ≈ TREND-like.
        # Full HMM regime is determined later in main.py; this gives quant engine
        # a useful signal without a circular dependency on the regime classifier.
        _regime_proxy = "TREND" if abs(z_score) > 1.5 else "NEUTRAL"
        bayesian_posterior = self._bayesian(rsi, z_score, skewness, ofi,
                                            z_ret=z_ret, regime=_regime_proxy)
        cvd = self.state.cvd

        vpoc = self._volume_poc(c_list)
        funding_rate = getattr(self.state, 'funding_rate', 0.0)

        last_trade_ts = getattr(self.state, '_last_trade_ts', 0.0)
        trade_buffer_healthy = (
            last_trade_ts > 0 and
            (time.time() - last_trade_ts) < 30.0 and
            len(self.state.recent_trades) >= 5
        )

        # ── CVD Candle Snapshot (Divergence Layer) ────────────────────────────
        # Detect a new candle by comparing the latest candle's timestamp to the
        # last one we snapped.  When a new candle has opened (previous one closed),
        # record the closed candle's OHLC and the CVD value AT THAT MOMENT.
        current_candle_ts = float(c_list[-1].get("time", 0.0)) if c_list else 0.0
        if (current_candle_ts != self._last_snapped_candle_ts
                and len(c_list) >= 2):
            closed_candle = c_list[-2]
            snap = {
                "candle_ts": float(closed_candle.get("time",  0.0)),
                "close":     float(closed_candle.get("close", current_price)),
                "low":       float(closed_candle.get("low",   current_price)),
                "high":      float(closed_candle.get("high",  current_price)),
                "volume":    float(closed_candle.get("volume", 0.0)),
                "cvd":       float(cvd),
            }
            self._cvd_candle_snapshots.append(snap)
            self._last_snapped_candle_ts = current_candle_ts
            logger.debug(
                f"[CVDSnap] New candle — snapped CVD={cvd:.0f} "
                f"low={snap['low']:.2f} high={snap['high']:.2f} vol={snap['volume']:.1f}"
            )

        # ── CVD Divergence Detection ──────────────────────────────────────────
        cvd_divergence = self._cvd_divergence(current_price, atr, z_score)

        return {
            "symbol":            self.state.symbol,
            "price":             current_price,
            "skewness":          skewness,
            "bayesianPosterior": bayesian_posterior,
            "zScore":            z_score,
            "zScore_prev":       zScore_prev,
            "rsi":               rsi,
            "rsi_prev":          rsi_prev,
            "rsi_prev2":         rsi_prev2,
            "ofi":               ofi,
            "cvd":               cvd,
            "tapeSpeed":         tape_speed,
            "tapeDominant":      dominant_side,
            "wallContext":       wall_context,
            "allWalls":          all_walls_str,
            "atr":               atr,
            "atr_pct":           atr / current_price if current_price > 0 else 0.0,
            "atr_pct_rank":      atr_pct_rank,   # P2: percentile rank in 30-day window
            "vpoc":              vpoc,
            "funding_rate":      funding_rate,
            # PHASE-0.4: Z-score validity guard.
            # Z-score is meaningless with fewer than 10 bars of data in the
            # current session — it's fitting noise from too-small a sample.
            "z_score_valid":     len(closes) >= 10,
            # Z-06: Log-Return Z-Score — reuse value computed for _bayesian() above
            "zScore_ret":        z_ret,
            # PHASE 3: RV/IV fields
            "rv_iv_ratio":       rv_iv_ratio,
            "vol_state":         vol_state,
            "rv_data_stale":      rv_iv["rv_data_stale"],
            "cvd_lambda":        cvd_divergence.get("lambda", 0.92),
            # PHASE-0.2: aggTrade stream health flag.
            "trade_buffer_healthy": trade_buffer_healthy,
            # PHASE-0.4: Order book mid-price for execution (not candle close).
            "execution_price":   execution_price,
            # PHASE-0.3: Structured wall data for _detect_regime significance filter
            "bid_depths":        valid_bids,
            "ask_depths":        valid_asks,
            "nearest_buy_wall":  nearest_bid,
            "nearest_sell_wall": nearest_ask,
            "top_buy_walls":     top_bids,
            "top_sell_walls":    top_asks,
            # ── CVD Divergence ────────────────────────────────────────────────
            "cvd_divergence":    cvd_divergence,
        }

    # ------------------------------------------------------------------
    # 1. Log-Return Skewness (50 periods)
    # ------------------------------------------------------------------
    def _skewness(self, closes: np.ndarray) -> float:
        """FIX DIV-M1: 20-bar window matches Z-score temporal alignment."""
        closes_21 = closes[-21:]  # was -51 (50 bars) — now 20 bars
        if len(closes_21) < 21:
            return 0.0
        safe = np.where(closes_21[:-1] > 0, closes_21[:-1], np.nan)
        returns_20 = np.log(closes_21[1:] / safe)
        valid = returns_20[~np.isnan(returns_20)]
        if len(valid) < 3:
            return 0.0
        mean = np.mean(valid); var = np.var(valid)
        if var == 0: return 0.0
        return float(np.mean(((valid - mean) / np.sqrt(var)) ** 3))

    # ------------------------------------------------------------------
    # 1b. Log-Return Z-Score (Z-06) — momentum / breakout detection
    # ------------------------------------------------------------------
    def _log_return_z_score(self, closes: np.ndarray, window: int = 20) -> float:
        """
        Z-06: Measures whether the current price VELOCITY (log-return) is
        statistically unusual compared to recent history.  Unlike the VWAP
        Z-score which measures price LEVEL deviation (mean-reversion), this
        measures price SPEED deviation — the correct signal for TREND momentum.

        Formula (PDF §5 / Z-06):
            r_t   = ln(P_t / P_{t-1})
            r̄     = mean of last `window` log-returns
            σ_r   = std  of last `window` log-returns
            Z_ret = (r_t - r̄) / σ_r

        Output clipped to [-4, +4].  Returns 0.0 if insufficient data.
        """
        if len(closes) < window + 2:
            return 0.0
        log_rets = np.log(closes[-(window + 1):][1:] / closes[-(window + 1):][:-1])
        valid = log_rets[np.isfinite(log_rets)]
        if len(valid) < 5:
            return 0.0
        mu    = float(np.mean(valid))
        sigma = float(np.std(valid))
        if sigma < 1e-10:
            return 0.0
        z_ret = (float(valid[-1]) - mu) / sigma
        return float(np.clip(z_ret, -4.0, 4.0))

    # ------------------------------------------------------------------
    # 2. VWAP Seed — Pre-populate rolling window with correct timestamps
    # ------------------------------------------------------------------
    def seed_vwap_from_history(self, candles: list, highs: list, lows: list,
                                closes: list, vols: list) -> None:
        """
        Pre-populate _vwap_rolling with correct historical timestamps
        so Z-score is meaningful from the very first live cycle.

        candles: list of dicts with 'time' key (epoch seconds from REST response)
        Call this AFTER clearing _vwap_rolling, BEFORE the live feed starts.
        """
        import time as _time
        self._vwap_rolling.clear()
        self._vwap_num = 0.0
        self._vwap_den = 0.0

        now_ts = _time.time()
        WINDOW_SECS = 86400.0
        CANDLE_INTERVAL_SECS = 900.0   # 15m

        for i, candle in enumerate(candles):
            candle_open_ts = float(candle.get("time", 0.0))
            if candle_open_ts <= 0:
                candle_open_ts = now_ts - (len(candles) - i) * CANDLE_INTERVAL_SECS

            age = now_ts - candle_open_ts
            if age > WINDOW_SECS:
                continue

            tp  = (highs[i] + lows[i] + closes[i]) / 3.0
            vol = float(vols[i])
            self._vwap_rolling.append((tp, vol, candle_open_ts))
            self._vwap_num += tp * vol
            self._vwap_den += vol

        logger.info(
            f"[VWAP] Pre-seeded {len(self._vwap_rolling)} candles with real timestamps. "
            f"VWAP={self._vwap_num/max(self._vwap_den,1):.2f} den={self._vwap_den:.0f}"
        )

    # ------------------------------------------------------------------
    # 2. VWAP-Anchored Z-Score — Rolling 24h Window (HMM-SESSION-VWAP FIX)
    # ------------------------------------------------------------------
    def _session_vwap_z(
        self,
        highs: np.ndarray,
        lows: np.ndarray,
        closes: np.ndarray,
        vols: np.ndarray,
        current_price: float,
        atr_pct_rank: float = 0.5,
    ) -> float:
        import time as _time
        now_ts = _time.time()
        WINDOW_SECS = 86400.0  # 24 hours

        if len(closes) == 0:
            return 0.0

        # Expire candles older than 24h from the rolling deque
        while self._vwap_rolling and (now_ts - self._vwap_rolling[0][2]) > WINDOW_SECS:
            expired_tp, expired_v, _ = self._vwap_rolling.popleft()
            self._vwap_num -= expired_tp * expired_v
            self._vwap_den -= expired_v

        # Add latest candle to rolling window
        tp = float((highs[-1] + lows[-1] + closes[-1]) / 3.0)
        v = float(vols[-1])
        self._vwap_rolling.append((tp, v, now_ts))
        self._vwap_num += tp * v
        self._vwap_den += v

        if self._vwap_den <= 0:
            return 0.0
        vwap_session = self._vwap_num / self._vwap_den

        # Adaptive sigma window — exclude current candle (closes[-1]) to avoid
        # double-counting it in both the VWAP mean (vwap_session) and variance.
        n_sig = max(10, int(atr_pct_rank * 40))
        if len(closes) - 1 < n_sig:
            n_sig = max(10, len(closes) - 1)

        if n_sig <= 0:
            return 0.0

        h = highs[-n_sig-1:-1]
        l = lows[-n_sig-1:-1]
        c = closes[-n_sig-1:-1]
        vv = vols[-n_sig-1:-1]

        tp_w = (h + l + c) / 3.0
        vol_sum = np.sum(vv)
        if vol_sum <= 0:
            return 0.0

        vw_var = np.sum(vv * (tp_w - vwap_session)**2) / vol_sum
        std = np.sqrt(vw_var)

        # P1-7 FIX: Guard against near-zero std during zero-volatility periods.
        MIN_STD = current_price * 0.00005  # 0.005% of current price
        if std < MIN_STD:
            return 0.0

        # t-scale correction factor
        NU_FIXED = 6.0
        t_scale = math.sqrt((NU_FIXED - 2.0) / NU_FIXED)  # = sqrt(4/6) = 0.8165
        z = (current_price - vwap_session) / std
        return float(np.clip(z * t_scale, -4.0, 4.0))

    # ------------------------------------------------------------------
    # 3. RSI (14 period) — Wilder EMA smoothing (Fix #7 from audit)
    # ------------------------------------------------------------------
    def _rsi(self, closes: np.ndarray) -> float:
        """
        Wilder's RSI: uses exponential smoothing with α = 1/period.
        This matches TradingView, TA-Lib, and the frontend dashboard.
        SMA-based RSI under-estimates extremes — Wilder's EMA gives
        accurate 70/30 signals for overbought/oversold gate logic.
        """
        period = 14
        if len(closes) < period + 1:
            return 50.0
        delta  = np.diff(closes)
        gains  = np.where(delta > 0, delta, 0.0)
        losses = np.where(delta < 0, -delta, 0.0)

        # Seed with simple average over first `period` bars
        avg_gain = float(np.mean(gains[:period]))
        avg_loss = float(np.mean(losses[:period]))

        # Wilder EMA over remaining bars
        for i in range(period, len(gains)):
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss < 1e-10:
            return 100.0 if avg_gain > 0 else 50.0

        rs = avg_gain / avg_loss
        return float(100.0 - (100.0 / (1.0 + rs)))

    # ------------------------------------------------------------------
    # 4. Tape Speed & Dominant Side (USD-normalised)
    # ------------------------------------------------------------------
    def _tape_metrics(self):
        trades = list(self.state.recent_trades)
        now_ms = time.time() * 1000

        buy_10s = sell_10s = total_60s = 0.0
        for t in trades:
            total_60s += t['usd_volume']
            age_ms     = now_ms - t['time']
            if age_ms < 10_000:
                if t['side'] == 'BUY':
                    buy_10s += t['usd_volume']
                else:
                    sell_10s += t['usd_volume']

        total_10s    = buy_10s + sell_10s
        baseline_10s = (total_60s / 60.0) * 10 if total_60s > 0 else 0.0

        is_screaming = (
            (baseline_10s > 0 and total_10s > baseline_10s * 3)
            or total_10s > 2_000_000
        )

        if len(trades) < 5:
            return "NORMAL", "NO DATA"

        tape_speed = "SCREAMING" if is_screaming else "NORMAL"
        if buy_10s > sell_10s * 1.5:
            dominant = "BUY (ASK HIT)"
        elif sell_10s > buy_10s * 1.5:
            dominant = "SELL (BID HIT)"
        else:
            dominant = "BALANCED"

        return tape_speed, dominant

    # ------------------------------------------------------------------
    # 5. LOB Walls & OFI
    # ------------------------------------------------------------------
    def _lob_metrics(self, current_price: float):
        bids = self.state.bids
        asks = self.state.asks

        MAX_DIST   = 0.001
        valid_bids = {p: s for p, s in bids.items()
                      if (current_price - p) / current_price <= MAX_DIST}
        valid_asks = {p: s for p, s in asks.items()
                      if (p - current_price) / current_price <= MAX_DIST}

        ofi = sum(valid_bids.values()) - sum(valid_asks.values())

        all_sizes      = list(valid_bids.values()) + list(valid_asks.values())
        median_size    = float(np.median(all_sizes)) if all_sizes else 1.0
        wall_threshold = median_size * 5.0

        # PHASE-1.1: Sort by DISTANCE to price (ascending = nearest first).
        # Previously sorted by SIZE (largest first) — wrong for sweep detection.
        # Sweep = price crossing a nearby wall, not a large distant wall.
        def bid_distance(p, s):
            return (current_price - p) / current_price  # fraction of price
        def ask_distance(p, s):
            return (p - current_price) / current_price

        top_bids = sorted(
            [(p, s) for p, s in valid_bids.items() if s > wall_threshold],
            key=lambda x: bid_distance(*x),
        )[:5]
        top_asks = sorted(
            [(p, s) for p, s in valid_asks.items() if s > wall_threshold],
            key=lambda x: ask_distance(*x),
        )[:5]

        nearest_bid = top_bids[0][0] if top_bids else None
        nearest_ask = top_asks[0][0] if top_asks else None

        bid_dist = (
            f"{((current_price - nearest_bid) / current_price * 100):.2f}"
            if nearest_bid else "N/A"
        )
        ask_dist = (
            f"{((nearest_ask - current_price) / current_price * 100):.2f}"
            if nearest_ask else "N/A"
        )

        # PHASE-1.1: Top-of-book bid/ask for execution price (not wall-filtered mid).
        # Wall prices can be $50+ off actual spread on BTC; use actual best bid/ask.
        best_bid = max(self.state.bids.keys()) if self.state.bids else current_price
        best_ask = min(self.state.asks.keys()) if self.state.asks else current_price
        execution_price = (best_bid + best_ask) / 2.0 if (self.state.bids and self.state.asks) else current_price

        wall_context = (
            f"Nearest Buy Wall: {nearest_bid} (-{bid_dist}%), "
            f"Nearest Sell Wall: {nearest_ask} (+{ask_dist}%)"
        )

        wall_parts = []
        for p, s in top_asks:
            if current_price > 0:
                dist = (p - current_price) / current_price * 100
                wall_parts.append(f"SELL@{p:.1f} (+{dist:.2f}%, sz:{s:.2f})")
        for p, s in top_bids:
            if current_price > 0:
                dist = (current_price - p) / current_price * 100
                wall_parts.append(f"BUY@{p:.1f} (-{dist:.2f}%, sz:{s:.2f})")

        # ── THREE-STAGE OFI INTEGRITY PIPELINE ───────────────────────────
        # Replaces the static ±100 clamp (Links Investment Corps, Apr 2026)

        # STAGE 1 — True OFI via depth-snapshot delta
        # The bot uses depth20@100ms (full snapshots, not delta stream),
        # so we measure the CHANGE in total bid/ask depth between frames.
        # This is true Order Flow Imbalance, not just Order Book Imbalance.
        curr_bid_depth = sum(valid_bids.values())
        curr_ask_depth = sum(valid_asks.values())

        if self._prev_bid_depth == 0.0 and self._prev_ask_depth == 0.0:
            ofi_raw = 0.0  # First cycle: no delta available yet, emit neutral
        else:
            ofi_raw = (
                (curr_bid_depth - self._prev_bid_depth) -
                (curr_ask_depth - self._prev_ask_depth)
            )
        self._prev_bid_depth = curr_bid_depth
        self._prev_ask_depth = curr_ask_depth

        # STAGE 2 — MAD Persistence Filter
        # Classifies transient spikes (1-2 cycles) vs sustained extremes (3+ cycles).
        # Only sustained extremes pass through (genuine institutional pressure).
        self._ofi_history.append(ofi_raw)
        ofi_filtered = ofi_raw  # default: pass through

        # PHASE 1: Adaptive MAD Window
        atr_rank = min(max(getattr(self, '_atr_pct_rank', 0.5), 0.1), 1.0)
        target_window = max(32, min(100, round(100 * (1 - atr_rank ** 0.80))))
        self._mad_window = int(0.70 * getattr(self, '_mad_window', 32) + 0.30 * target_window)

        if len(self._ofi_history) >= self._mad_window:
            # We only use the most recent `_mad_window` elements for the MAD calculation
            arr = np.array(list(self._ofi_history)[-self._mad_window:])
            median_ofi = float(np.median(arr))
            mad = float(np.median(np.abs(arr - median_ofi)))
            mad_threshold = 3.5 * 1.4826 * mad  # 3.5σ robust boundary — NOT changed per plan

            if mad_threshold > 0 and abs(ofi_raw - median_ofi) > mad_threshold:
                self._ofi_outlier_count += 1
                if self._ofi_outlier_count < 3:
                    # Transient spike (1-2 cycles) — replace with neutral median
                    logger.debug(
                        f"[OFI-MAD] Transient outlier ({ofi_raw:.2f}) — "
                        f"replacing with median ({median_ofi:.2f})"
                    )
                    ofi_filtered = median_ofi
                else:
                    # Sustained extreme (3+ cycles) — genuine, cap at MAD boundary
                    sign = 1.0 if ofi_raw >= 0 else -1.0
                    ofi_filtered = sign * (abs(median_ofi) + mad_threshold)
                    self._ofi_outlier_count = 0
                    logger.debug(
                        f"[OFI-MAD] Sustained extreme ({ofi_raw:.2f}) — "
                        f"capped at MAD boundary ({ofi_filtered:.2f})"
                    )
            else:
                self._ofi_outlier_count = 0

        # STAGE 3 — EWMA normalisation + tanh soft saturation
        # Output is in (-1, +1). Replaces the static ±100 hard clamp.
        # tanh is monotone — preserves direction, never hard-caps genuine signals.
        LAMBDA_EWMA  = 0.94   # PHASE-4.1: Was 0.97. Half-life: ~11 obs (~2.8 min) instead of ~23 obs (~5.7 min)
        ALPHA_SMOOTH = 0.35   # PHASE-4.1: Was 0.30. Slightly faster signal response
        self._ofi_ewma_mu  = LAMBDA_EWMA * self._ofi_ewma_mu  + (1 - LAMBDA_EWMA) * ofi_filtered
        self._ofi_ewma_var = LAMBDA_EWMA * self._ofi_ewma_var + (1 - LAMBDA_EWMA) * (ofi_filtered - self._ofi_ewma_mu) ** 2
        sigma = max(math.sqrt(self._ofi_ewma_var), 1e-6)

        ofi_norm   = (ofi_filtered - self._ofi_ewma_mu) / sigma
        self._ofi_smooth = ALPHA_SMOOTH * ofi_norm + (1 - ALPHA_SMOOTH) * self._ofi_smooth
        ofi = math.tanh(self._ofi_smooth / 2.0)  # output: (-1, +1)

        # C1 FIX: Neutralize OFI when nearest wall is flagged as ghost
        # Ghost wall = wall that disappeared without being filled (spoofed size).
        # If OFI shows buy pressure but the ask wall was ghosted, the pressure is fake.
        # If OFI shows sell pressure but the bid wall was ghosted, the pressure is fake.
        if getattr(self.state, "ghost_wall_active", False):
            ghost_side = getattr(self.state, "ghost_wall_side", "")
            ghost_cancel_rate = getattr(self.state, "ghost_cancel_rate", 0.0)
            if ghost_cancel_rate > 0.5:  # Only neutralize if >50% of wall was cancelled
                if (ofi > 0 and ghost_side == "BUY") or (ofi < 0 and ghost_side == "SELL"):
                    logger.info(
                        f"[OFI-GhostWall] Neutralizing OFI={ofi:.4f} — "
                        f"ghost wall on {ghost_side} side (cancel_rate={ghost_cancel_rate:.1%})"
                    )
                    ofi = 0.0

        # OFI Warm-Up Guard (Fix B): EWMA is seeded at arbitrary values (mu=0, var=1).
        # Until the filter has processed enough samples to be meaningful, emit 0.0.
        self._ofi_cycle_count += 1
        if self._ofi_cycle_count <= OFI_WARMUP_CYCLES:
            logger.debug(
                f"[OFI-WarmUp] Cycle {self._ofi_cycle_count}/{OFI_WARMUP_CYCLES} — "
                f"emitting neutral OFI=0.0 (EWMA not settled yet, raw={ofi:.4f})"
            )
            ofi = 0.0

        logger.debug(
            f"[OFI-Pipeline] raw={ofi_raw:.2f} filtered={ofi_filtered:.2f} "
            f"norm={ofi_norm:.3f} smooth={self._ofi_smooth:.3f} final_tanh={ofi:.4f}"
        )

        return ofi, wall_context, "; ".join(wall_parts), execution_price, valid_bids, valid_asks, nearest_bid, nearest_ask, top_bids, top_asks

    # ------------------------------------------------------------------
    # 6. Bayesian Posterior P(Bull | Evidence) — Beta conjugate prior
    # ------------------------------------------------------------------
    def _bayesian(self, rsi: float, z_score: float, skewness: float,
                  ofi: float, z_ret: float = 0.0, regime: str = "NEUTRAL") -> float:
        """
        Beta(α,β) conjugate prior — self-calibrates to historical win rate.

        OFI is now in (-1, +1) from the Three-Stage Pipeline (tanh output).
        Thresholds updated from the old ±100 scale to the new ±1 scale.

        z_ret  : Log-Return Z-Score (Z-06) — velocity-based signal for TREND.
        regime : Current HMM regime — gates the z_ret likelihood to TREND only.
        """
        # ── Step 1: Beta prior ───────────────────────────────────────────────
        p_prior = self._alpha / (self._alpha + self._beta)
        p_prior = max(0.01, min(0.99, p_prior))
        prior_odds = p_prior / (1.0 - p_prior)

        # ── Step 2: RSI likelihood ───────────────────────────────────────────
        L_rsi = 1.8 if rsi > 60 else 0.55 if rsi < 40 else 1.0

        # ── Step 3: OFI + Z-Score combined gate (OFI now in (-1,+1)) ─────────
        # B3 FIX: Z-score threshold raised 1.22 → 1.50 for tighter signal gating.
        if z_score < -1.50 and ofi > 0.2:       # oversold + buying flow
            L_flow = 2.0
        elif z_score > 1.50 and ofi < -0.2:     # overbought + selling flow
            L_flow = 0.5
        else:
            L_z = 1.3 if z_score < -1.50 else 0.76 if z_score > 1.50 else 1.0
            L_o = 1.2 if ofi > 0.3 else 0.83 if ofi < -0.3 else 1.0
            L_flow = L_z * L_o

        # ── Step 4: Skewness likelihood ──────────────────────────────────────
        L_skew = 1.2 if skewness > 0.3 else 0.83 if skewness < -0.3 else 1.0

        # ── Step 4b: Z_vel likelihood — TREND regime only (C2 / tx.txt fix) ──
        # VWAP Z measures price LEVEL vs anchor (mean-reversion signal).
        # Z_vel measures price SPEED vs recent history (momentum signal).
        # In TREND regime the VWAP signal is uninformative; Z_vel fills the gap.
        # Capped at ±25% odds multiplier — conservative during cold-start prior.
        L_zvel = 1.0
        if regime == "TREND" and abs(z_ret) > 0.5:
            if z_ret > 1.5:
                L_zvel = 1.25   # Strong upward velocity → strong bullish evidence
            elif z_ret < -1.5:
                L_zvel = 0.80   # Strong downward velocity → bearish drag on long odds
            elif z_ret > 0.5:
                L_zvel = 1.10   # Mild upward momentum → slight boost
            else:
                L_zvel = 0.93   # Mild downward pressure → slight penalty

        # ── Step 5: Update odds ──────────────────────────────────────────────
        posterior_odds = prior_odds * L_rsi * L_flow * L_skew * L_zvel

        # ── Step 6: Convert back to probability ──────────────────────────────
        p_bull = posterior_odds / (1.0 + posterior_odds)

        logger.debug(
            f"[QuantEngine] Bayesian — prior={p_prior:.2%} "
            f"L_rsi={L_rsi:.2f} L_flow={L_flow:.2f} L_skew={L_skew:.2f} "
            f"L_zvel={L_zvel:.2f}(regime={regime} z_ret={z_ret:.2f}) "
            f"ofi_tanh={ofi:.4f} → posterior={p_bull:.2%}"
        )
        return float(p_bull)


    # ------------------------------------------------------------------
    # 7. ATR — Average True Range (14 periods)
    # ------------------------------------------------------------------
    def _atr(self, highs: np.ndarray, lows: np.ndarray,
             closes: np.ndarray, period: int = 14) -> float:
        """Wilder ATR — 3x period warmup ensures EMA loop always executes.
        FIX NEW-C2: Previous period+1 lookback produced empty loop.
        """
        WARMUP = period * 3  # 42 bars for period=14
        lookback = WARMUP + 1  # 43 bars total
        if len(closes) < period + 1:
            return 0.0
        if len(closes) >= lookback:
            h = highs[-lookback:]; l = lows[-lookback:]; c = closes[-lookback:]
        else:
            h = highs; l = lows; c = closes
        prev_c = c[:-1]
        tr = np.maximum(h[1:]-l[1:], np.maximum(np.abs(h[1:]-prev_c), np.abs(l[1:]-prev_c)))
        if len(tr) < period:
            return float(np.mean(tr)) if len(tr) > 0 else 0.0
        atr_val = float(np.mean(tr[:period]))
        for i in range(period, len(tr)):
            atr_val = (atr_val * (period - 1) + float(tr[i])) / period
        return float(atr_val)

    # ------------------------------------------------------------------
    # 8. Volume Point of Control (VPOC)
    # ------------------------------------------------------------------
    def _volume_poc(self, candles, n: int = 24) -> Optional[float]:
        """
        Identify the $10 price bucket with the highest cumulative traded
        volume over the last N candles (default 24 = ~6 hours on 15m bars).
        """
        candle_list = list(candles)[-n:]
        if len(candle_list) < 2:
            return None
        price_vol: Dict[int, float] = {}
        for c in candle_list:
            bucket_size = max(10.0, round(float(c["close"]) * 0.001 / 10.0) * 10)
            bucket = int(round(float(c["close"]) / bucket_size)) * bucket_size
            price_vol[bucket] = price_vol.get(bucket, 0.0) + float(c.get("volume", 0.0))
        if not price_vol:
            return None
        return float(max(price_vol, key=price_vol.get))

    # ------------------------------------------------------------------
    # CVD Divergence Detector — Institutional Alpha v2.0
    # Fixes: #1 EMA-Z normalization | #2 True ATR | #3 Swing extrema
    #        #4 Volume confirmation  | #5 Uncertainty penalty data
    # ------------------------------------------------------------------
    def _cvd_divergence(self, current_price: float, true_atr: float = 0.0, z_score: float = 0.0) -> Dict[str, Any]:
        """
        Institutional-grade CVD divergence detector operating on per-candle
        close snapshots.  All six head-office criticisms addressed.

        ── FIX #1: EMA-VARIANCE NORMALIZATION ──────────────────────────────────
        Replaces the fragile session-range denominator using Welford's online EMA.

        ── FIX #2: TRUE ATR ────────────────────────────────────────────────────
        Receives the Wilder 14-period ATR already computed in compute_metrics().

        ── FIX #3: SWING-EXTREMA ADAPTIVE LOOKBACK ─────────────────────────────
        Finds swing low/high within full snapshot window instead of fixed k-back.

        ── FIX #4: VOLUME SPIKE CONFIRMATION ───────────────────────────────────
        Institutional absorption/distribution requires elevated volume.

        ── FIX #5: SNAPSHOT COUNT FOR UNCERTAINTY SCALING ───────────────────────
        Returns n_snaps so the gate can apply data-driven penalties.

        Returns:
            {
                "type":              "BULLISH" | "BEARISH" | "NONE",
                "strength":          float ∈ [0, 1],
                "candles_confirmed": int,
                "price_delta":       float,
                "cvd_delta":         float,
                "lookback_k":        int,
                "vol_spike":         float,
                "detection_method":  "swing_extrema" | "sequential" | "none",
                "n_snaps":           int,
                "lambda":            float,
            }
        """
        λ = 0.72 + 0.20 / (1 + math.exp(1.8 * (abs(z_score) - 2.1)))

        NULL_RESULT = {
            "type": "NONE", "strength": 0.0,
            "candles_confirmed": 0, "price_delta": 0.0,
            "cvd_delta": 0.0, "lookback_k": 0,
            "vol_spike": 1.0, "detection_method": "none",
            "n_snaps": len(self._cvd_candle_snapshots),
            "lambda": λ,
        }

        snaps = list(self._cvd_candle_snapshots)
        n_snaps = len(snaps)

        # ── Post-reset cooldown ────────────────────────────────────────────────────
        # Suppress divergence for N candles after daily CVD reset.
        # Each call to _cvd_divergence() corresponds to one compute_metrics()
        # cycle (~15 s). At 5 candles = ~75 s of suppression after reset.
        if self._cvd_post_reset_cooldown > 0:
            self._cvd_post_reset_cooldown -= 1
            logger.debug(
                f"[CVDDiv] Post-reset cooldown: {self._cvd_post_reset_cooldown} cycles remain. "
                "Returning NONE to prevent ghost signal."
            )
            NULL_RESULT["n_snaps"] = n_snaps
            return NULL_RESULT

        if n_snaps < 2:
            return NULL_RESULT

        latest = snaps[-1]

        atr_ref = max(true_atr * 1.5, current_price * 0.003, 1.0)

        all_vols = [s.get("volume", 0.0) for s in snaps]
        mean_vol = float(np.mean(all_vols)) if all_vols else 1.0
        mean_vol = max(mean_vol, 1e-8)

        if n_snaps >= 2:
            latest_delta_raw = snaps[-1]["cvd"] - snaps[-2]["cvd"]
            self._cvd_delta_ewma_mu  = (λ * self._cvd_delta_ewma_mu +
                                        (1 - λ) * latest_delta_raw)
            self._cvd_delta_ewma_var = (λ * self._cvd_delta_ewma_var +
                                        (1 - λ) * (latest_delta_raw - self._cvd_delta_ewma_mu) ** 2)
            self._cvd_delta_ewma_n  += 1

        ewma_std = math.sqrt(max(self._cvd_delta_ewma_var, 1.0))

        def _norm_cvd(cvd_delta_raw: float) -> float:
            z = (cvd_delta_raw - self._cvd_delta_ewma_mu) / ewma_std
            return float(np.clip(abs(math.tanh(z / 2.0)), 0.0, 1.0))

        def _norm_price(price_delta: float) -> float:
            return float(min(abs(price_delta) / atr_ref, 1.0))

        def _norm_vol(snap_vol: float) -> float:
            spike = snap_vol / mean_vol
            return float(np.clip(math.tanh(spike / 2.0), 0.0, 1.0))

        def _age_weight(k: int) -> float:
            if k <= 4:
                return 1.0
            return math.exp(-0.30 * (k - 4))

        def _score(price_delta: float, cvd_delta_raw: float, vol_at_extreme: float, k: int) -> float:
            nP   = _norm_price(price_delta)
            nC   = _norm_cvd(cvd_delta_raw)
            nV   = _norm_vol(vol_at_extreme)
            age  = _age_weight(k)
            return age * (0.35 * nP + 0.45 * nC + 0.20 * nV)

        swing_bull_result = None
        swing_bear_result = None

        if n_snaps >= 3:
            swing_low_idx = int(np.argmin([s["low"] for s in snaps]))
            swing_low_snap = snaps[swing_low_idx]
            k_swing_bull = n_snaps - 1 - swing_low_idx

            if (swing_low_idx < n_snaps - 1 and
                    latest["low"] > swing_low_snap["low"] and
                    latest["cvd"] > swing_low_snap["cvd"]):
                price_delta_mag  = abs(latest["low"] - swing_low_snap["low"])
                cvd_delta_raw    = latest["cvd"] - swing_low_snap["cvd"]
                vol_at_low       = swing_low_snap.get("volume", mean_vol)
                s = _score(price_delta_mag, cvd_delta_raw, vol_at_low, k_swing_bull)
                swing_bull_result = (s, k_swing_bull, price_delta_mag,
                                     cvd_delta_raw, vol_at_low / mean_vol)

            swing_high_idx = int(np.argmax([s["high"] for s in snaps]))
            swing_high_snap = snaps[swing_high_idx]
            k_swing_bear = n_snaps - 1 - swing_high_idx

            if (swing_high_idx < n_snaps - 1 and
                    latest["high"] < swing_high_snap["high"] and
                    latest["cvd"] < swing_high_snap["cvd"]):
                price_delta_mag  = abs(latest["high"] - swing_high_snap["high"])
                cvd_delta_raw    = swing_high_snap["cvd"] - latest["cvd"]
                vol_at_high      = swing_high_snap.get("volume", mean_vol)
                s = _score(price_delta_mag, cvd_delta_raw, vol_at_high, k_swing_bear)
                swing_bear_result = (s, k_swing_bear, price_delta_mag,
                                     cvd_delta_raw, vol_at_high / mean_vol)

        max_k = min(8, n_snaps - 1)
        seq_bull_best  = (0.0, 0, 0.0, 0.0, 1.0)
        seq_bear_best  = (0.0, 0, 0.0, 0.0, 1.0)
        bull_confirms  = 0
        bear_confirms  = 0

        for k in range(1, max_k + 1):
            prior = snaps[-(k + 1)]

            if latest["low"] < prior["low"] and latest["cvd"] > prior["cvd"]:
                bull_confirms += 1
                pd   = prior["low"] - latest["low"]
                cd   = latest["cvd"] - prior["cvd"]
                vl   = prior.get("volume", mean_vol)
                s    = _score(pd, cd, vl, k)
                if s > seq_bull_best[0]:
                    seq_bull_best = (s, k, pd, cd, vl / mean_vol)

            if latest["high"] > prior["high"] and latest["cvd"] < prior["cvd"]:
                bear_confirms += 1
                pd   = latest["high"] - prior["high"]
                cd   = prior["cvd"] - latest["cvd"]
                vl   = prior.get("volume", mean_vol)
                s    = _score(pd, cd, vl, k)
                if s > seq_bear_best[0]:
                    seq_bear_best = (s, k, pd, cd, vl / mean_vol)

        best_bull_s, best_bull_k, best_bull_pd, best_bull_cd, best_bull_vs = 0.0, 0, 0.0, 0.0, 1.0
        best_bull_meth = "none"
        if swing_bull_result and swing_bull_result[0] >= seq_bull_best[0]:
            best_bull_s, best_bull_k, best_bull_pd, best_bull_cd, best_bull_vs = swing_bull_result
            best_bull_meth = "swing_extrema"
        elif seq_bull_best[0] > 0.0:
            best_bull_s, best_bull_k, best_bull_pd, best_bull_cd, best_bull_vs = seq_bull_best
            best_bull_meth = "sequential"

        best_bear_s, best_bear_k, best_bear_pd, best_bear_cd, best_bear_vs = 0.0, 0, 0.0, 0.0, 1.0
        best_bear_meth = "none"
        if swing_bear_result and swing_bear_result[0] >= seq_bear_best[0]:
            best_bear_s, best_bear_k, best_bear_pd, best_bear_cd, best_bear_vs = swing_bear_result
            best_bear_meth = "swing_extrema"
        elif seq_bear_best[0] > 0.0:
            best_bear_s, best_bear_k, best_bear_pd, best_bear_cd, best_bear_vs = seq_bear_best
            best_bear_meth = "sequential"

        atr_rank = min(max(getattr(self, '_atr_pct_rank', 0.5), 0.1), 1.0)
        MIN_STRENGTH = 0.10 + (0.10 * atr_rank)
        AGE_CAP_CANDLES = 8   # beyond 8 candles (~2h) in same direction = TREND, not divergence
        DECAY_RATE      = 0.15  # exp(-0.15*(streak-8)); at streak=12: factor≈0.55 → below threshold

        if best_bull_s >= MIN_STRENGTH or best_bear_s >= MIN_STRENGTH:
            # Determine winning direction BEFORE applying age cap
            winning_dir = "BULLISH" if best_bull_s >= best_bear_s else "BEARISH"
            winning_s   = best_bull_s if winning_dir == "BULLISH" else best_bear_s

            # ── Streak / Age-Cap Logic ─────────────────────────────────────────
            # Track how many consecutive candle snapshots this direction has fired.
            # If it exceeds AGE_CAP_CANDLES, the "divergence" is actually a trend —
            # decay strength so it naturally falls below MIN_STRENGTH and expires.
            if winning_dir == self._cvd_div_streak_dir:
                self._cvd_div_streak_count += 1
            else:
                self._cvd_div_streak_dir   = winning_dir
                self._cvd_div_streak_count = 1

            streak = self._cvd_div_streak_count
            MAX_STREAK_HARD_CAP = AGE_CAP_CANDLES * 3  # 24 candles (~6h): force-reset runaway streak
            if streak > MAX_STREAK_HARD_CAP:
                logger.warning(
                    f"[CVDDiv] ⛔ Hard streak cap reached ({streak}>{MAX_STREAK_HARD_CAP}). "
                    f"Resetting divergence state — stale institutional bias cleared."
                )
                self._cvd_div_streak_dir = "NONE"
                self._cvd_div_streak_count = 0
                NULL_RESULT["n_snaps"] = n_snaps
                return NULL_RESULT
            if streak > AGE_CAP_CANDLES:
                decay = math.exp(-DECAY_RATE * (streak - AGE_CAP_CANDLES))
                winning_s_decayed = winning_s * decay
                logger.debug(
                    f"[CVDDiv] Age-cap decay: dir={winning_dir} streak={streak} "
                    f"strength {winning_s:.3f} → {winning_s_decayed:.3f} (decay={decay:.3f})"
                )
                if winning_s_decayed < MIN_STRENGTH:
                    logger.info(
                        f"[CVDDiv] ⏰ {winning_dir} signal expired (streak={streak} candles, "
                        f"aged below MIN_STRENGTH={MIN_STRENGTH}). Treating as TREND, not divergence."
                    )
                    NULL_RESULT["n_snaps"] = n_snaps
                    return NULL_RESULT
                winning_s = winning_s_decayed
                if winning_dir == "BULLISH":
                    best_bull_s = winning_s
                else:
                    best_bear_s = winning_s
            # ── End Age-Cap ───────────────────────────────────────────────────

            if best_bull_s >= best_bear_s:
                logger.info(
                    f"[CVDDiv] ✅ BULLISH | strength={best_bull_s:.3f} "
                    f"method={best_bull_meth} k={best_bull_k} streak={self._cvd_div_streak_count} "
                    f"confirms={bull_confirms} vol_spike={best_bull_vs:.2f}×"
                )
                return {
                    "type":              "BULLISH",
                    "strength":          round(best_bull_s, 4),
                    "candles_confirmed": bull_confirms,
                    "price_delta":       round(best_bull_pd, 4),
                    "cvd_delta":         round(best_bull_cd, 2),
                    "lookback_k":        best_bull_k,
                    "vol_spike":         round(best_bull_vs, 3),
                    "detection_method":  best_bull_meth,
                    "n_snaps":           n_snaps,
                    "lambda":            λ,
                }
            else:
                logger.info(
                    f"[CVDDiv] ✅ BEARISH | strength={best_bear_s:.3f} "
                    f"method={best_bear_meth} k={best_bear_k} streak={self._cvd_div_streak_count} "
                    f"confirms={bear_confirms} vol_spike={best_bear_vs:.2f}×"
                )
                return {
                    "type":              "BEARISH",
                    "strength":          round(best_bear_s, 4),
                    "candles_confirmed": bear_confirms,
                    "price_delta":       round(best_bear_pd, 4),
                    "cvd_delta":         round(best_bear_cd, 2),
                    "lookback_k":        best_bear_k,
                    "vol_spike":         round(best_bear_vs, 3),
                    "detection_method":  best_bear_meth,
                    "n_snaps":           n_snaps,
                    "lambda":            λ,
                }
        else:
            # Direction changed — reset streak
            self._cvd_div_streak_dir   = "NONE"
            self._cvd_div_streak_count = 0

        NULL_RESULT["n_snaps"] = n_snaps
        return NULL_RESULT

