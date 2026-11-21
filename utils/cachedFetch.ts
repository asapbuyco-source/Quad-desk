import { apiFetch } from './apiClient';

const PREFIX = 'qd.cache.v1:';

export interface CacheEntry<T> {
  t: number;
  data: T;
}

export function readCached<T>(path: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + path);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    return parsed && typeof parsed.t === 'number' ? parsed : null;
  } catch { return null; }
}

export function writeCached<T>(path: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + path, JSON.stringify({ t: Date.now(), data }));
  } catch { /* storage full or unavailable */ }
}

/**
 * Stale-while-revalidate JSON cache. Returns a fresh cached body immediately
 * when available; otherwise fetches and falls back to stale data on failure.
 * This is what keeps slow panels (RSI, whales, markets) from blocking the UI.
 */
export async function cachedJson<T>(
  path: string,
  opts: { ttlMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? 120000;
  const hit = readCached<T>(path);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  try {
    const res = await apiFetch(path, { timeoutMs: opts.timeoutMs ?? 60000 });
    const data = await res.json();
    writeCached(path, data);
    return data as T;
  } catch (e) {
    if (hit) return hit.data;
    throw e;
  }
}
