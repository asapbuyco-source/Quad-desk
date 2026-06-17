import math

import numpy as np

from bot.quant_engine import QuantEngine


def test_dynamic_cvd_lambda_bounds_and_shape():
    class State:
        pass

    engine = QuantEngine(State())

    low_z = engine._cvd_divergence(100.0, 1.0, z_score=0.5)["lambda"]
    high_z = engine._cvd_divergence(100.0, 1.0, z_score=3.5)["lambda"]

    assert 0.72 <= high_z <= 0.92
    assert 0.72 <= low_z <= 0.92
    assert high_z < 0.75
    assert low_z > 0.90


def test_mad_window_floor_formula():
    def get_mad_target(atr_rank):
        return max(32, min(100, round(100 * (1 - atr_rank**0.8))))

    assert get_mad_target(0.95) == 32
    assert get_mad_target(0.05) >= 90


def test_rv_iv_discriminant_uses_recent_aggtrades():
    now_ms = 1_700_000_000_000.0
    prices = [100.0, 101.0, 102.0, 101.0, 103.0, 104.0]
    trades = [
        {"price": price, "time": now_ms - idx * 1_000}
        for idx, price in enumerate(prices)
    ]

    result = QuantEngine._rv_iv_discriminant(
        trades=trades,
        closes=np.array([100.0, 100.1, 100.2]),
        atr=0.5,
        current_price=104.0,
        now_ms=now_ms,
    )

    assert result["rv_data_stale"] is False
    assert result["rv_iv_ratio"] > 0
    assert result["vol_state"] in {"COMPRESSION", "EXPANSION", "NORMAL"}


def test_rv_iv_discriminant():
    # Simulate RV calculation from ticks
    prices = [100.0, 100.5, 101.0, 100.8, 101.2]
    tick_returns = np.diff(np.log(prices))
    
    import math
    rv = float(np.std(tick_returns)) * math.sqrt(len(tick_returns))
    
    atr = 0.5
    current_price = 101.2
    iv_proxy = atr / current_price
    
    rv_iv_ratio = rv / iv_proxy
    assert rv_iv_ratio > 0
    vol_state = "COMPRESSION" if rv_iv_ratio < 0.8 else ("EXPANSION" if rv_iv_ratio > 1.2 else "NORMAL")
    assert vol_state in ["COMPRESSION", "EXPANSION", "NORMAL"]


def test_volatile_hard_cap_is_1200():
    """FIX-3: VOLATILE time_exit_hard_cap_s must be 1200s (20min), NOT equal to time_exit_sec."""
    from bot.signal_config import REGIME_PARAMS
    volatile = REGIME_PARAMS["VOLATILE"]
    assert volatile["time_exit_hard_cap_s"] == 1200, (
        f"Expected 1200, got {volatile.get('time_exit_hard_cap_s')}"
    )
    # Also confirm the two-tier structure: hard cap > base
    assert volatile["time_exit_hard_cap_s"] > volatile["time_exit_sec"], (
        "Hard cap must be strictly greater than base time_exit_sec"
    )


def test_all_regimes_have_hard_cap():
    """FIX-3: All regime entries must explicitly define time_exit_hard_cap_s."""
    from bot.signal_config import REGIME_PARAMS
    for regime_name, params in REGIME_PARAMS.items():
        assert "time_exit_hard_cap_s" in params, (
            f"REGIME_PARAMS['{regime_name}'] is missing time_exit_hard_cap_s"
        )
        assert params["time_exit_hard_cap_s"] > params["time_exit_sec"], (
            f"REGIME_PARAMS['{regime_name}'] hard cap must exceed base time_exit_sec"
        )


def test_rv_iv_discriminant_marks_sparse_ticks_stale_and_falls_back():
    now_ms = 1_700_000_000_000.0
    trades = [{"price": 100.0, "time": now_ms - 1_000}]

    result = QuantEngine._rv_iv_discriminant(
        trades=trades,
        closes=np.array([100.0, 100.5, 101.0]),
        atr=0.5,
        current_price=101.0,
        now_ms=now_ms,
    )

    assert result["rv_data_stale"] is True
    assert math.isfinite(result["rv_iv_ratio"])
    assert result["vol_state"] in {"COMPRESSION", "EXPANSION", "NORMAL"}


# ── Phase 0 / B2: Regression tests for configurable RV/IV windows ────────────

