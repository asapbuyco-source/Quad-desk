import os as _os
import warnings as _warnings

_BAK_FILES = [
    "main.bak_20260511_143742",
    "quant_engine.bak_20260511_143743",
]
for _f in _BAK_FILES:
    _p = _os.path.join(_os.path.dirname(__file__), _f)
    if _os.path.exists(_p):
        _warnings.warn(
            f"[bot] Stale backup file found: {_f}. Delete it to prevent accidental use.",
            RuntimeWarning,
            stacklevel=2,
        )
