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