def test_rv_iv_discriminant_configurable_window_normal():
    """B2 FIX: RV/IV should accept configurable window_ms and return rv_window_ms."""
    now_ms = 1_700_000_000_000.0
    prices = [100.0, 101.0, 102.0, 101.0, 103.0, 104.0]
    trades = [
        {"price": price, "time": now_ms - idx * 1_000}
        for idx, price in enumerate(prices)
    ]

    result = QuantEngine._rv_iv_discriminant(
        trades=trades,
        closes=np.array([100.0, 100.1, 100.2]),
        atr=0.5,
        current_price=104.0,
        now_ms=now_ms,
        window_ms=30_000,
        min_ticks=5,
    )

    assert result["rv_data_stale"] is False
    assert result["rv_window_ms"] == 30_000
    assert result["rv_tick_count"] == 6
    assert result["vol_state"] in {"COMPRESSION", "EXPANSION", "NORMAL"}


def test_rv_iv_discriminant_configurable_window_vol():
    """B2 FIX: RV/IV should use 120s window when high-vol conditions are signaled."""
    now_ms = 1_700_000_000_000.0
    prices = [100.0, 101.0, 102.0, 101.0, 103.0, 104.0, 105.0, 106.0]
    trades = [
        {"price": price, "time": now_ms - idx * 500}  # 8 trades in ~4s
        for idx, price in enumerate(prices)
    ]

    result = QuantEngine._rv_iv_discriminant(
        trades=trades,
        closes=np.array([100.0, 100.1, 100.2]),
        atr=0.5,
        current_price=106.0,
        now_ms=now_ms,
        window_ms=120_000,
        min_ticks=5,
    )

    assert result["rv_data_stale"] is False
    assert result["rv_window_ms"] == 120_000
    assert result["rv_tick_count"] == 8


# ── Phase 0 / A2: Regression test for extended TREND time exit ────────────────

def test_trend_time_exit_extended():
    """A2 FIX: TREND time_exit_sec must be 5400s (90min), not 1800s (30min)."""
    from bot.signal_config import REGIME_PARAMS
    trend = REGIME_PARAMS["TREND"]
    assert trend["time_exit_sec"] == 5400, (
        f"Expected 5400, got {trend.get('time_exit_sec')}"
    )
    assert trend["time_exit_hard_cap_s"] == 10800, (
        f"Expected 10800, got {trend.get('time_exit_hard_cap_s')}"
    )
    assert trend["time_exit_hard_cap_s"] > trend["time_exit_sec"], (
        "Hard cap must be strictly greater than base time_exit_sec"
    )


def test_trend_time_exit_longer_than_other_regimes():
    """A2 FIX: TREND must have longer time exits than RANGE, LIQUIDITY, VOLATILE."""
    from bot.signal_config import REGIME_PARAMS
    trend = REGIME_PARAMS["TREND"]
    for regime in ("RANGE", "LIQUIDITY", "VOLATILE", "NEUTRAL"):
        params = REGIME_PARAMS[regime]
        assert trend["time_exit_sec"] > params["time_exit_sec"], (
            f"TREND time_exit_sec ({trend['time_exit_sec']}) should exceed "
            f"{regime} ({params['time_exit_sec']})"
        )
        assert trend["time_exit_hard_cap_s"] > params["time_exit_hard_cap_s"], (
            f"TREND hard_cap ({trend['time_exit_hard_cap_s']}) should exceed "
            f"{regime} ({params['time_exit_hard_cap_s']})"
        )


def test_volatile_has_atr_multiplier_sl():
    """VOLATILE must have atr_multiplier_sl configured."""
    from bot.signal_config import REGIME_PARAMS
    volatile = REGIME_PARAMS["VOLATILE"]
    assert "atr_multiplier_sl" in volatile, "VOLATILE missing atr_multiplier_sl"
    assert volatile["atr_multiplier_sl"] == 1.65, f"Expected 1.65, got {volatile['atr_multiplier_sl']}"


def test_neutral_min_confidence_is_65():
    """NEUTRAL min_confidence must be 0.65."""
    from bot.signal_config import REGIME_PARAMS
    neutral = REGIME_PARAMS["NEUTRAL"]
    assert neutral["min_confidence"] == 0.65, f"Expected 0.65, got {neutral['min_confidence']}"
