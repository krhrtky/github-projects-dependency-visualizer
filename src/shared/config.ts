export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2026-03-10';
export const CACHE_TTL = 60_000;
export const MAX_ISSUES = 200;
export function isProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && /^\/(users|orgs)\/[^/]+\/projects\/\d+(?:\/views\/\d+)?\/?$/.test(url.pathname);
  } catch { return false; }
}
