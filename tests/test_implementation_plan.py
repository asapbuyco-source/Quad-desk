"""
tests/test_implementation_plan.py
================================
Unit tests for the implementation plan fixes.

Run with:
    python -m pytest tests/test_implementation_plan.py -v
"""

import pytest
from unittest.mock import MagicMock


class TestSignalConfigChanges:
    """Tests for signal_config.py changes."""

    def test_volatile_has_atr_multiplier_sl(self):
        """VOLATILE must have atr_multiplier_sl = 1.65."""
        from bot.signal_config import REGIME_PARAMS
        volatile = REGIME_PARAMS["VOLATILE"]
        assert "atr_multiplier_sl" in volatile
        assert volatile["atr_multiplier_sl"] == 1.65

    def test_neutral_min_confidence_is_65(self):
        """NEUTRAL min_confidence must be 0.65."""
        from bot.signal_config import REGIME_PARAMS
        neutral = REGIME_PARAMS["NEUTRAL"]
        assert neutral["min_confidence"] == 0.65


class TestRVDataStaleGuard:
    """Tests for rv_data_stale guard in _apply_rv_iv_override()."""

    def test_stale_rv_does_not_downgrade_volatile(self):
        """When rv_data_stale is True, override should NOT downgrade VOLATILE."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="VOLATILE",
            rv_iv_ratio=0.7,
            vol_state="COMPRESSION",
            rv_data_stale=True,
        )
        assert result == "VOLATILE"

    def test_fresh_rv_compression_downgrades_volatile(self):
        """When rv_data_stale is False and vol_state==COMPRESSION, downgrade."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="VOLATILE",
            rv_iv_ratio=0.7,
            vol_state="COMPRESSION",
            rv_data_stale=False,
        )
        assert result == "NEUTRAL"

    def test_fresh_rv_low_ratio_downgrades_volatile(self):
        """When rv_data_stale is False and rv_iv_ratio < 0.01, downgrade."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="VOLATILE",
            rv_iv_ratio=0.005,
            vol_state="NORMAL",
            rv_data_stale=False,
        )
        assert result == "NEUTRAL"

    def test_fresh_rv_normal_ratio_preserves_volatile(self):
        """When rv_data_stale is False but ratio/state normal, preserve VOLATILE."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="VOLATILE",
            rv_iv_ratio=0.9,
            vol_state="NORMAL",
            rv_data_stale=False,
        )
        assert result == "VOLATILE"

    def test_range_expansion_elevates_to_volatile(self):
        """RANGE + EXPANSION should elevate to VOLATILE."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="RANGE",
            rv_iv_ratio=1.3,
            vol_state="EXPANSION",
            rv_data_stale=False,
        )
        assert result == "VOLATILE"

    def test_neutral_unaffected_by_stale(self):
        """NEUTRAL regime should not be affected by stale or compression."""
        from bot.main import _apply_rv_iv_override
        result = _apply_rv_iv_override(
            regime="NEUTRAL",
            rv_iv_ratio=0.5,
            vol_state="COMPRESSION",
            rv_data_stale=True,
        )
        assert result == "NEUTRAL"


class TestRANGEMeanRevVelocityGate:
    """Tests for RANGE mean reversion velocity gate."""

    def test_range_rejects_longs_when_downside_zscore_ret_accelerating(self):
        """RANGE should reject LONG when zScore_ret is negative and < -0.5 (still falling)."""
        from bot.main import _strategy_mean_reversion

        metrics = {
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.6,
        }
        result = _strategy_mean_reversion(metrics, z_threshold=1.5)
        assert result is None, "Should reject LONG when downside zScore_ret < -0.5 (still falling)"

    def test_range_accepts_early_reversal_low_momentum(self):
        """RANGE should accept LONG when zScore_ret is small negative (not yet accelerating)."""
        from bot.main import _strategy_mean_reversion

        metrics = {
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.3,
        }
        result = _strategy_mean_reversion(metrics, z_threshold=1.5)
        assert result == "MEAN_REVERSAL_LONG", "Should accept early reversal when zScore_ret >= -0.5"

    def test_range_rejects_shorts_when_upside_zscore_ret_accelerating(self):
        """RANGE should reject SHORT when zScore_ret is positive and > 0.5 (still rising)."""
        from bot.main import _strategy_mean_reversion

        metrics = {
            "zScore": 1.5,
            "rsi": 60.0,
            "zScore_ret": 0.6,
        }
        result = _strategy_mean_reversion(metrics, z_threshold=1.5)
        assert result is None, "Should reject SHORT when upside zScore_ret > 0.5 (still rising)"

    def test_range_accepts_early_reversal_short_low_momentum(self):
        """RANGE should accept SHORT when zScore_ret is small positive (not yet accelerating)."""
        from bot.main import _strategy_mean_reversion

        metrics = {
            "zScore": 1.5,
            "rsi": 60.0,
            "zScore_ret": 0.3,
        }
        result = _strategy_mean_reversion(metrics, z_threshold=1.5)
        assert result == "MEAN_REVERSAL_SHORT", "Should accept early reversal when zScore_ret <= 0.5"

    def test_range_accepts_decelerated_reversal_long(self):
        """RANGE should accept LONG when zScore_ret is negative (reversal confirmed)."""
        from bot.main import _strategy_mean_reversion

        metrics = {
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.2,
        }
        result = _strategy_mean_reversion(metrics, z_threshold=1.5)
        assert result == "MEAN_REVERSAL_LONG", "Should accept decelerated reversal LONG"


class TestLIQUIDITYSweepVelocityGate:
    """Tests for LIQUIDITY sweep velocity gate."""

    def test_sweep_requires_impulse_threshold(self):
        """Sweep should be rejected if sweep_impulse_z_ret < 0.60."""
        from bot.main import _strategy_liquidity_sweep

        feed_state = MagicMock()
        feed_state.sweep_impulse_z_ret = 0.3

        metrics = {
            "ofi": 0.2,
            "cvd": 100.0,
            "tapeDominant": "BUY",
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.2,
        }

        result = _strategy_liquidity_sweep("BELOW_LOWS", metrics, feed_state=feed_state)
        assert result is None, "Should reject when sweep impulse < 0.60"

    def test_sweep_accepts_after_deceleration(self):
        """Sweep should be accepted when impulse >= 0.60 and zScore_ret shows reversal."""
        from bot.main import _strategy_liquidity_sweep

        feed_state = MagicMock()
        feed_state.sweep_impulse_z_ret = -0.8

        metrics = {
            "ofi": 0.2,
            "cvd": 100.0,
            "tapeDominant": "BUY",
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.3,
        }

        result = _strategy_liquidity_sweep("BELOW_LOWS", metrics, feed_state=feed_state)
        assert result == "BUY", "Should accept sweep after deceleration"

    def test_detect_sweep_preserves_original_impulse_until_confirmation(self):
        """_detect_liquidity_sweep should not overwrite impulse when re-detected."""
        from bot.main import _detect_liquidity_sweep, _strategy_liquidity_sweep

        feed_state = MagicMock()
        feed_state._live_candle_count = 5
        feed_state.last_fired_sweep_candle_ts = None
        feed_state.sweep_impulse_z_ret = None
        feed_state.sweep_impulse_candle_ts = None
        candle_history = [
            {"time": 1000.0, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.0},
            {"time": 1900.0, "open": 100.0, "high": 101.0, "low": 98.5, "close": 100.2},
        ]
        buy_walls = [99.0]
        sell_walls = [102.0]

        first_metrics = {
            "price": 100.2,
            "zScore_ret": -1.2,
        }
        sweep, _, _ = _detect_liquidity_sweep(
            first_metrics, buy_walls, sell_walls, candle_history, feed_state
        )
        assert sweep == "BELOW_LOWS"
        assert feed_state.sweep_impulse_z_ret == -1.2

        second_metrics = {
            "price": 100.2,
            "zScore_ret": -0.3,
        }
        sweep, _, _ = _detect_liquidity_sweep(
            second_metrics, buy_walls, sell_walls, candle_history, feed_state
        )
        assert sweep == "BELOW_LOWS"
        assert feed_state.sweep_impulse_z_ret == -1.2

        strategy_metrics = {
            "ofi": 0.2,
            "cvd": 100.0,
            "tapeDominant": "BUY",
            "zScore": -1.5,
            "rsi": 40.0,
            "zScore_ret": -0.3,
        }
        result = _strategy_liquidity_sweep("BELOW_LOWS", strategy_metrics, feed_state=feed_state)
        assert result == "BUY"


class TestVOLATILERoutingKE:
    """Tests for VOLATILE KE routing via _route_volatile()."""

    def test_ke_gt_45_blocks(self):
        """KE = 0.5*(3.5^2) = 6.125 > 4.5 → BLOCK."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=3.5, tape="NORMAL")
        assert result == "BLOCK"

    def test_ke_ge_032_routes_to_trend(self):
        """z_ret=1.32 → KE=0.5*(1.32^2)=0.8712 >= 0.86 boundary check. z=1.32 → KE=0.8712 → TREND."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=1.32, tape="NORMAL")
        assert result == "TREND"

    def test_ke_lt_032_screaming_blocks(self):
        """KE = 0.5*(0.5^2) = 0.125 < 0.32, tape=SCREAMING → BLOCK."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=0.5, tape="SCREAMING")
        assert result == "BLOCK"

    def test_ke_lt_032_normal_goes_mean_reversion(self):
        """KE = 0.5*(0.3^2) = 0.045 < 0.32, tape=NORMAL → MEAN_REVERSION."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=0.3, tape="NORMAL")
        assert result == "MEAN_REVERSION"

    def test_ke_exactly_45_does_not_block(self):
        """KE = 0.5*(3.0^2) = 4.5, not > 4.5 → TREND."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=3.0, tape="NORMAL")
        assert result == "TREND"

    def test_ke_zero_goes_mean_reversion(self):
        """KE = 0, tape=NORMAL → MEAN_REVERSION."""
        from bot.main import _route_volatile
        result = _route_volatile(z_ret=0.0, tape="NORMAL")
        assert result == "MEAN_REVERSION"


