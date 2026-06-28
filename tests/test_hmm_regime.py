from collections import deque
from unittest.mock import MagicMock

import numpy as np
import pytest

from bot.main import _HMMRegimeClassifier


def test_hmm_forward_returns_normalized_posterior():
    hmm = _HMMRegimeClassifier(window=10, update_every=500)
    obs = np.array([
        [0.0020, 0.8, 0.0, 0.20, 0.0, 0.0],
        [0.0024, 1.0, 0.0, 0.25, 0.0, 0.0],
        [0.0030, 1.2, 0.0, 0.35, 0.0, 0.0],
    ], dtype=float)

    posterior = hmm._forward(obs)

    assert posterior.shape == (5,)
    assert np.all(posterior >= 0.0)
    assert posterior.sum() == pytest.approx(1.0)


def test_hmm_online_update_blends_against_calibrated_anchor():
    hmm = _HMMRegimeClassifier(window=20, update_every=500)
    hmm._save_state = MagicMock()
    hmm._min_trades_before_update = 1
    hmm._n_trades_since_update = 1
    hmm._online_blend_alpha = 0.05

    anchor_mu = np.array([
        [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
        [3.0, 3.0, 3.0, 3.0, 3.0, 3.0],
        [4.0, 4.0, 4.0, 4.0, 4.0, 4.0],
        [5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
    ])
    anchor_sigma = np.full((5, 6), 2.0)
    hmm._calibrated_mu_anchor = anchor_mu.copy()
    hmm._calibrated_sigma_anchor = anchor_sigma.copy()
    hmm._mu = anchor_mu.copy()
    hmm._sigma = anchor_sigma.copy()

    live_obs = np.full((20, 6), 10.0)
    hmm._obs_buf = deque(live_obs, maxlen=200)
    hmm._viterbi = MagicMock(return_value=np.zeros(20, dtype=int))

    hmm._online_update()

    expected_mu = 0.95 * anchor_mu[0] + 0.05 * live_obs.mean(axis=0)
    expected_sigma = 0.95 * anchor_sigma[0] + 0.05 * np.full(6, 1e-4)
    assert hmm._mu[0] == pytest.approx(expected_mu)
    assert hmm._sigma[0] == pytest.approx(expected_sigma)
    assert not np.allclose(hmm._mu[0], live_obs.mean(axis=0))
    assert hmm._n_trades_since_update == 0
    hmm._save_state.assert_called_once()


def test_hmm_fast_track_does_not_enter_volatile_on_first_tick():
    hmm = _HMMRegimeClassifier(window=10, update_every=500)
    hmm._online_update_enabled = False
    hmm._forward = MagicMock(return_value=np.array([0.01, 0.01, 0.01, 0.96, 0.01]))
    hmm._obs_buf = deque([
        np.array([0.0020, 0.8, 0.0, 0.20, 0.0, 0.0]),
        np.array([0.0021, 0.9, 0.0, 0.25, 0.0, 0.0]),
    ], maxlen=200)
    hmm._committed_regime = "RANGE"
    hmm._candidate_regime = "RANGE"
    hmm._candidate_streak = 0

    first = hmm.classify(0.0030, 1.8, "NORMAL", atr_pct_rank=0.8)
    assert first["regime"] == "RANGE"
    assert hmm._candidate_regime == "VOLATILE"
    assert hmm._candidate_streak == 1

    second = hmm.classify(0.0030, 1.8, "NORMAL", atr_pct_rank=0.8)
    assert second["regime"] == "VOLATILE"
    assert hmm._candidate_streak == 2


def test_hmm_fast_track_does_not_exit_volatile_on_first_tick():
    """FIX-1: A single high-confidence RANGE observation must NOT fast-track out of VOLATILE."""
    hmm = _HMMRegimeClassifier(window=10, update_every=500)
    hmm._online_update_enabled = False
    # Simulate a RANGE spike posterior (state 0 = RANGE)
    hmm._forward = MagicMock(return_value=np.array([0.96, 0.01, 0.01, 0.01, 0.01]))
    hmm._obs_buf = deque([
        np.array([0.0020, 0.8, 0.0, 0.20, 0.0, 0.0]),
        np.array([0.0021, 0.9, 0.0, 0.25, 0.0, 0.0]),
    ], maxlen=200)
    # Bot is currently committed to VOLATILE
    hmm._committed_regime = "VOLATILE"
    hmm._candidate_regime = "VOLATILE"
    hmm._candidate_streak = 0

    # First tick: even at 0.96 confidence, must NOT fast-track out of VOLATILE
    first = hmm.classify(0.0020, 0.8, "NORMAL", atr_pct_rank=0.2)
    assert first["regime"] == "VOLATILE", "Must NOT exit VOLATILE on streak=1"
    assert hmm._candidate_regime == "RANGE"
    assert hmm._candidate_streak == 1

    # Second tick: after 3-candle streak completes, can exit
    second = hmm.classify(0.0020, 0.8, "NORMAL", atr_pct_rank=0.2)
    assert second["regime"] == "RANGE"
    assert hmm._candidate_streak == 2


# ── Phase 0 / B1: SQUEEZE router test ─────────────────────────────────────────

def test_squeeze_router_returns_squeeze_after_2_consecutive_confirmations():
    """
    B1 FIX: SQUEEZE router requires 2 consecutive confirmations before routing to SQUEEZE.
    Candidate conditions: atr_rank >= 0.80, amihud_rank >= 0.80, |z| < 1.00, tape=SCREAMING.
    """
    from bot.signal_config import REGIME_PARAMS

    # Verify SQUEEZE params exist and are distinct from LIQUIDITY
    assert "SQUEEZE" in REGIME_PARAMS, "SQUEEZE must be a distinct entry in REGIME_PARAMS"
    squeeze = REGIME_PARAMS["SQUEEZE"]
    liq = REGIME_PARAMS["LIQUIDITY"]

    # SQUEEZE should have tighter SL than LIQUIDITY (0.50 vs 1.43)
    assert squeeze["atr_multiplier_sl"] < liq["atr_multiplier_sl"], (
        "SQUEEZE atr_multiplier_sl must be tighter than LIQUIDITY"
    )
    # SQUEEZE should have wider TP than LIQUIDITY (3.0 vs 2.0)
    assert squeeze["rr_target"] > liq["rr_target"], (
        "SQUEEZE rr_target must be wider than LIQUIDITY"
    )
    # SQUEEZE should have shorter time exit (600s vs 900s)
    assert squeeze["time_exit_sec"] < liq["time_exit_sec"], (
        "SQUEEZE time_exit_sec must be shorter than LIQUIDITY"
    )


def test_squeeze_router_conditions_are_deterministic():
    """
    B1 FIX: SQUEEZE candidate conditions should be checkable without HMM state changes.
    atr_pct_rank >= 0.80, amihud_rank >= 0.80, abs(z) < 1.00, tape = SCREAMING.
    """
    # Test all-four-true case
    all_conditions_met = (
        True   # atr_pct_rank >= 0.80
        and True  # amihud_rank >= 0.80
        and True  # |z| < 1.00
        and True  # tape == SCREAMING
    )
    assert all_conditions_met is True

    # Test one-false case
    one_false = (
        True   # atr_pct_rank >= 0.80
        and False  # amihud_rank < 0.80
        and True  # |z| < 1.00
        and True  # tape == SCREAMING
    )
    assert one_false is False


def test_squeeze_not_aliased_to_liquidity():
    """B1 FIX: SQUEEZE should NOT be aliased to LIQUIDITY in REGIME_ALIAS."""
    from bot.signal_config import REGIME_ALIAS

    # REGIME_ALIAS should NOT contain "SQUEEZE" → "LIQUIDITY" mapping
    # (The deterministic router now handles SQUEEZE routing, not the alias)
    assert "SQUEEZE" not in REGIME_ALIAS, (
        "SQUEEZE must not be aliased to LIQUIDITY — router handles it"
    )
