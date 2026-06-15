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
