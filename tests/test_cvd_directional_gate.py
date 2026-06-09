import pytest

from bot.main import (
    _apply_cvd_confidence_adjustment,
    _build_cvd_directional_adjustment,
    _enforce_cvd_confidence_cap,
)


def test_opposing_bullish_divergence_vetoes_short_without_volume_spike():
    metrics = {
        "cvd_divergence": {
            "type": "BULLISH",
            "strength": 0.789,
            "candles_confirmed": 2,
            "vol_spike": 0.51,
            "detection_method": "sequential",
            "n_snaps": 3,
        }
    }

    adjustment, veto = _build_cvd_directional_adjustment("SELL", metrics)

    assert adjustment["kind"] == "opposing_veto"
    assert "opposes SELL" in veto


def test_opposing_divergence_cap_survives_later_boosts():
    metrics = {
        "cvd_divergence": {
            "type": "BULLISH",
            "strength": 0.513,
            "candles_confirmed": 3,
            "vol_spike": 2.37,
            "detection_method": "swing_extrema",
            "n_snaps": 2,
        }
    }

    adjustment, veto = _build_cvd_directional_adjustment("SELL", metrics)
    assert veto is None
    assert adjustment["cap"] == pytest.approx(0.60)

    confidence = _apply_cvd_confidence_adjustment(0.7146, adjustment)
    boosted = confidence + 0.08
    capped = _enforce_cvd_confidence_cap(boosted, adjustment, "unit-test")

    assert capped == pytest.approx(0.60)


def test_confirming_bearish_divergence_boosts_short_directionally():
    metrics = {
        "cvd_divergence": {
            "type": "BEARISH",
            "strength": 0.70,
            "candles_confirmed": 1,
            "vol_spike": 1.50,
            "detection_method": "swing_extrema",
            "n_snaps": 3,
        }
    }

    adjustment, veto = _build_cvd_directional_adjustment("SELL", metrics)
    adjusted = _apply_cvd_confidence_adjustment(0.60, adjustment)

    assert veto is None
    assert adjustment["kind"] == "confirming"
    assert adjusted > 0.60
