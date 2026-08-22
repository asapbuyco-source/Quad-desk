"""
bot/hmm_features.py
====================
Single source of truth for HMM feature schema.

F-01 FIX: The HMM calibration pipeline and the live classifier MUST agree on
the feature vector dimension and ordering.  Previously this was enforced by
a hardcoded `mu.shape != self._MU.shape` check which silently fell back to
stale 4D defaults every time calibration produced 6D output.  The schema
identity check replaces the shape check with a named, order-sensitive
feature list that must match exactly.
"""

FEATURE_SCHEMA_V2 = (
    "atr_pct",            # f0  — ATR as fraction of price
    "abs_z",              # f1  — absolute VWAP Z-score
    "tape_bin",           # f2  — 1.0 if tape == SCREAMING else 0.0
    "atr_rank",           # f3  — ATR percentile rank [0,1]
    "abs_zret",           # f4  — absolute Z-score return (kinetic energy proxy)
    "funding_rate_x1000", # f5  — funding_rate × 1000 (bounded -3,+3)
    "sma_disp",           # f6  — SIGNED displacement from 100-bar SMA (directional trend strength)
)

N_FEATURES = len(FEATURE_SCHEMA_V2)  # 7


def schema_identity_match(expected_schema, actual_schema):
    """Return True if the schemas are identical (same features, same order)."""
    if expected_schema is None:
        return False
    if len(expected_schema) != len(actual_schema):
        return False
    return tuple(expected_schema) == tuple(actual_schema)


def validate_calibrated_output(data: dict) -> bool:
    """Validate that a calibrator output dict has the correct schema."""
    schema = data.get("meta", {}).get("feature_schema", None)
    return schema is not None and schema_identity_match(FEATURE_SCHEMA_V2, schema)
