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

export type Plan = 'free' | 'starter' | 'pro' | 'team';
export type SubStatus = 'active' | 'inactive' | 'trialing' | 'past_due';

export const PLAN_RANK: Record<Plan, number> = { free: 0, starter: 1, pro: 2, team: 3 };
export const isPaidPlan = (plan: Plan): boolean => plan !== 'free';
export const normalizePlan = (value?: string | null): Plan =>
  value === 'starter' || value === 'pro' || value === 'team' ? value : 'free';

export const PLAN_LABEL: Record<Plan, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  team: 'Institutional',
};

/** AI requests per day by tier. Admin is unlimited. */
export const AI_DAILY_LIMIT: Record<Plan, number> = {
  free: 5,
  starter: 50,
  pro: 100,
  team: 200,
};

export const ADMIN_EMAILS = ((import.meta as any).env?.VITE_ADMIN_EMAILS || '')
  .toLowerCase()
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

export const isAdminEmail = (email?: string | null): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase());

export const CHECKOUT_URL: string = (import.meta as any).env?.VITE_CHECKOUT_URL || '';
export const SALES_EMAIL: string = (import.meta as any).env?.VITE_SALES_EMAIL || '';

const envUrl = (key: string): string => (import.meta as any).env?.[key] || '';

/** Monthly / annual checkout links per tier. Pro falls back to the legacy vars. */
export const CHECKOUT_URLS: Record<Exclude<Plan, 'free'>, { month: string; year: string }> = {
  starter: {
    month: envUrl('VITE_CHECKOUT_STARTER') || '',
    year: envUrl('VITE_CHECKOUT_STARTER_ANNUAL') || '',
  },
  pro: {
    month: envUrl('VITE_CHECKOUT_PRO') || CHECKOUT_URL,
    year: envUrl('VITE_CHECKOUT_PRO_ANNUAL') || envUrl('VITE_CHECKOUT_URL_ANNUAL') || '',
  },
  team: {
    month: envUrl('VITE_CHECKOUT_TEAM') || '',
    year: envUrl('VITE_CHECKOUT_TEAM_ANNUAL') || '',
  },
};

const LS_PORTAL = 'https://app.lemonsqueezy.com/my-orders';
export const PORTAL_URL: string =
  (import.meta as any).env?.VITE_BILLING_PORTAL_URL ||
  (Object.values(CHECKOUT_URLS).some(v => v.month.includes('lemonsqueezy')) ? LS_PORTAL : '');

const LS_LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses';

/**
 * Safe rollout: the paywall only enforces when a checkout path exists, unless
 * it is explicitly forced on for previewing the locked experience.
 * Set VITE_CHECKOUT_URL for real billing, or VITE_PAYWALL_FORCE=1 to preview.
 */
const truthy = (v?: string) => ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
export const PAYWALL_ENABLED: boolean =
  !!CHECKOUT_URL || Object.values(CHECKOUT_URLS).some(v => !!v.month) || truthy((import.meta as any).env?.VITE_PAYWALL_FORCE);

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
  'ai',
]);

/** Tabs that are hidden from normal users entirely — admin-only tooling. */
export const ADMIN_ONLY_TABS = new Set([
  'bot-control',
  'bot-mind',
  'admin-users',
]);

/** Tabs that require Starter or above. */
export const STARTER_TABS = new Set([
  'order-flow',
  'whales',
  'depth',
]);

/** Tabs that require Pro or above. */
export const PRO_TABS = new Set([
  'liquidity',
  'bias',
  'regime',
  'ai-tactical',
  'sentinel',
  'ulis',
  'macro-strategy',
  'analytics',
]);

export const isStarterTab = (tab: string): boolean => STARTER_TABS.has(tab);
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
  if (isProTab(tab)) return trialActive || plan === 'pro' || plan === 'team';
  if (isStarterTab(tab)) return trialActive || plan !== 'free';
  return true;
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
  starter: boolean;
  pro: boolean;
  team: boolean;
}

