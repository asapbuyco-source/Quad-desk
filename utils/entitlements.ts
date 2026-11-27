/**
 * Entitlements — one place that decides what a plan can open.
 *
 * Free gives the core market view (live prices, chart, funding/OI, macro, news).
 * Pro unlocks the advanced execution/analytics desks.
 *
 * Checkout and billing-portal URLs come from env so no code change is needed
 * when the payment links change. Both are optional: without them the UI shows
 * a "contact billing" state instead of a broken button.
 */

export type Plan = 'free' | 'pro';
export type SubStatus = 'active' | 'inactive' | 'trialing' | 'past_due';

export const ADMIN_EMAILS = ((import.meta as any).env?.VITE_ADMIN_EMAILS || '')
  .toLowerCase()
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

export const isAdminEmail = (email?: string | null): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase());

export const CHECKOUT_URL: string = (import.meta as any).env?.VITE_CHECKOUT_URL || '';
export const SALES_EMAIL: string = (import.meta as any).env?.VITE_SALES_EMAIL || '';

const LS_PORTAL = 'https://app.lemonsqueezy.com/my-orders';
export const PORTAL_URL: string =
  (import.meta as any).env?.VITE_BILLING_PORTAL_URL ||
  (CHECKOUT_URL.includes('lemonsqueezy') ? LS_PORTAL : '');

const LS_LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses';

/**
 * Safe rollout: the paywall only enforces when a checkout path exists, unless
 * it is explicitly forced on for previewing the locked experience.
 * Set VITE_CHECKOUT_URL for real billing, or VITE_PAYWALL_FORCE=1 to preview.
 */
const truthy = (v?: string) => ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
export const PAYWALL_ENABLED: boolean =
  !!CHECKOUT_URL || truthy((import.meta as any).env?.VITE_PAYWALL_FORCE);

/** Tabs available on the free tier. */
export const FREE_TABS = new Set([
  'dashboard',
  'charting',
  'funding',
  'macro',
  'intel',
  'guide',
  'pricing',
  'settings',
  // Derivatives core — free so users build a daily habit.
  'positioning',
  'liquidations',
  'screener',
  'watchlist',
  'markets',
  'coins',
]);

/** Tabs that are hidden from normal users entirely — admin-only tooling. */
export const ADMIN_ONLY_TABS = new Set([
  'bot-control',
  'bot-mind',
  'admin-users',
]);

/** Tabs that require Pro. */
export const PRO_TABS = new Set([
  'depth',
  'liquidity',
  'bias',
  'regime',
  'order-flow',
  'bot-control',
  'ai-tactical',
  'bot-mind',
  'sentinel',
  'ulis',
  'macro-strategy',
  'analytics',
  'whales',
]);

export const isProTab = (tab: string): boolean => PRO_TABS.has(tab);
export const isAdminOnlyTab = (tab: string): boolean => ADMIN_ONLY_TABS.has(tab);

/**
 * Resolve access. Admins see everything unless they switched on
 * "Preview as user", which applies the same gating a free account gets.
 */
export function canAccessTab(
  tab: string,
  plan: Plan,
  opts: { isAdmin?: boolean; previewAsUser?: boolean; trialActive?: boolean } = {},
): boolean {
  const { isAdmin = false, previewAsUser = false, trialActive = false } = opts;
  const admin = isAdmin && !previewAsUser;

  // Admin tooling is never part of a paid plan.
  if (isAdminOnlyTab(tab)) return admin;

  if (!PAYWALL_ENABLED) return true;          // billing not configured yet
  if (admin) return true;
  if (!isProTab(tab)) return true;
  return plan === 'pro' || trialActive;
}

