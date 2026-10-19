import { type IssueIdentity, isIssue, issueKey, parseIssueUrl } from '../domain/issue';
import { type Dependency, normalize } from '../domain/graph';
import type { ChangeRelationship, IssueRelationships } from '../domain/relationships';
import { API_ORIGIN, API_VERSION } from '../shared/config';
import { AppError } from '../shared/errors';
import type { AuthProvider } from './auth';
export interface CooldownStore { read(): Promise<number>; write(until: number): Promise<void> }
interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  allowNotFound?: boolean;
  noResponse?: boolean;
  write?: boolean;
}
interface ApiResponse { data: unknown; status: number; headers: Headers }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('SCHEMA');
  return value as Record<string, unknown>;
}
function identity(value: unknown): IssueIdentity {
  const row = record(value);
  const parsed = typeof row.html_url === 'string' ? parseIssueUrl(row.html_url) : null;
  if (!parsed || row.number !== parsed.number || row.pull_request) throw new AppError('SCHEMA');
  return parsed;
}
function issuePath(issue: IssueIdentity): string {
  return `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}`;
}
export class GitHubApi {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private cooldown = 0;
  private invalidAuth = false;
  private readonly abort = new AbortController();
  constructor(private readonly auth: AuthProvider, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly timeoutMs = 15_000, private readonly cooldownStore?: CooldownStore) {}
  dispose(): void { this.abort.abort(); }
  private async slot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try { return await operation(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
  private async limit(headers: Headers): Promise<never> {
    const retry = headers.get('retry-after');
    const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const retryDate = retry === null ? NaN : Date.parse(retry);
    const resetHeader = headers.get('x-ratelimit-reset');
    const reset = resetHeader && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 : 0;
    this.cooldown = Math.max(this.now() + 60_000, Number.isFinite(seconds) ? this.now() + seconds * 1000 : 0, Number.isFinite(retryDate) ? retryDate : 0, reset);
    await this.cooldownStore?.write(this.cooldown);
    throw new AppError('RATE_LIMIT', this.cooldown);
  }
  private async request(path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    return this.slot(async () => {
      if (this.abort.signal.aborted) throw new AppError('STALE');
      if (this.invalidAuth) throw new AppError('AUTH_INVALID');
      this.cooldown = Math.max(this.cooldown, await this.cooldownStore?.read() ?? 0);
      if (this.now() < this.cooldown) throw new AppError('RATE_LIMIT', this.cooldown);
      const token = await this.auth.getToken();
      if (this.abort.signal.aborted) throw new AppError('STALE');
      if (this.invalidAuth) throw new AppError('AUTH_INVALID');
      if (this.now() < this.cooldown) throw new AppError('RATE_LIMIT', this.cooldown);
      const url = new URL(path, API_ORIGIN);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const request = this.fetcher;
        const response = await request(url.href, { method: options.method ?? 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
        if (response.status === 401) { this.invalidAuth = true; throw new AppError('AUTH_INVALID'); }
        if (response.status === 403 || response.status === 429) {
          const retry = response.headers.get('retry-after');
          const limited = response.status === 429 || retry !== null || response.headers.get('x-ratelimit-remaining') === '0';
          // GitHub may signal secondary limits with only a 403 response body.
          const body = limited ? '' : (await response.text()).slice(0, 8192).toLowerCase();
          if (limited || body.includes('rate limit') || body.includes('abuse')) return await this.limit(response.headers);
          if (response.status === 403 && /^\s*required\s*(?:;|$)/i.test(response.headers.get('x-github-sso') ?? '')) throw new AppError('SSO_REQUIRED');
          throw new AppError(options.write ? 'WRITE_FORBIDDEN' : 'FORBIDDEN');
        }
        if (response.status === 404 && !options.allowNotFound) throw new AppError('NOT_FOUND');
        if (response.status === 404 && options.allowNotFound) return { data: null, status: response.status, headers: response.headers };
        if (response.status === 409) throw new AppError('CONFLICT');
        if (response.status === 400 || response.status === 422) throw new AppError('VALIDATION');
        if (!response.ok) throw new AppError('API');
        if (options.noResponse || response.status === 204) return { data: null, status: response.status, headers: response.headers };
        let json: unknown;
        try { json = await response.json(); } catch { throw new AppError('SCHEMA'); }
        return { data: json, status: response.status, headers: response.headers };
      } catch (error) {
        if (this.abort.signal.aborted) throw new AppError('STALE');
        if (controller.signal.aborted) throw new AppError('TIMEOUT');
        if (error instanceof AppError) throw error;
        throw new AppError('NETWORK');
      } finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', cancel); }
    });
  }
  private async list(path: string): Promise<IssueIdentity[]> {
    const items = new Map<string, IssueIdentity>();
    for (let page = 1; page <= 1000; page++) {
      const response = await this.request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(response.data) || response.data.length > 100) throw new AppError('SCHEMA');
      for (const row of response.data) { const issue = identity(row); items.set(issueKey(issue), issue); }
      const nextPart = (response.headers.get('link') ?? '').split(',').find(part => /;\s*rel="next"/.test(part));
      if (!nextPart) return [...items.values()];
      const href = /<([^>]+)>/.exec(nextPart)?.[1];
      if (!href) throw new AppError('SCHEMA');
      let next: URL;
      try { next = new URL(href, API_ORIGIN); } catch { throw new AppError('SCHEMA'); }
      if (next.origin !== API_ORIGIN || next.pathname !== path || Number(next.searchParams.get('page')) !== page + 1 || next.username || next.password) throw new AppError('SCHEMA');
    }
    throw new AppError('SCHEMA');
  }
  private async resolveIssue(issue: IssueIdentity): Promise<number> {
    const { data } = await this.request(issuePath(issue));
    if (issueKey(identity(data)) !== issueKey(issue)) throw new AppError('SCHEMA');
    const id = record(data).id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new AppError('SCHEMA');
    return id;
  }
  private async parent(issue: IssueIdentity): Promise<IssueIdentity | null> {
    const response = await this.request(`${issuePath(issue)}/parent`, { allowNotFound: true });
    if (response.status !== 404) return identity(response.data);
    await this.resolveIssue(issue);
    return null;
  }
  async blockedBy(issue: IssueIdentity): Promise<Dependency[]> {
    if (!isIssue(issue)) throw new AppError('MESSAGE');
    const blockers = await this.list(`${issuePath(issue)}/dependencies/blocked_by`);
    return normalize(blockers.map(blocker => ({ blocker, blocked: issue })));
  }
  async relationships(issue: IssueIdentity): Promise<IssueRelationships> {
    if (!isIssue(issue)) throw new AppError('MESSAGE');
    const path = issuePath(issue);
    const [dependencies, parent, children] = await Promise.all([
      this.dependencySummary(issue),
      this.parent(issue),
      this.list(`${path}/sub_issues`),
    ]);
    return { ...dependencies, parent, children };
  }
  async dependencySummary(issue: IssueIdentity): Promise<Pick<IssueRelationships, 'blockedBy' | 'blocking'>> {
    if (!isIssue(issue)) throw new AppError('MESSAGE');
    const path = issuePath(issue);
    const [blockedBy, blocking] = await Promise.all([
      this.list(`${path}/dependencies/blocked_by`),
      this.list(`${path}/dependencies/blocking`),
    ]);
    return { blockedBy, blocking };
  }
  async changeRelationship(change: ChangeRelationship): Promise<void> {
    if (!change || !isIssue(change.issue) || !isIssue(change.related) || !['blockedBy', 'blocking', 'parent', 'child'].includes(change.kind) || !['add', 'remove'].includes(change.action)) throw new AppError('MESSAGE');
    const { issue, related, kind, action } = change;
    if (issueKey(issue) === issueKey(related)) throw new AppError('VALIDATION');
    const [issueId, relatedId] = await Promise.all([this.resolveIssue(issue), this.resolveIssue(related)]);
    if (kind === 'blockedBy' || kind === 'blocking') {
      const blocked = kind === 'blockedBy' ? issue : related;
      const blockerId = kind === 'blockedBy' ? relatedId : issueId;
      const path = `${issuePath(blocked)}/dependencies/blocked_by`;
      await this.request(action === 'add' ? path : `${path}/${blockerId}`, { method: action === 'add' ? 'POST' : 'DELETE', ...(action === 'add' ? { body: { issue_id: blockerId } } : {}), noResponse: true, write: true });
      return;
    }
    const parent = kind === 'parent' ? related : issue;
    const child = kind === 'parent' ? issue : related;
    const childId = kind === 'parent' ? issueId : relatedId;
    if (action === 'add') {
      const existing = await this.parent(child);
      if (existing && issueKey(existing) !== issueKey(parent)) throw new AppError('CONFLICT');
      if (existing) return;
    }
    await this.request(`${issuePath(parent)}/${action === 'add' ? 'sub_issues' : 'sub_issue'}`, { method: action === 'add' ? 'POST' : 'DELETE', body: { sub_issue_id: childId, ...(action === 'add' ? { replace_parent: false } : {}) }, noResponse: true, write: true });
  }
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (typeof query !== 'string' || !query.trim() || !variables || typeof variables !== 'object' || Array.isArray(variables)) throw new AppError('MESSAGE');
    const write = /^\s*mutation\b/.test(query);
    const response = await this.request('/graphql', { method: 'POST', body: { query, variables }, write });
    const body = record(response.data);
    if (body.errors !== undefined && !Array.isArray(body.errors)) throw new AppError('SCHEMA');
    if (Array.isArray(body.errors) && body.errors.length) {
      const types = body.errors.map(error => {
        const value = record(error);
        const extension = value.extensions && typeof value.extensions === 'object' ? value.extensions as Record<string, unknown> : {};
        return value.type ?? extension.code;
      });
      if (types.includes('RATE_LIMITED')) return this.limit(response.headers);
      if (types.includes('FORBIDDEN') || types.includes('INSUFFICIENT_SCOPES')) throw new AppError(write ? 'WRITE_FORBIDDEN' : 'FORBIDDEN');
      if (types.includes('NOT_FOUND')) throw new AppError('NOT_FOUND');
      if (types.includes('CONFLICT')) throw new AppError('CONFLICT');
      if (types.includes('UNPROCESSABLE') || types.includes('BAD_USER_INPUT')) throw new AppError('VALIDATION');
      throw new AppError('API');
    }
    record(body.data);
    return body.data as T;
  }
}
