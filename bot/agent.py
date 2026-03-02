import os
import re
import json
import logging
import asyncio
from typing import Dict, Any, Optional
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Supported model; flash-latest is more widely available than a specific preview
GEMINI_MODEL = "gemini-2.0-flash"


class QuantAgent:
    """
    Wraps the Gemini client to generate a trading verdict from quantitative metrics.
    Falls back to WAIT gracefully if the API is unavailable.
    """

    def __init__(self, api_key: Optional[str] = None):
        key = api_key or os.environ.get("GEMINI_API_KEY", "")
        if not key:
            logger.warning(
                "[Agent] GEMINI_API_KEY not set — AI inference disabled. Bot will always output WAIT."
            )
            self.client = None
        else:
            self.client = genai.Client(api_key=key)

    # ------------------------------------------------------------------
    # Pre-classification helpers (mirror backend/main.py logic)
    # ------------------------------------------------------------------
    @staticmethod
    def _classify_rsi(rsi: float) -> str:
        if rsi < 30:
            return "Capitulation (< 30) — Prepare for High Velocity Reversal (Oversold)"
        if rsi > 70:
            return "Capitulation (> 70) — Prepare for High Velocity Reversal (Overbought)"
        if 55 <= rsi <= 70:
            return "Building (55-70) — Bullish Trend"
        if 40 <= rsi < 50:
            return "Reset (40-50) — Sideways / Distribution"
        if 30 <= rsi < 40:
            return "Oversold Recovery (30-40) — Potential Bullish Reversal"
        return "Neutral (50-55)"

    @staticmethod
    def _classify_z(z: float) -> str:
        if z >= 2.5:
            return "Sentiment Wash (> +2.5) — Mean Reversal Expected SHORT"
        if z <= -2.5:
            return "Sentiment Wash (< -2.5) — Mean Reversal Expected LONG"
        if z > 0.5:
            return "Bullish Trend (+0.5 to +2.5)"
        if z < -0.5:
            return "Bearish Trend (-0.5 to -2.5)"
        return "Neutral (-0.5 to +0.5)"

    # ------------------------------------------------------------------
    # Main inference call
    # ------------------------------------------------------------------
    async def analyze(self, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """
        Send metrics to Gemini and return a structured trading verdict.
        Returns a safe WAIT payload if the client is not available.
        """
        if self.client is None:
            return self._wait_response("No API key configured")

        rsi_state  = self._classify_rsi(metrics['rsi'])
        z_state    = self._classify_z(metrics['zScore'])
        b          = metrics['bayesianPosterior']
        bayes_state = "Confirming Upside" if b > 0.6 else "Confirming Downside" if b < 0.4 else "Neutral"
        skew       = metrics['skewness']
        skew_state = 'Downside tail risk' if skew < 0 else 'Upside tail risk' if skew > 0 else 'Neutral'

        prompt = f"""
You are an autonomous quantitative trading agent executing the Macro Statistical Filter Strategy.

=== MARKET DATA ({metrics['symbol']}) ===
Price            : {metrics['price']}
RSI (14)         : {metrics['rsi']:.1f} — {rsi_state}
Z-Score (VWAP)   : {metrics['zScore']:.3f} — {z_state}
Skewness (log-R) : {skew:.4f} — {skew_state}
Bayesian P(Bull) : {b:.3f} — {bayes_state}
OFI              : {metrics['ofi']:.2f}
CVD              : {metrics['cvd']:.0f}
Tape Speed       : {metrics['tapeSpeed']}  |  Dominant Side: {metrics['tapeDominant']}
{metrics['wallContext']}
All Walls        : {metrics['allWalls'] or 'None identified'}

=== STRATEGY RULES ===
1. Skewness: Negative = downside tail risk; Positive = upside tail risk.
2. Bayesian Posterior: >0.6 = bullish evidence; <0.4 = bearish evidence.
3. Z-Score: >+2.5 or <-2.5 triggers Mean Reversal trades. ±0.5 to ±2.5 follows trend.
4. LOB: Long entries need price above the nearest buy wall; short entries below sell wall.
5. Screaming tape near resistance = exhaustion. Near support = breakout.
6. Only trade with confidence ≥ 0.70. Otherwise use WAIT.

=== REQUIRED OUTPUT FORMAT ===
Respond with ONLY valid JSON, no markdown, no extra text:
{{
  "verdict": "BUY" | "SELL" | "WAIT" | "MEAN_REVERSAL_LONG" | "MEAN_REVERSAL_SHORT",
  "confidence": <float 0.0-1.0>,
  "stop_loss": <float, price level based on the nearest opposing LOB wall>,
  "take_profit": <float, price level based on the nearest target LOB wall>,
  "analysis": "<2-sentence rationale.>"
}}
"""

        try:
            response = await asyncio.to_thread(
                self.client.models.generate_content,
                model=GEMINI_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.2,   # Low temperature for deterministic trading decisions
                    response_mime_type="application/json",
                ),
            )
            raw_text = response.text.strip()
            # Defensive: strip any accidental markdown fences
            raw_text = re.sub(r'^```(?:json)?\s*', '', raw_text)
            raw_text = re.sub(r'\s*```$', '', raw_text)
            parsed = json.loads(raw_text)
            # Validate required keys
            for key in ("verdict", "confidence", "stop_loss", "take_profit", "analysis"):
                if key not in parsed:
                    raise ValueError(f"Response missing key: {key}")
            return parsed

        except json.JSONDecodeError as e:
            logger.error(f"[Agent] JSON parse error: {e}. Raw: {response.text[:300]}")
            return self._wait_response(f"JSON parse error: {e}")
        except Exception as e:
            logger.error(f"[Agent] GenAI error: {e}", exc_info=True)
            return self._wait_response(str(e))

    @staticmethod
    def _wait_response(reason: str) -> Dict[str, Any]:
        return {
            "verdict": "WAIT",
            "confidence": 0.0,
            "stop_loss": 0.0,
            "take_profit": 0.0,
            "analysis": f"No trade signal: {reason}"
        }
