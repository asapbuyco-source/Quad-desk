import pytest

import bot.main as main


def test_daily_loss_limit_uses_day_start_equity_not_session_pnl(monkeypatch):
    monkeypatch.setattr(main, "MAX_DAILY_LOSS_PCT", 3.0)
    stats = {
        "day_start_equity": 500.0,
        "session_pnl": -100.0,
    }

    assert main._daily_loss_limit_usd(stats) == pytest.approx(15.0)


def test_day_start_equity_initializes_from_account_size(monkeypatch):
    monkeypatch.setattr(main, "ACCOUNT_SIZE", 250.0)
    stats = {"day_start_equity": 0.0}

    assert main._day_start_equity(stats) == pytest.approx(250.0)
    assert stats["day_start_equity"] == pytest.approx(250.0)
