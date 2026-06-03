path = r'c:\Users\pc\Desktop\projects\Quad-desk\bot\main.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old = (
    "        if vol_spike >= 1.40:\r\n"
    "            penalty = min(penalty + 0.02, 0.12)\r\n"
    "\r\n"
    "        adjusted = max(0.0, current_confidence - penalty)\r\n"
    "        logger.info(\r\n"
    "            f\"[CVDGate] \u26a0\ufe0f  OPPOSING {div_type} | \"\r\n"
    "            f\"strength={div_str:.3f} method={method} \"\r\n"
    "            f\"confirms={confirms} vol={vol_spike:.2f}\u00d7 | \"\r\n"
    "            f\"penalty={penalty:.2%} \u2192 conf {current_confidence:.2%} \u2192 {adjusted:.2%}\"\r\n"
    "        )\r\n"
    "        return adjusted, None\r\n"
    "\r\n"
    "    return current_confidence, None"
)

new = (
    "        if vol_spike >= 1.40:\r\n"
    "            penalty = min(penalty + 0.02, 0.12)\r\n"
    "\r\n"
    "        # FIX-CVD: In TREND regime (raw BUY/SELL signals) an opposing CVD\r\n"
    "        # divergence is more likely a consolidation within the trend than a\r\n"
    "        # genuine institutional reversal. The log showed the bot correctly\r\n"
    "        # identified a SELL in a sustained BEAR TREND but a 9% CVD penalty\r\n"
    "        # knocked confidence below the Bayes floor, blocking a valid trade\r\n"
    "        # while price continued crashing. Halve soft penalty in TREND regime.\r\n"
    "        # Hard VETO thresholds above are intentionally unchanged.\r\n"
    "        if raw_direction in (\"BUY\", \"SELL\"):\r\n"
    "            penalty = penalty * 0.5\r\n"
    "            logger.debug(\r\n"
    "                f\"[CVDGate] TREND direction: opposing CVD penalty halved \u2192 {penalty:.2%}\"\r\n"
    "            )\r\n"
    "\r\n"
    "        adjusted = max(0.0, current_confidence - penalty)\r\n"
    "        logger.info(\r\n"
    "            f\"[CVDGate] \u26a0\ufe0f  OPPOSING {div_type} | \"\r\n"
    "            f\"strength={div_str:.3f} method={method} \"\r\n"
    "            f\"confirms={confirms} vol={vol_spike:.2f}\u00d7 | \"\r\n"
    "            f\"penalty={penalty:.2%} \u2192 conf {current_confidence:.2%} \u2192 {adjusted:.2%}\"\r\n"
    "        )\r\n"
    "        return adjusted, None\r\n"
    "\r\n"
    "    return current_confidence, None"
)

assert old in content, "CVD old block NOT FOUND"
content = content.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print("CVD fix applied.")
