import asyncio
from bot.data_feed import MarketState
from bot.quant_engine import QuantEngine

def test_lob_metrics():
    # 1. Setup mock state
    state = MarketState("BTCUSDT")
    
    # 2. Add realistic bids and asks
    # Current price around 60000
    current_price = 60000.0
    
    # Valid bids (within 0.5% => down to 59700)
    state.bids = {
        59900.0: 1.5,
        59800.0: 2.0,
        59750.0: 10.0, # Wall
        
        # Spoof bids (far away, shouldn't be counted) -> 5%, down to 57000
        57500.0: 100.0,
        57000.0: 500.0
    }
    
    # Valid asks (within 0.5% => up to 60300)
    state.asks = {
        60100.0: 1.0,
        60200.0: 2.5,
        
        # Spoof asks (far away)
        62000.0: 200.0,
        63000.0: 300.0
    }
    
    engine = QuantEngine(state)
    ofi, wall_context, all_walls, *_ = engine._lob_metrics(current_price)
    
    print("=== Anti-Spoofing Verification ===")
    print(f"OFI (Should only count near orders, skipping 100s/500s spoof size): {ofi}")
    print(f"Wall Context: {wall_context}")
    print(f"All Walls: {all_walls}")

    assert "57500" not in all_walls
    assert "57000" not in all_walls
    assert "62000" not in all_walls
    assert "63000" not in all_walls

if __name__ == "__main__":
    test_lob_metrics()
