"""
Regression tests for microstructure spoof-resistance features.
"""

import time

from bot.data_feed import MarketState, GHOST_WALL_TTL_S


def _depth(bids=None, asks=None):
    return {
        "b": [[str(p), str(q)] for p, q in (bids or [])],
        "a": [[str(p), str(q)] for p, q in (asks or [])],
    }


def test_bid_disappearance_without_sell_trade_flags_ghost_wall():
    state = MarketState("BTCUSDT")

    state.update_depth(_depth(bids=[(100.0, 20.0), (99.0, 5.0)], asks=[(101.0, 5.0)]))
    state.update_depth(_depth(bids=[(100.0, 5.0), (99.0, 5.0)], asks=[(101.0, 5.0)]))

    assert state.ghost_wall_active is True
    assert state.ghost_wall_side == "SELL"
    assert state.ghost_wall_price == 100.0
    assert state.ghost_cancel_rate == 0.75


def test_full_wall_disappearance_flags_ghost_wall():
    state = MarketState("BTCUSDT")

    state.update_depth(_depth(bids=[(100.0, 20.0)], asks=[(101.0, 5.0)]))
    state.update_depth(_depth(bids=[], asks=[(101.0, 5.0)]))

    assert state.ghost_wall_active is True
    assert state.ghost_wall_side == "SELL"
    assert state.ghost_wall_price == 100.0
    assert state.ghost_cancel_rate == 1.0


def test_bid_disappearance_matched_by_sell_trade_not_ghost():
    state = MarketState("BTCUSDT")
    state.update_depth(_depth(bids=[(100.0, 20.0)], asks=[(101.0, 5.0)]))
    state.recent_trades.append({
        "price": 100.0,
        "side": "SELL",
        "size": 18.0,
        "usd_volume": 1800.0,
        "time": time.time() * 1000,
    })

    state.update_depth(_depth(bids=[(100.0, 5.0)], asks=[(101.0, 5.0)]))

    assert state.ghost_wall_active is False


def test_wrong_side_trade_does_not_mask_bid_ghost_wall():
    state = MarketState("BTCUSDT")
    state.update_depth(_depth(bids=[(100.0, 20.0)], asks=[(101.0, 5.0)]))
    state.recent_trades.append({
        "price": 100.0,
        "side": "BUY",
        "size": 18.0,
        "usd_volume": 1800.0,
        "time": time.time() * 1000,
    })

    state.update_depth(_depth(bids=[(100.0, 5.0)], asks=[(101.0, 5.0)]))

    assert state.ghost_wall_active is True
    assert state.ghost_wall_side == "SELL"


def test_ghost_wall_ttl_expires_on_depth_update():
    state = MarketState("BTCUSDT")
    state.ghost_wall_active = True
    state.ghost_wall_side = "BUY"
    state.ghost_wall_price = 101.0
    state.ghost_cancel_rate = 0.8
    state.ghost_wall_expire_ts = time.time() - 1

    state.update_depth(_depth(bids=[(100.0, 5.0)], asks=[(101.0, 5.0)]))

    assert state.ghost_wall_active is False
    assert state.ghost_wall_side == ""
    assert GHOST_WALL_TTL_S > 0


def test_one_sided_trade_burst_flags_ignition():
    state = MarketState("BTCUSDT")
    now_ms = time.time() * 1000
    trades = [
        {"price": 100.0 + i * 0.1, "side": "BUY", "size": 1.0, "usd_volume": 100.0, "time": now_ms - i * 20}
        for i in range(20)
    ]
    trades += [
        {"price": 99.0, "side": "BUY", "size": 1.0, "usd_volume": 99.0, "time": now_ms - 1200 - i * 200}
        for i in range(10)
    ]
    state.recent_trades.extend(trades)

    state.check_ignition()

    assert state.ignition_detected is True
    assert state.ignition_side == "BUY"
    assert state.ignition_active_until > time.time()


def test_sparse_tape_does_not_flag_ignition():
    state = MarketState("BTCUSDT")
    now_ms = time.time() * 1000
    state.recent_trades.extend([
        {"price": 100.0, "side": "BUY", "size": 1.0, "usd_volume": 100.0, "time": now_ms - 1000},
        {"price": 100.1, "side": "BUY", "size": 1.0, "usd_volume": 100.1, "time": now_ms - 500},
    ])

    state.check_ignition()

    assert state.ignition_detected is False
