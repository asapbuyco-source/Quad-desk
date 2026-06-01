import math, logging
from collections import deque
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

class AmihudEngine:
    """Computes Amihud (linear) + KE (squared) variants,
    applies log-normalisation, returns rolling percentile ranks.
    Low amihud_rank → liquid (TREND). High → vacuum (SQUEEZE)."""

    def __init__(self, window=500, min_buffer=100,
                 epsilon=1e-10, hysteresis_n=3):
        self.window = window; self.min_buffer = min_buffer
        self.epsilon = epsilon; self.hysteresis_n = hysteresis_n
        self._illiq_buf = deque(maxlen=window)
        self._ke_buf    = deque(maxlen=window)
        self._pending_label  = None; self._pending_count = 0
        self._confirmed_label = "FLUID"
        self._trade_count = 0
        self._last_price: float = 0.0

    def on_trade(self, price: float, qty: float, is_taker: bool) -> None:
        """Ingest one aggTrade tick. Call in aggTrade WebSocket handler.

        Args:
            price:    Fill price of this trade tick
            qty:      Quantity of this trade tick
            is_taker: True if buyer was the taker (aggressive), False if maker
        """
        if qty <= self.epsilon or self._last_price <= self.epsilon or price <= self.epsilon:
            self._last_price = price
            return

        self._trade_count += 1
        delta_price = abs(price - self._last_price)
        taker_dollar_vol = qty * price

        illiq_raw = delta_price / (taker_dollar_vol + self.epsilon)
        self._illiq_buf.append(math.log(illiq_raw + self.epsilon))

        ke_raw = (delta_price ** 2) / (taker_dollar_vol + self.epsilon)
        self._ke_buf.append(math.log(ke_raw + self.epsilon))

        self._last_price = price

    def get_features(self) -> Tuple[float, float]:
        """Returns (amihud_rank, t_kinetic_rank) in [0,1].
        Returns (0.5, 0.5) neutral until buffer is warm."""
        if self._trade_count < self.min_buffer:
            return 0.5, 0.5
        return (self._percentile_rank(self._illiq_buf),
                self._percentile_rank(self._ke_buf))

    @staticmethod
    def _percentile_rank(buf) -> float:
        if len(buf) < 2:
            return 0.5
        current = buf[-1]
        return sum(1 for v in buf if v < current) / len(buf)

    def regime_label(self, amihud_rank: float) -> str:
        """Three-zone label with hysteresis flicker prevention."""
        raw = ("SOLID" if amihud_rank < 0.20 else
               ("VAPOR" if amihud_rank > 0.80 else "FLUID"))
        if raw == self._pending_label:
            self._pending_count += 1
            if self._pending_count >= self.hysteresis_n:
                self._confirmed_label = raw; self._pending_count = 0
        else:
            self._pending_label = raw; self._pending_count = 1
        return self._confirmed_label

    @property
    def is_warm(self) -> bool:
        return self._trade_count >= self.min_buffer

    def reset(self) -> None:
        """Call on WebSocket reconnect or session boundary."""
        self._illiq_buf.clear(); self._ke_buf.clear()
        self._trade_count = 0; self._pending_label = None
        self._pending_count = 0; self._confirmed_label = "FLUID"
        self._last_price = 0.0
        logger.info("[AmihudEngine] Reset — buffer cleared")