import re

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/signal_config.py', 'r') as f:
    text = f.read()

text = re.sub(r'"rr_target":\s*1\.8,\s*# 1\.8:1 minimum R:R', '"rr_target":          2.3,   # 2.3:1 minimum R:R', text)
text = re.sub(r'"rr_target":\s*2\.0,', '"rr_target":          2.5,', text)
text = re.sub(r'"rr_target":\s*2\.5,', '"rr_target":          3.0,', text)
text = re.sub(r'"rr_target":\s*1\.80,\s*# Phase 4\.1: was 2\.3', '"rr_target":          2.30,  # Phase 4.1: was 2.3', text)
text = re.sub(r'"rr_target":\s*3\.0,\s*# WIDER TP: squeeze snaps back violently', '"rr_target":          3.5,   # WIDER TP: squeeze snaps back violently', text)

with open('c:/Users/pc/Desktop/projects/Quad-desk/bot/signal_config.py', 'w') as f:
    f.write(text)

print('Done')
