import re

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/main.py', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Update classify signature
sig_target = """    def classify(self, atr_pct: float, z_score: float, tape: str,
                 atr_pct_rank: float = 0.5,
                 amihud_rank: float = 0.5,
                 t_kinetic: float = 0.5,
                 cvd_momentum: float = 0.0) -> dict:"""

sig_replacement = """    def classify(self, atr_pct: float, z_score: float, tape: str,
                 atr_pct_rank: float = 0.5,
                 amihud_rank: float = 0.5,
                 t_kinetic: float = 0.5,
                 cvd_momentum: float = 0.0,
                 z_ret: float = 0.0,
                 funding_rate: float = 0.0) -> dict:"""

if sig_target in text:
    text = text.replace(sig_target, sig_replacement)
else:
    print("Failed to match classify signature")

# 2. Update obs array
obs_target = """        obs = np.array([
            float(np.clip(atr_pct,       0.0,  0.03)),   # f0: atr_pct (0-3% range, matches calibration)
            float(np.clip(abs(z_score),  0.0,  4.0)),     # f1: |z| raw scale (matches calibration)
            1.0 if tape == "SCREAMING" else 0.0,        # f2: tape binary
            float(np.clip(atr_pct_rank,  0.0,  1.0)),    # f3: atr percentile rank
        ], dtype=float)"""

obs_replacement = """        obs = np.array([
            float(np.clip(atr_pct,       0.0,  0.03)),   # f0: atr_pct (0-3% range, matches calibration)
            float(np.clip(abs(z_score),  0.0,  4.0)),     # f1: |z| raw scale (matches calibration)
            1.0 if tape == "SCREAMING" else 0.0,        # f2: tape binary
            float(np.clip(atr_pct_rank,  0.0,  1.0)),    # f3: atr percentile rank
            float(np.clip(abs(z_ret),    0.0,  4.0)),    # f4: |z_ret| log-return velocity
            float(np.clip(funding_rate * 1000, -2.0, 2.0)), # f5: funding rate
        ], dtype=float)"""

if obs_target in text:
    text = text.replace(obs_target, obs_replacement)
else:
    print("Failed to match obs array")

# 3. Update _detect_regime call
call_target = """    cvd_momentum = float(metrics.get("cvd_delta", 0.0) or 0.0)
    hmm_result = _hmm_classifier.classify(_atr_pct_normalised, z, tape, atr_pct_rank, amihud_rank, t_kinetic, cvd_momentum=cvd_momentum)"""

call_replacement = """    cvd_momentum = float(metrics.get("cvd_delta", 0.0) or 0.0)
    z_ret = float(metrics.get("zScore_ret", 0.0))
    funding_rate = float(metrics.get("funding_rate", 0.0))
    hmm_result = _hmm_classifier.classify(_atr_pct_normalised, z, tape, atr_pct_rank, amihud_rank, t_kinetic, cvd_momentum=cvd_momentum, z_ret=z_ret, funding_rate=funding_rate)"""

if call_target in text:
    text = text.replace(call_target, call_replacement)
else:
    print("Failed to match classify call")

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/main.py', 'w', encoding='utf-8') as f:
    f.write(text)

print("main.py patched!")
