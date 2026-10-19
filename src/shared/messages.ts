import { isIssue, type IssueIdentity } from '../domain/issue';
import type { Dependency } from '../domain/graph';
import type { PublicError } from './errors';
import { MAX_ISSUES, isProjectUrl } from './config';
export interface Settings { enabled: boolean; authenticated: boolean }
export type Request = { type: 'GET_STATE' | 'LOGOUT' | 'REFRESH' } | { type: 'SET_TOKEN'; token: string } | { type: 'SET_ENABLED'; enabled: boolean } | { type: 'DEPENDENCIES'; issues: IssueIdentity[] };
export type IssueResult = { issue: IssueIdentity; ok: true; dependencies: Dependency[] } | { issue: IssueIdentity; ok: false; error: PublicError };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: PublicError };
export interface PageStatus {
  state: 'off' | 'no-board' | 'no-cards' | 'loading' | 'ready' | 'partial' | 'error';
  cards: number; edges: number; failed: number; errors: PublicError[]; truncated: boolean;
  analysis?: { maxDepth: number | null; branches: number; merges: number; cycleNodes: number };
}
function exactKeys(o: Record<string, unknown>, keys: string[]): boolean { return Object.keys(o).sort().join(',') === keys.sort().join(','); }
export function parseRequest(value: unknown): Request | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (['GET_STATE', 'LOGOUT', 'REFRESH'].includes(String(m.type)) && exactKeys(m, ['type'])) return m as Request;
  if (m.type === 'SET_ENABLED' && typeof m.enabled === 'boolean' && exactKeys(m, ['type', 'enabled'])) return m as Request;
  if (m.type === 'SET_TOKEN' && typeof m.token === 'string' && /^github_pat_[A-Za-z0-9_]{20,250}$/.test(m.token) && exactKeys(m, ['type', 'token'])) return m as Request;
  if (m.type === 'DEPENDENCIES' && Array.isArray(m.issues) && m.issues.length <= MAX_ISSUES && m.issues.every(isIssue) && exactKeys(m, ['type', 'issues'])) return m as Request;
  return null;
}
export function authorized(request: Request, sender: chrome.runtime.MessageSender, extensionId: string, popupUrl: string): boolean {
  if (sender.id !== extensionId) return false;
  if (sender.url === popupUrl) return true;
  return !!sender.tab && sender.frameId === 0 && !!sender.url && isProjectUrl(sender.url)
    && (request.type === 'GET_STATE' || request.type === 'DEPENDENCIES');
}
export async function send<T>(request: Request): Promise<Reply<T>> {
  try { return await chrome.runtime.sendMessage(request) as Reply<T>; }
  catch { return { ok: false, error: { code: 'MESSAGE' } }; }
}