/** Copy used by the locked-desk upsell screen. */
export const PRO_TAB_INFO: Record<string, { label: string; blurb: string; bullets: string[] }> = {
  whales: {
    label: 'Whale Positions',
    blurb: 'Track the largest Hyperliquid accounts and what they are actually holding.',
    bullets: ['Top accounts by account value', 'Open perp positions with leverage', 'Long/short exposure and unrealised PnL'],
  },
  'order-flow': {
    label: 'Order Flow',
    blurb: 'See who crossed the spread and whether the book is absorbing it.',
    bullets: ['Executed prints with taker side', 'Rolling CVD and delta', 'Price-impact and absorption diagnostics'],
  },
  analytics: {
    label: 'Analytics',
    blurb: 'Session-level order-flow analytics with heat and composite profiles.',
    bullets: ['Delta flow & CVD chart', 'Session delta heat strip', 'Composite volume profile'],
  },
  'ai-tactical': {
    label: 'Tactical Scan',
    blurb: 'AI-assisted tactical read built from live order flow and positioning.',
    bullets: ['Structured trade scenarios', 'Confidence scoring', 'Invalidation levels'],
  },
  depth: {
    label: 'Depth',
    blurb: 'Full order-book depth with imbalance and wall detection.',
    bullets: ['Live depth ladder', 'Bid/ask imbalance', 'Large resting liquidity'],
  },
  liquidity: {
    label: 'Liquidity Map',
    blurb: 'Map where liquidity sits and how it changes as price moves.',
    bullets: ['Liquidity distribution', 'Sweep and replenish events', 'Support/resistance zones'],
  },
  bias: {
    label: 'Bias Matrix',
    blurb: 'Multi-factor bias across venues and timeframes.',
    bullets: ['Cross-venue bias', 'Timeframe alignment', 'Conflict detection'],
  },
  regime: {
    label: 'Regime',
    blurb: 'Statistical regime state to match strategy to market conditions.',
    bullets: ['HMM regime state', 'Transition probabilities', 'Volatility context'],
  },
  sentinel: {
    label: 'Sentinel Edge',
    blurb: 'Edge confirmation before you commit risk.',
    bullets: ['Signal confirmation', 'Risk checks', 'Context-aware gating'],
  },
  ulis: {
    label: 'ULIS',
    blurb: 'Institutional liquidity and flow intelligence.',
    bullets: ['Latent liquidity map', 'Gravity walls', 'Reflexivity and fragility scores'],
  },
};

export const GENERIC_PRO_INFO = {
  label: 'Pro desk',
  blurb: 'This workspace is part of Pro — advanced execution and analytics.',
  bullets: ['Full order flow and analytics', 'Positioning and whale data', 'Priority data access'],
};

export interface PlanFeature {
  label: string;
  free: boolean;
  pro: boolean;
}

export const PLAN_FEATURES: PlanFeature[] = [
  { label: 'Live prices, chart & order book', free: true, pro: true },
  { label: 'Funding & open interest (cross-venue)', free: true, pro: true },
  { label: 'Macro & FX data (FRED / ECB)', free: true, pro: true },
  { label: 'Market news & sentiment', free: true, pro: true },
  { label: 'Watchlist & 3 price alerts', free: true, pro: true },
  { label: 'Guide & settings', free: true, pro: true },
  { label: 'Executed-trades order flow + price impact', free: false, pro: true },
  { label: 'Positioning: retail vs top traders', free: true, pro: true },
  { label: 'RSI screener & liquidation clusters', free: true, pro: true },
  { label: 'Whale positions (Hyperliquid)', free: false, pro: true },
  { label: 'Sentinel edge, ULIS & AI tactical scans', free: false, pro: true },
  { label: 'Analytics & advanced charting', free: false, pro: true },
];

/**
 * Build the hosted checkout URL, prefilling the buyer's email and attaching the
 * Firebase uid as custom data (Lemon Squeezy passes it through the webhook).
 */
export function buildCheckoutUrl(opts: { email?: string | null; userId?: string | null } = {}): string {
  if (!CHECKOUT_URL) return '';
  try {
    const url = new URL(CHECKOUT_URL);
    if (opts.email) url.searchParams.set('checkout[email]', opts.email);
    if (opts.userId) url.searchParams.set('checkout[custom][user_id]', opts.userId);
    return url.toString();
  } catch {
    return CHECKOUT_URL;
  }
}

/** Where the Upgrade button should go: checkout, else manual sales email. */
export function upgradeHref(opts: { email?: string | null; userId?: string | null } = {}): string {
  const checkout = buildCheckoutUrl(opts);
  if (checkout) return checkout;
  if (SALES_EMAIL) return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Quant Desk Pro access')}`;
  return '';
}

export interface LicenseResult {
  valid: boolean;
  status?: string;
  expiresAt?: string | null;
  error?: string;
}

/**
 * Validate a Lemon Squeezy license key from the browser (their API sends
 * `Access-Control-Allow-Origin: *`). This is what unlocks Pro without a
 * backend: a key that validates is proof of purchase.
 */
export async function validateLicense(licenseKey: string): Promise<LicenseResult> {
  const key = (licenseKey || '').trim();
  if (!key) return { valid: false, error: 'Enter your license key.' };
  try {
    const res = await fetch(`${LS_LICENSE_API}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ license_key: key }).toString(),
    });
    const data: any = await res.json();
    if (!data?.valid) return { valid: false, error: data?.error || 'Invalid or expired license.' };
    const lk = data.license_key || {};
    return { valid: true, status: lk.status, expiresAt: lk.expires_at || null };
  } catch (e: any) {
    return { valid: false, error: e?.message || 'Could not reach the license server.' };
  }
}

export const PRICING = {
  free: { name: 'Free', price: 0, period: 'forever', blurb: 'Core market view — no card.' },
  pro: { name: 'Pro', price: 39, period: 'per month', annual: 390, blurb: 'Full desk: order flow, analytics, bot tooling.' },
} as const;