export const PLAN_FEATURES: PlanFeature[] = [
  { label: 'Live prices, chart & order book', free: true, starter: true, pro: true, team: true },
  { label: 'Funding & open interest (cross-venue)', free: true, starter: true, pro: true, team: true },
  { label: 'Positioning: retail vs top traders', free: true, starter: true, pro: true, team: true },
  { label: 'RSI screener & liquidation clusters', free: true, starter: true, pro: true, team: true },
  { label: 'Macro, FX & market news', free: true, starter: true, pro: true, team: true },
  { label: 'Watchlist + 3 price alerts', free: true, starter: true, pro: true, team: true },
  { label: 'AI assistant · 5 requests/day', free: true, starter: false, pro: false, team: false },
  { label: 'Executed-trades order flow + CVD', free: false, starter: true, pro: true, team: true },
  { label: 'Hyperliquid whale positions', free: false, starter: true, pro: true, team: true },
  { label: 'Depth ladder & imbalance', free: false, starter: true, pro: true, team: true },
  { label: 'Unlimited price alerts', free: false, starter: true, pro: true, team: true },
  { label: 'AI assistant · 50 requests/day', free: false, starter: true, pro: false, team: false },
  { label: 'Liquidity map & bias desks', free: false, starter: false, pro: true, team: true },
  { label: 'Regime & macro strategy desks', free: false, starter: false, pro: true, team: true },
  { label: 'Sentinel edge, ULIS & tactical scans', free: false, starter: false, pro: true, team: true },
  { label: 'Analytics & advanced charting', free: false, starter: false, pro: true, team: true },
  { label: 'AI assistant · 100 requests/day', free: false, starter: false, pro: true, team: false },
  { label: 'API access (beta)', free: false, starter: false, pro: false, team: true },
  { label: 'Team seats & priority support', free: false, starter: false, pro: false, team: true },
  { label: 'AI assistant · 200 requests/day', free: false, starter: false, pro: false, team: true },
];

/**
 * Build the hosted checkout URL, prefilling the buyer's email and attaching the
 * Firebase uid as custom data (Lemon Squeezy passes it through the webhook).
 */
export function buildCheckoutUrl(
  opts: { email?: string | null; userId?: string | null } = {},
  tier: Exclude<Plan, 'free'> = 'pro',
  annual = false,
): string {
  const links = CHECKOUT_URLS[tier];
  const base = (annual ? links.year : links.month) || links.month;
  if (!base) return '';
  try {
    const url = new URL(base);
    if (opts.email) url.searchParams.set('checkout[email]', opts.email);
    if (opts.userId) url.searchParams.set('checkout[custom][user_id]', opts.userId);
    return url.toString();
  } catch {
    return base;
  }
}

/** Where the Upgrade button should go: checkout, else manual sales email. */
export function upgradeHref(
  opts: { email?: string | null; userId?: string | null } = {},
  tier: Exclude<Plan, 'free'> = 'pro',
  annual = false,
): string {
  const checkout = buildCheckoutUrl(opts, tier, annual);
  if (checkout) return checkout;
  if (SALES_EMAIL) {
    return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Quant Desk ${PLAN_LABEL[tier]} access`)}`;
  }
  return '';
}

export interface LicenseResult {
  valid: boolean;
  status?: string;
  expiresAt?: string | null;
  variantId?: string | number | null;
  productId?: string | number | null;
  productName?: string | null;
  error?: string;
}

const envIds = (key: string): string[] =>
  String((import.meta as any).env?.[key] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/** Map a Lemon Squeezy licence to a tier using the product/variant ids. */
export function tierFromLicense(res: LicenseResult): Exclude<Plan, 'free'> {
  const variant = String(res.variantId ?? '');
  const product = String(res.productId ?? '');
  const match = (key: string) => {
    const ids = envIds(key);
    return ids.includes(variant) || ids.includes(product);
  };
  if (match('VITE_LS_STARTER_VARIANTS')) return 'starter';
  if (match('VITE_LS_TEAM_VARIANTS')) return 'team';
  if (match('VITE_LS_PRO_VARIANTS')) return 'pro';
  return 'pro';
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
    const meta = data.meta || {};
    return {
      valid: true,
      status: lk.status,
      expiresAt: lk.expires_at || null,
      variantId: meta.variant_id ?? null,
      productId: meta.product_id ?? null,
      productName: meta.product_name ?? null,
    };
  } catch (e: any) {
    return { valid: false, error: e?.message || 'Could not reach the license server.' };
  }
}

export const PRICING = {
  free: { name: 'Free', price: 0, annual: 0, period: 'forever', blurb: 'Core market view — no card.' },
  starter: { name: 'Starter', price: 9, annual: 86, period: 'per month', blurb: 'Order flow, whales and depth for active traders.' },
  pro: { name: 'Pro', price: 24, annual: 228, period: 'per month', blurb: 'Every desk: liquidity, regime, analytics and AI scans.' },
  team: { name: 'Institutional', price: 79, annual: 758, period: 'per month', blurb: 'Pro plus API access, seats and priority support.' },
} as const;
