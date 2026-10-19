import { isIssue, type IssueIdentity } from '../domain/issue';
import type { Dependency } from '../domain/graph';
import type { PublicError } from './errors';
import { MAX_ISSUES, isProjectUrl } from './config';
import { isProject, parseProjectUrl, projectKey } from '../domain/project';
import type { ProjectIdentity, ProjectSyncReport } from '../domain/project';
import { issueKey } from '../domain/issue';
import type { ChangeRelationship } from '../domain/relationships';
export interface Settings { enabled: boolean; authenticated: boolean; relationshipsVisible: boolean }
export interface RelationshipChangeReport { changed: true; sync?: ProjectSyncReport | null; syncError?: PublicError }
export type Request = { type: 'GET_STATE' | 'LOGOUT' | 'REFRESH' } | { type: 'SET_TOKEN'; token: string } | { type: 'SET_ENABLED'; enabled: boolean } | { type: 'DEPENDENCIES'; issues: IssueIdentity[] }
  | { type: 'SET_RELATIONSHIPS_VISIBLE'; visible: boolean }
  | { type: 'RELATIONSHIPS'; issue: IssueIdentity }
  | { type: 'CHANGE_RELATIONSHIP'; change: ChangeRelationship; project?: ProjectIdentity }
  | { type: 'PROJECT_PREVIEW' | 'PROJECT_SYNC'; project: ProjectIdentity };
export type IssueResult = { issue: IssueIdentity; ok: true; dependencies: Dependency[] } | { issue: IssueIdentity; ok: false; error: PublicError };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: PublicError };
export interface PageStatus {
  state: 'off' | 'no-view' | 'no-cards' | 'loading' | 'ready' | 'partial' | 'error';
  cards: number; edges: number; failed: number; errors: PublicError[]; truncated: boolean;
  view?: 'board' | 'table' | 'roadmap';
  analysis?: { maxDepth: number | null; branches: number; merges: number; cycleNodes: number };
}
function exactKeys(o: Record<string, unknown>, keys: string[]): boolean { return Object.keys(o).sort().join(',') === keys.sort().join(','); }
function exactProject(value: unknown): value is ProjectIdentity {
  return isProject(value) && exactKeys(value as unknown as Record<string, unknown>, ['kind', 'owner', 'number', ...('view' in value ? ['view'] : [])]);
}
export function isPersonalAccessToken(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^(?:github_pat_[A-Za-z0-9_]{20,250}|ghp_[A-Za-z0-9]{36})$/.test(value);
}
export function parseRequest(value: unknown): Request | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (['GET_STATE', 'LOGOUT', 'REFRESH'].includes(String(m.type)) && exactKeys(m, ['type'])) return m as Request;
  if (m.type === 'SET_ENABLED' && typeof m.enabled === 'boolean' && exactKeys(m, ['type', 'enabled'])) return m as Request;
  if (m.type === 'SET_RELATIONSHIPS_VISIBLE' && typeof m.visible === 'boolean' && exactKeys(m, ['type', 'visible'])) return m as Request;
  if (m.type === 'SET_TOKEN' && isPersonalAccessToken(m.token) && exactKeys(m, ['type', 'token'])) return m as Request;
  if (m.type === 'DEPENDENCIES' && Array.isArray(m.issues) && m.issues.length <= MAX_ISSUES && m.issues.every(isIssue) && exactKeys(m, ['type', 'issues'])) return m as Request;
  if (m.type === 'RELATIONSHIPS' && isIssue(m.issue) && exactKeys(m, ['type', 'issue'])) return m as Request;
  if ((m.type === 'PROJECT_PREVIEW' || m.type === 'PROJECT_SYNC') && exactProject(m.project) && exactKeys(m, ['type', 'project'])) return m as Request;
  if (m.type === 'CHANGE_RELATIONSHIP' && m.change && typeof m.change === 'object' && exactKeys(m, ['type', 'change', ...('project' in m ? ['project'] : [])]) && (!('project' in m) || exactProject(m.project))) {
    const change = m.change as Record<string, unknown>;
    if (exactKeys(change, ['issue', 'related', 'kind', 'action']) && isIssue(change.issue) && isIssue(change.related)
      && issueKey(change.issue) !== issueKey(change.related)
      && ['blockedBy', 'blocking', 'parent', 'child'].includes(String(change.kind)) && ['add', 'remove'].includes(String(change.action))) return m as Request;
  }
  return null;
}
export function authorized(request: Request, sender: chrome.runtime.MessageSender, extensionId: string, popupUrl: string): boolean {
  if (sender.id !== extensionId) return false;
  if (sender.url === popupUrl) return true;
  if (!sender.tab || sender.frameId !== 0 || !sender.url || !isProjectUrl(sender.url)) return false;
  if (request.type === 'PROJECT_PREVIEW' || request.type === 'PROJECT_SYNC' || (request.type === 'CHANGE_RELATIONSHIP' && request.project)) {
    const project = parseProjectUrl(sender.url);
    return !!project && !!request.project && projectKey(project) === projectKey(request.project) && project.view === request.project.view;
  }
  return ['GET_STATE', 'DEPENDENCIES', 'RELATIONSHIPS', 'CHANGE_RELATIONSHIP'].includes(request.type);
}
export async function send<T>(request: Request): Promise<Reply<T>> {
  try { return await chrome.runtime.sendMessage(request) as Reply<T>; }
  catch { return { ok: false, error: { code: 'MESSAGE' } }; }
}
