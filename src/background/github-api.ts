import { type IssueIdentity, isIssue, parseIssueUrl } from '../domain/issue';
import { type Dependency, normalize } from '../domain/graph';
import { API_ORIGIN, API_VERSION } from '../shared/config';
import { AppError } from '../shared/errors';
import type { AuthProvider } from './auth';
export interface CooldownStore { read(): Promise<number>; write(until: number): Promise<void> }
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
  private async page(issue: IssueIdentity, page: number): Promise<{ items: IssueIdentity[]; next: boolean }> {
    return this.slot(async () => {
      if (this.abort.signal.aborted) throw new AppError('STALE');
      if (this.invalidAuth) throw new AppError('AUTH_INVALID');
      this.cooldown = Math.max(this.cooldown, await this.cooldownStore?.read() ?? 0);
      if (this.now() < this.cooldown) throw new AppError('RATE_LIMIT', this.cooldown);
      const token = await this.auth.getToken();
      const path = `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/dependencies/blocked_by`;
      const url = new URL(path, API_ORIGIN);
      url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const request = this.fetcher;
        const response = await request(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION } });
        if (response.status === 401) { this.invalidAuth = true; throw new AppError('AUTH_INVALID'); }
        if (response.status === 403 || response.status === 429) {
          const retry = response.headers.get('retry-after');
          const limited = response.status === 429 || retry !== null || response.headers.get('x-ratelimit-remaining') === '0';
          // GitHub may signal secondary limits with only a 403 response body.
          const body = limited ? '' : (await response.text()).slice(0, 8192).toLowerCase();
          if (limited || body.includes('rate limit') || body.includes('abuse')) {
            const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
            const retryDate = retry === null ? NaN : Date.parse(retry);
            const resetHeader = response.headers.get('x-ratelimit-reset');
            const reset = resetHeader && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 : 0;
            this.cooldown = Math.max(this.now() + 60_000, Number.isFinite(seconds) ? this.now() + seconds * 1000 : 0, Number.isFinite(retryDate) ? retryDate : 0, reset);
            await this.cooldownStore?.write(this.cooldown);
            throw new AppError('RATE_LIMIT', this.cooldown);
          }
          if (response.status === 403 && /^\s*required\s*(?:;|$)/i.test(response.headers.get('x-github-sso') ?? '')) throw new AppError('SSO_REQUIRED');
          throw new AppError('FORBIDDEN');
        }
        if (response.status === 404) throw new AppError('NOT_FOUND');
        if (!response.ok) throw new AppError('API');
        let json: unknown;
        try { json = await response.json(); } catch { throw new AppError('SCHEMA'); }
        if (!Array.isArray(json) || json.length > 100) throw new AppError('SCHEMA');
        const items = json.map((row: unknown) => {
          if (!row || typeof row !== 'object') throw new AppError('SCHEMA');
          const value = row as Record<string, unknown>;
          const parsed = typeof value.html_url === 'string' ? parseIssueUrl(value.html_url) : null;
          if (!parsed || value.number !== parsed.number || value.pull_request) throw new AppError('SCHEMA');
          return parsed;
        });
        const link = response.headers.get('link') ?? '';
        const nextPart = link.split(',').find(part => /;\s*rel="next"/.test(part));
        if (nextPart) {
          const href = /<([^>]+)>/.exec(nextPart)?.[1];
          if (!href) throw new AppError('SCHEMA');
          const next = new URL(href, API_ORIGIN);
          if (next.origin !== API_ORIGIN || next.pathname !== path || Number(next.searchParams.get('page')) !== page + 1 || next.username || next.password) throw new AppError('SCHEMA');
        }
        return { items, next: !!nextPart };
      } catch (error) {
        if (this.abort.signal.aborted) throw new AppError('STALE');
        if (controller.signal.aborted) throw new AppError('TIMEOUT');
        if (error instanceof AppError) throw error;
        throw new AppError('NETWORK');
      } finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', cancel); }
    });
  }
  async blockedBy(issue: IssueIdentity): Promise<Dependency[]> {
    if (!isIssue(issue)) throw new AppError('MESSAGE');
    const edges: Dependency[] = [];
    for (let page = 1; page <= 1000; page++) {
      const response = await this.page(issue, page);
      edges.push(...response.items.map(blocker => ({ blocker, blocked: issue })));
      if (!response.next) return normalize(edges);
    }
    throw new AppError('SCHEMA');
  }
}
