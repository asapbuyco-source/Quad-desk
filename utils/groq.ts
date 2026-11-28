const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-120b';
const DEFAULT_API_KEY = 'GROQ_API_KEY_PLACEHOLDER';

export function getGroqApiKey(): string {
    return (import.meta as any).env?.VITE_GROQ_API_KEY
        || localStorage.getItem('groq_api_key')
        || DEFAULT_API_KEY;
}

export function setGroqApiKey(key: string) {
    localStorage.setItem('groq_api_key', key);
}

export interface GroqAnalysisResult {
    verdict: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    entry_price: number | null;
    stop_loss: number | null;
    take_profit: number | null;
    analysis: string;
    risk_reward_ratio: number | null;
    support: number | null;
    resistance: number | null;
}

export async function runGroqAnalysis(
    promptData: {
        symbol: string;
        price: number;
        change24h: number;
        regime: string;
        zScore: number;
        bayesian: number;
        rsi: number;
        oiRegime: string;
        oiDelta: number;
        oiRisk: string;
        signal: string;
        pnl: number;
        atr: number;
    }
): Promise<GroqAnalysisResult> {
    const apiKey = getGroqApiKey();
    if (!apiKey) {
        throw new Error('GROQ_API_KEY not set. Add VITE_GROQ_API_KEY to .env or set it in Settings.');
    }

    const prompt = `You are a crypto trading analyst. Analyze this market data and provide a trading decision.

MARKET DATA:
Symbol: ${promptData.symbol}
Price: $${promptData.price.toFixed(2)}
24h Change: ${promptData.change24h.toFixed(2)}%
Regime: ${promptData.regime}
Z-Score: ${promptData.zScore.toFixed(2)}
Bayesian Confidence: ${(promptData.bayesian * 100).toFixed(0)}%
RSI: ${promptData.rsi.toFixed(0)}
OI Regime: ${promptData.oiRegime}
OI Delta 5m: ${promptData.oiDelta.toFixed(2)}%
OI Risk: ${promptData.oiRisk}
Current Signal: ${promptData.signal}
Session PnL: $${promptData.pnl.toFixed(2)}
ATR: ${(promptData.atr * 100).toFixed(2)}%

Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
{
  "verdict": "BUY" | "SELL" | "WAIT",
  "confidence": 0.0-1.0,
  "entry_price": number or null,
  "stop_loss": number or null,
  "take_profit": number or null,
  "risk_reward_ratio": number or null,
  "support": number or null,
  "resistance": number or null,
  "analysis": "Concise reasoning (max 250 chars) explaining the decision based on the data provided."
}`;

    const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 700,
            reasoning_effort: 'low',
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let parsed: any;
    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
        throw new Error('Failed to parse Groq response: ' + content.substring(0, 200));
    }

    return {
        verdict: (['BUY', 'SELL', 'WAIT'].includes(parsed.verdict) ? parsed.verdict : 'WAIT') as GroqAnalysisResult['verdict'],
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
        entry_price: parsed.entry_price != null ? Number(parsed.entry_price) : null,
        stop_loss: parsed.stop_loss != null ? Number(parsed.stop_loss) : null,
        take_profit: parsed.take_profit != null ? Number(parsed.take_profit) : null,
        risk_reward_ratio: parsed.risk_reward_ratio != null ? Number(parsed.risk_reward_ratio) : null,
        support: parsed.support != null ? Number(parsed.support) : null,
        resistance: parsed.resistance != null ? Number(parsed.resistance) : null,
        analysis: String(parsed.analysis || '').substring(0, 350),
    };
}


export interface AssistantMessage { role: 'user' | 'assistant'; content: string }

export async function runAssistant(messages: AssistantMessage[], context: string): Promise<string> {
    const apiKey = getGroqApiKey();
    if (!apiKey || apiKey === DEFAULT_API_KEY) {
        throw new Error('AI is not configured. Add VITE_GROQ_API_KEY.');
    }
    const system = `You are the Quant Desk assistant inside a crypto derivatives terminal.

Rules:
- Answer questions about the app, its boards, market data and trading concepts.
- Use the DATA block for every number. Never invent prices, funding, OI or liquidations.
- If data is missing or stale, say so plainly.
- No financial advice, no price predictions, no guaranteed outcomes. Explain what the data shows.
- Be concise: under 180 words, bullets when useful, no markdown tables.
- Never use markdown formatting: no asterisks, bold, headings, backticks or code fences. Plain text only; use "- " for bullets.
- When asked about a page, explain what it shows and read the current DATA value for it.

DATA:
${context}`;
    const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'system', content: system }, ...messages.slice(-8)],
            temperature: 0.3,
            max_tokens: 900,
            reasoning_effort: 'low',
        }),
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`AI request failed (${res.status}): ${t.slice(0, 160)}`);
    }
    const data = await res.json();
    return String(data.choices?.[0]?.message?.content || 'No answer returned.');
}
