import time

from bot.derivatives_context import compute_gex_for_strikes


def test_gex_uses_signed_put_call_exposure():
    expiry_ms = int((time.time() + 7 * 86400) * 1000)
    instruments = [
        {
            "instrument_name": "BTC-12JUN26-60000-C",
            "open_interest": 10,
            "mark_iv": 60,
            "expiration": expiry_ms,
        },
        {
            "instrument_name": "BTC-12JUN26-60000-P",
            "open_interest": 20,
            "mark_iv": 60,
            "expiration": expiry_ms,
        },
    ]

    result = compute_gex_for_strikes(60000, instruments, gex_threshold_btc=0.000001)

    assert result["gex_is_signed"] is True
    assert result["total_gex"] < 0
    assert result["dominant_signal"] == "SWEEP"
    assert 60000.0 in result["sweep_zones"]
