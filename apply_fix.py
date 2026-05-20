import os
path = r'C:\Users\pc\Desktop\projects\Quad-desk\bot\quant_engine.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

find = '''    def _load_state(self):
        """
        Load Bayesian priors on startup.
        Tries Firestore first (survives Railway deploys), then falls back
        to the /tmp/ local file (useful for same-container warm restarts),
        then initialises a fresh Beta(5,5) prior.
        """'''

replace = '''    def _load_state(self):
        """
        Load Bayesian priors on startup.
        Tries Firestore first (survives Railway deploys), then falls back
        to the /tmp/ local file (useful for same-container warm restarts),
        then initialises a fresh Beta(5,5) prior.
        """
        import os
        if os.getenv("DEV_RESET", "True").lower() in ("true", "1", "yes"):
            import logging
            logger = logging.getLogger(__name__)
            logger.info("[QuantEngine] DEV_RESET=True - skipping Firestore/local cache. Starting with fresh Beta(5,5) prior.")
            return'''

if find in content:
    content = content.replace(find, replace)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Success")
else:
    print("Not found")
