import { describe, it, expect, vi } from 'vitest';
import { GitHubApi } from '../src/background/github-api';
import { DependencyRepository } from '../src/background/dependency-repository';
import { safeError } from '../src/shared/errors';
const issue = { owner: 'acme', repo: 'app', number: 2 };
const row = { html_url: 'https://github.com/acme/api/issues/1', number: 1 };
const auth = { getToken: async () => 'secret-fixture-token' };
const response = (body: unknown = [row], status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const client = (fn: ReturnType<typeof vi.fn>, now = Date.now) => new GitHubApi(auth, fn as typeof fetch, now);
describe('fixed GitHub API transport', () => {
 it('normalizes blockers, excludes duplicates and uses fixed security options', async () => {
   const fetcher = vi.fn().mockResolvedValue(response([row, row]));
   expect(await client(fetcher).blockedBy(issue)).toEqual([{ blocker: { owner: 'acme', repo: 'api', number: 1 }, blocked: issue }]);
   const [url, options] = fetcher.mock.calls[0]!;
   expect(url).toBe('https://api.github.com/repos/acme/app/issues/2/dependencies/blocked_by?per_page=100&page=1');
   expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer secret-fixture-token', 'X-GitHub-Api-Version': '2026-03-10' } });
 });
 it('invokes the injected fetch function without binding it to the client instance', async () => {
   const fetcher = vi.fn(function(this: unknown) {
     if (this !== undefined) throw new TypeError('Illegal invocation');
     return Promise.resolve(response([]));
   });
   expect(await client(fetcher).blockedBy(issue)).toEqual([]);
   expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('returns an empty list for no dependencies', async () => { expect(await client(vi.fn().mockResolvedValue(response([]))).blockedBy(issue)).toEqual([]); });
 it.each([[401, 'AUTH_INVALID'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [500, 'API']])('handles HTTP %i distinctly', async (status, code) => {
   await expect(client(vi.fn().mockResolvedValue(response({}, status as number))).blockedBy(issue)).rejects.toMatchObject({ code });
 });
 it('reports SSO authorization without exposing response data and permits recovery', async () => {
   const fetcher = vi.fn()
     .mockResolvedValueOnce(response({ message: 'private organization details' }, 403, { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso?authorization_request=private' }))
     .mockResolvedValueOnce(response([]));
   const api = client(fetcher);
   expect(await api.blockedBy(issue).catch(safeError)).toEqual({ code: 'SSO_REQUIRED' });
   expect(await api.blockedBy(issue)).toEqual([]);
 });
 it.each(['partial-results; organizations=123', 'not-required', ''])('does not treat other SSO header values as required authorization', header => {
   return expect(client(vi.fn().mockResolvedValue(response({}, 403, { 'X-GitHub-SSO': header }))).blockedBy(issue)).rejects.toMatchObject({ code: 'FORBIDDEN' });
 });
 it('honors rate limiting when an SSO header is also present', async () => {
   const fetcher = vi.fn().mockResolvedValue(response({}, 403, { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso', 'retry-after': '120' }));
   const api = client(fetcher, () => 1000);
   await expect(api.blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: 121000 });
   await expect(api.blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
   expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('paginates without following arbitrary links', async () => {
   const next = 'https://api.github.com/repos/acme/app/issues/2/dependencies/blocked_by?per_page=100&page=2';
   const fetcher = vi.fn().mockResolvedValueOnce(response([row], 200, { link: `<${next}>; rel="next"` })).mockResolvedValueOnce(response([{ ...row, number: 3, html_url: 'https://github.com/acme/app/issues/3' }]));
   expect(await client(fetcher).blockedBy(issue)).toHaveLength(2);
   expect(fetcher.mock.calls[1]![0]).toBe(next);
 });
 it.each(['https://evil.test/steal?page=2', 'https://api.github.com/user?page=2', 'https://api.github.com/repos/acme/app/issues/2/dependencies/blocked_by?page=1'])('rejects pagination URL %s', async url => {
   const fetcher = vi.fn().mockResolvedValue(response([row], 200, { link: `<${url}>; rel="next"` }));
   await expect(client(fetcher).blockedBy(issue)).rejects.toMatchObject({ code: 'SCHEMA' }); expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([{}, [null], [{ number: 1 }], [{ ...row, number: 99 }], [{ ...row, pull_request: {} }], [{ ...row, html_url: 'https://evil.test/1' }]])('rejects unexpected schemas', async body => {
   await expect(client(vi.fn().mockResolvedValue(response(body))).blockedBy(issue)).rejects.toMatchObject({ code: 'SCHEMA' });
 });
 it('rejects invalid JSON and sanitizes network errors', async () => {
   await expect(client(vi.fn().mockResolvedValue(new Response('{'))).blockedBy(issue)).rejects.toMatchObject({ code: 'SCHEMA' });
   const failure = client(vi.fn().mockRejectedValue(new Error('secret-fixture-token'))).blockedBy(issue);
   await expect(failure).rejects.toMatchObject({ code: 'NETWORK', message: 'NETWORK' });
 });
 it('aborts network timeouts and canceled sessions', async () => {
   const fetcher = vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
   await expect(new GitHubApi(auth, fetcher as typeof fetch, Date.now, 5).blockedBy(issue)).rejects.toMatchObject({ code: 'TIMEOUT' });
   const api = client(fetcher); const pending = api.blockedBy(issue); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); api.dispose();
   await expect(pending).rejects.toMatchObject({ code: 'STALE' });
 });
 it.each([
   [429, {}, { 'retry-after': '120' }, 121000],
   [403, { message: 'You have exceeded a secondary rate limit.' }, {}, 61000],
   [403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' }, 200000],
   [429, {}, { 'retry-after': new Date(181000).toUTCString() }, 181000]
 ])('respects rate limits without automatic retries', async (status, body, headers, until) => {
   const fetcher = vi.fn().mockResolvedValue(response(body, status, headers as Record<string, string>));
   const api = client(fetcher, () => 1000);
   await expect(api.blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: until });
   await expect(api.blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT' }); expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('persists cooldown across worker/client restarts', async () => {
   let saved = 0;
   const store = { read: async () => saved, write: async (n: number) => { saved = n; } };
   const fetcher = vi.fn().mockResolvedValue(response({}, 429));
   await expect(new GitHubApi(auth, fetcher as typeof fetch, () => 1000, 500, store).blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
   await expect(new GitHubApi(auth, fetcher as typeof fetch, () => 2000, 500, store).blockedBy(issue)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
   expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('limits concurrent API calls to four', async () => {
   let active = 0, maximum = 0;
   const fetcher = vi.fn(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return response([]); });
   const api = client(fetcher);
   await Promise.all(Array.from({ length: 30 }, (_, n) => api.blockedBy({ ...issue, number: n + 1 })));
   expect(maximum).toBe(4);
 });
});
describe('dependency cache', () => {
 it('coalesces requests, expires at 60s and clears manually', async () => {
   let now = 0;
   const blockedBy = vi.fn().mockResolvedValue([]);
   const repo = new DependencyRepository({ blockedBy }, () => now);
   await Promise.all([repo.get(issue), repo.get(issue)]); expect(blockedBy).toHaveBeenCalledTimes(1);
   now = 59999; await repo.get(issue); expect(blockedBy).toHaveBeenCalledTimes(1);
   now = 60000; await repo.get(issue); expect(blockedBy).toHaveBeenCalledTimes(2);
   repo.clear(); await repo.get(issue); expect(blockedBy).toHaveBeenCalledTimes(3);
 });
 it('does not cache failures and does not repopulate from a cleared request', async () => {
   const blockedBy = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue([]);
   const repo = new DependencyRepository({ blockedBy });
   await expect(repo.get(issue)).rejects.toThrow(); await repo.get(issue); expect(blockedBy).toHaveBeenCalledTimes(2);
   let resolve!: (value: []) => void;
   const fn = vi.fn().mockImplementationOnce(() => new Promise<[]>(r => { resolve = r; })).mockResolvedValue([]);
   const other = new DependencyRepository({ blockedBy: fn }); const pending = other.get(issue); other.clear(); resolve([]); await pending; await other.get(issue);
   expect(fn).toHaveBeenCalledTimes(2);
 });
});