class TestBayesianFusionVelocityOdds:
    """Tests for Bayesian fusion velocity likelihoods."""

    def test_range_zrev_boost_when_low_zscore_ret(self):
        """RANGE should get confidence boost when abs(zScore_ret) <= 0.30."""
        from bot.main import _bayesian_fusion

        metrics = {
            "bayesianPosterior": 0.55,
            "ofi": 0.0,
            "cvd": 0.0,
            "cvd_delta": 0.0,
            "skewness": 0.0,
            "tapeDominant": "BALANCED",
            "tapeSpeed": "NORMAL",
            "rsi": 50.0,
            "zScore_ret": 0.2,
            "zScore": 0.0,
            "zScore_prev": 0.0,
        }
        feed_state = MagicMock()

        conf = _bayesian_fusion(metrics, "BUY", "RANGE", is_sweep=False, feed_state=feed_state)
        assert conf > 0.55, "RANGE with low zScore_ret should get boost"

    def test_volatile_ke_high_boost(self):
        """VOLATILE with KE >= 2.0 should get 1.20 boost."""
        from bot.main import _bayesian_fusion

        metrics = {
            "bayesianPosterior": 0.55,
            "ofi": 0.0,
            "cvd": 0.0,
            "cvd_delta": 0.0,
            "skewness": 0.0,
            "tapeDominant": "BALANCED",
            "tapeSpeed": "NORMAL",
            "rsi": 50.0,
            "zScore_ret": 2.5,
            "zScore": 2.0,
            "zScore_prev": 1.5,
        }
        feed_state = MagicMock()

        conf = _bayesian_fusion(metrics, "BUY", "VOLATILE", is_sweep=False, feed_state=feed_state)
        assert conf > 0.55, "VOLATILE with high KE should get boost"


