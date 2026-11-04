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
 * Safe rollout: the paywall only enforces when a checkout path exists.
 * Until then every desk stays open (no accidental lockouts while billing
 * is being set up). Set VITE_CHECKOUT_URL to enable gating.
 */
export const PAYWALL_ENABLED: boolean = !!CHECKOUT_URL;

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
]);

export const isProTab = (tab: string): boolean => PRO_TABS.has(tab);

/**
 * Resolve access. Admins see everything unless they switched on
 * "Preview as user", which applies the same gating a free account gets.
 */
export function canAccessTab(
  tab: string,
  plan: Plan,
  opts: { isAdmin?: boolean; previewAsUser?: boolean } = {},
): boolean {
  const { isAdmin = false, previewAsUser = false } = opts;
  if (!PAYWALL_ENABLED) return true;          // billing not configured yet
  if (isAdmin && !previewAsUser) return true;
  if (!isProTab(tab)) return true;
  return plan === 'pro';
}

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
  { label: 'Guide & settings', free: true, pro: true },
  { label: 'Executed-trades order flow + price impact', free: false, pro: true },
  { label: 'Depth, liquidity, bias matrix & regime desks', free: false, pro: true },
  { label: 'Sentinel edge, ULIS & AI tactical scans', free: false, pro: true },
  { label: 'Bot control & bot reasoning', free: false, pro: true },
  { label: 'Performance analytics & backtests', free: false, pro: true },
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
