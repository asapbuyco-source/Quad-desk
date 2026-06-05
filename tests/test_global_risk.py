import pytest

from bot.global_risk import GlobalRiskConfig, validate_symbols_against_global_risk


def test_global_risk_allows_symbols_inside_aggregate_cap():
    cfg = GlobalRiskConfig(max_symbols=3, max_total_risk_pct=2.0, per_symbol_risk_pct=1.0)

    validate_symbols_against_global_risk(["BTC/USDT", "ETH/USDT"], cfg)


def test_global_risk_blocks_too_many_symbols():
    cfg = GlobalRiskConfig(max_symbols=2, max_total_risk_pct=5.0, per_symbol_risk_pct=1.0)

    with pytest.raises(ValueError, match="BOT_MAX_SYMBOLS"):
        validate_symbols_against_global_risk(["BTC/USDT", "ETH/USDT", "SOL/USDT"], cfg)


def test_global_risk_blocks_aggregate_risk_over_cap():
    cfg = GlobalRiskConfig(max_symbols=5, max_total_risk_pct=2.0, per_symbol_risk_pct=0.75)

    with pytest.raises(ValueError, match="Aggregate configured risk"):
        validate_symbols_against_global_risk(["BTC/USDT", "ETH/USDT", "SOL/USDT"], cfg)

