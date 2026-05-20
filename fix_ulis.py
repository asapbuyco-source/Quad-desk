path = r'C:\Users\pc\Desktop\projects\Quad-desk\bot\main.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# The broken block to replace (indented BAYES + duplicate stale block)
old = '''    ulis_bullish = verdict_str in (\"STRONG_LONG\", \"LONG\")
    ulis_bearish = verdict_str in (\"STRONG_SHORT\", \"SHORT\")

        BAYES_OVERRIDE_THRESHOLD = 0.78
    if is_long and ulis_bearish:
        if confidence >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(f\"[ULIS] Bayesian override ({confidence:.2%} >= {BAYES_OVERRIDE_THRESHOLD:.0%}) - proceeding despite ULIS={verdict_str}\")
            confidence *= 0.92
        else:
            logger.warning(f\"[ULIS] Direction conflict - bot=LONG, ULIS={verdict_str}. Skipping.\")
            return False, 0.0, verdict_str

    if not is_long and ulis_bullish:
        if confidence >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(f\"[ULIS] Bayesian override ({confidence:.2%} >= {BAYES_OVERRIDE_THRESHOLD:.0%}) - proceeding despite ULIS={verdict_str}\")
            confidence *= 0.92
        else:
            logger.warning(f\"[ULIS] Direction conflict - bot=SHORT, ULIS={verdict_str}. Skipping.\")
            return False, 0.0, verdict_str

    if not is_long and ulis_bullish:
        logger.warning(f\"[ULIS] Direction conflict \u00bf\" bot=SHORT, ULIS={verdict_str}. Skipping.\")
        return False, 0.0, verdict_str'''

# The correct clean block
new = '''    ulis_bullish = verdict_str in (\"STRONG_LONG\", \"LONG\")
    ulis_bearish = verdict_str in (\"STRONG_SHORT\", \"SHORT\")

    BAYES_OVERRIDE_THRESHOLD = 0.78
    if is_long and ulis_bearish:
        if confidence >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(f\"[ULIS] Bayesian override ({confidence:.2%} >= {BAYES_OVERRIDE_THRESHOLD:.0%}) - proceeding despite ULIS={verdict_str}\")
            confidence *= 0.92
        else:
            logger.warning(f\"[ULIS] Direction conflict - bot=LONG, ULIS={verdict_str}. Skipping.\")
            return False, 0.0, verdict_str

    if not is_long and ulis_bullish:
        if confidence >= BAYES_OVERRIDE_THRESHOLD:
            logger.info(f\"[ULIS] Bayesian override ({confidence:.2%} >= {BAYES_OVERRIDE_THRESHOLD:.0%}) - proceeding despite ULIS={verdict_str}\")
            confidence *= 0.92
        else:
            logger.warning(f\"[ULIS] Direction conflict - bot=SHORT, ULIS={verdict_str}. Skipping.\")
            return False, 0.0, verdict_str'''

if old in content:
    content = content.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS: Fixed indentation and removed stale duplicate block.')
else:
    # Try alternate encoding of the mojibake character
    print('ERROR: Could not find the target block. Trying alternate approach...')
    # Print chars around the area for debugging
    idx = content.find('BAYES_OVERRIDE_THRESHOLD = 0.78')
    if idx >= 0:
        print(f'Found BAYES at index {idx}')
        print(repr(content[idx-200:idx+50]))
    else:
        print('BAYES_OVERRIDE_THRESHOLD not found at all!')
