import { API_BASE_URL } from '../constants';

type ApiFetchOptions = RequestInit & {
  timeoutMs?: number;
};

const backendApiKey = () => (import.meta as any).env?.VITE_BACKEND_API_KEY || '';
const adminApiKey = () => (import.meta as any).env?.VITE_ADMIN_API_KEY || backendApiKey();

const joinUrl = (path: string) => {
  if (path.startsWith('http')) return path;
  if (!API_BASE_URL) return '';  // P13: no backend — skip silently
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
};

async function request(path: string, options: ApiFetchOptions = {}, admin = false) {
  const url = joinUrl(path);
  if (!url) return new Response(null, { status: 204 });  // P13: no backend — noop

  const { timeoutMs = 60000, headers, signal, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const mergedHeaders = new Headers(headers || {});
  const key = admin ? adminApiKey() : backendApiKey();
  if (admin) {
    if (key) mergedHeaders.set('X-Admin-Key', key);
  } else if (key) {
    mergedHeaders.set('X-API-Key', key);
  }

  try {
    const res = await fetch(url, {
      ...rest,
      headers: mergedHeaders,
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('API URL misconfigured: backend returned HTML.');
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export const apiFetch = (path: string, options?: ApiFetchOptions) => request(path, options, false);
export const adminFetch = (path: string, options?: ApiFetchOptions) => request(path, options, true);