class TestBayesOverrideTightening:
    """Tests for tightened BAYES_OVERRIDE logic."""

    def test_soft_ulis_short_vetoes_bayes_long(self):
        """Soft SHORT (not STRONG_SHORT) should veto LONG, not allow override."""
        from bot.main import _apply_ulis_gate

        metrics = {
            "bayesianPosterior": 0.85,
            "cvd_divergence": None,
        }
        candle_history = []
        feed_state = MagicMock()
        feed_state.bids = {}
        feed_state.asks = {}

        ulis_mock = MagicMock()
        ulis_mock.__getitem__ = lambda self, key: {"should_trade": True, "verdict": "SHORT", "regime_label": "NEUTRAL"}.get(key, None)
        ulis_mock.get = lambda key, default=None: {"should_trade": True, "verdict": "SHORT", "regime_label": "NEUTRAL"}.get(key, default)

        with pytest.MonkeyPatch.context() as mp:
            from bot.main import compute_ulis_verdict
            mp.setattr("bot.main.compute_ulis_verdict", lambda **kwargs: ulis_mock)

            should_trade, confidence, verdict = _apply_ulis_gate(
                metrics, candle_history, feed_state, "BUY", 0.80, "NEUTRAL"
            )

        assert should_trade is False, "Soft SHORT should veto LONG without override"


class TestTrendTrailingStop:
    """Tests for TREND trailing stop after 2R."""

    def test_trailing_stop_activates_after_2r(self):
        """Trailing stop should activate after profit >= 2R."""
        import asyncio
        from bot.executor import TradingExecutor
        from unittest.mock import MagicMock, AsyncMock, patch

        with patch("bot.executor.ccxt") as mock_ccxt:
            mock_exchange = MagicMock()
            mock_ccxt.binanceusdm.return_value = mock_exchange
            executor = TradingExecutor(
                api_key="test", api_secret="test", testnet=True, dry_run=True,
                exchange_id="binanceusdm", tg_token="", tg_chat_id=""
            )

        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 99.0,
            "initial_stop_loss": 99.0,
            "initial_risk_dist": 1.0,
            "atr_at_entry": 2.0,
            "regime": "TREND",
            "_trailing_active": False,
            "_be_locked": False,
        }

        result = asyncio.run(
            executor.check_trailing_stop(current_price=102.5, atr=2.0)
        )
        assert result is True or executor.active_position.get("_trailing_active") is True


class TestRANGEDynamicBE:
    """Tests for RANGE dynamic breakeven timing."""

    def test_range_dynamic_be_accelerates_on_reversal(self):
        """RANGE should accelerate BE when zScore_ret shows reversal."""
        from bot.executor import TradingExecutor
        from unittest.mock import MagicMock, AsyncMock, patch

        with patch("bot.executor.ccxt") as mock_ccxt:
            mock_exchange = MagicMock()
            mock_ccxt.binanceusdm.return_value = mock_exchange
            executor = TradingExecutor(
                api_key="test", api_secret="test", testnet=True, dry_run=True,
                exchange_id="binanceusdm", tg_token="", tg_chat_id=""
            )

        executor.active_position = {
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "size": 1.0,
            "entry_price": 100.0,
            "stop_loss": 99.0,
            "initial_stop_loss": 99.0,
            "initial_risk_dist": 1.0,
            "atr_at_entry": 2.0,
            "be_lock_trigger": 0.8,
            "regime": "RANGE",
            "_be_locked": False,
            "_partial_taken": False,
            "realized_partial_pnl": 0.0,
        }

        metrics = {
            "zScore_ret": 0.3,
            "cvd_divergence": None,
        }

        import asyncio
        executor.active_position = {**executor.active_position, "_be_locked": False}
        loop = asyncio.new_event_loop()
        loop.run_until_complete(executor.check_breakeven_and_partials(101.8, 2.0, metrics))
        loop.close()

        assert executor.active_position.get("_be_locked") is True
