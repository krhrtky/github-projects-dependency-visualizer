import { describe, expect, it, vi } from 'vitest';
import { GitHubApi } from '../src/background/github-api';
import type { IssueIdentity } from '../src/domain/issue';
import type { ChangeRelationship, RelationshipKind } from '../src/domain/relationships';
import { safeError } from '../src/shared/errors';

const issue = { owner: 'acme', repo: 'app', number: 2 };
const related = { owner: 'acme', repo: 'api', number: 7 };
const other = { owner: 'acme', repo: 'other', number: 9 };
const auth = { getToken: async () => 'secret-fixture-token' };
const path = (value: IssueIdentity) => `/repos/${value.owner}/${value.repo}/issues/${value.number}`;
const row = (value: IssueIdentity, id = 700) => ({ id, number: value.number, html_url: `https://github.com/${value.owner}/${value.repo}/issues/${value.number}` });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
function fixtures(url: string, options: RequestInit): Response {
  const pathname = new URL(url).pathname;
  if (options.method !== 'GET') return new Response(null, { status: 204 });
  if (pathname.endsWith('/parent')) return json({}, 404);
  if (pathname === path(issue)) return json(row(issue, 200));
  if (pathname === path(related)) return json(row(related, 700));
  if (pathname === path(other)) return json(row(other, 900));
  return json([]);
}
function client(respond = fixtures) {
  const fetcher = vi.fn(async (url: string, options: RequestInit) => respond(url, options));
  return { api: new GitHubApi(auth, fetcher as typeof fetch), fetcher };
}
const writes = (fetcher: ReturnType<typeof client>['fetcher']) => fetcher.mock.calls.filter(([, options]) => options.method !== 'GET');

describe('native issue relationships', () => {
  it('reads dependencies in both directions, the parent and children', async () => {
    const { api, fetcher } = client((url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/blocked_by')) return json([row(related), row(related)]);
      if (pathname.endsWith('/blocking')) return json([row(other)]);
      if (pathname.endsWith('/parent')) return json(row(related));
      if (pathname.endsWith('/sub_issues')) return json([row(other), row(other)]);
      return fixtures(url, options);
    });
    expect(await api.relationships(issue)).toEqual({ blockedBy: [related], blocking: [other], parent: related, children: [other] });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reads just dependency directions for project field synchronization', async () => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname.endsWith('/blocked_by') ? json([row(related)]) : fixtures(url, options));
    expect(await api.dependencySummary(issue)).toEqual({ blockedBy: [related], blocking: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => url.includes('/dependencies/'))).toBe(true);
  });

  it.each(['blocked_by', 'blocking', 'sub_issues'])('paginates all %s relationships before returning', async endpoint => {
    const suffix = endpoint === 'sub_issues' ? '/sub_issues' : `/dependencies/${endpoint}`;
    const next = `https://api.github.com${path(issue)}${suffix}?per_page=100&page=2`;
    const { api, fetcher } = client((url, options) => {
      if (!new URL(url).pathname.endsWith(suffix)) return fixtures(url, options);
      return new URL(url).searchParams.get('page') === '1'
        ? json([row(related)], 200, { link: `<${next}>; rel="next"` }) : json([row(other)]);
    });
    const result = await api.relationships(issue);
    const values = endpoint === 'blocked_by' ? result.blockedBy : endpoint === 'blocking' ? result.blocking : result.children;
    expect(values).toEqual([related, other]);
    expect(fetcher.mock.calls.some(([url]) => url === next)).toBe(true);
  });

  it('returns no parent only after confirming access to the issue itself', async () => {
    const { api, fetcher } = client();
    expect(await api.relationships(issue)).toEqual({ blockedBy: [], blocking: [], parent: null, children: [] });
    expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === path(issue))).toBe(true);
  });

  it.each([[401, 'AUTH_INVALID'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND']] as const)('does not hide issue access failure %s as an absent parent', async (status, code) => {
    const { api } = client((url, options) => new URL(url).pathname === path(issue) ? json({}, status) : fixtures(url, options));
    await expect(api.relationships(issue)).rejects.toMatchObject({ code });
  });

  it('does not hide a missing dependency endpoint as an empty relationship list', async () => {
    const { api } = client((url, options) => new URL(url).pathname.endsWith('/blocking') ? json({}, 404) : fixtures(url, options));
    await expect(api.relationships(issue)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not expose partial relationship data after one endpoint fails', async () => {
    const { api } = client((url, options) => {
      if (url.includes('/blocked_by')) return json([row(related)]);
      if (url.includes('/sub_issues')) return json({ private: 'sensitive body' }, 403);
      return fixtures(url, options);
    });
    expect(await api.relationships(issue).catch(safeError)).toEqual({ code: 'FORBIDDEN' });
  });

  it.each(['blockedBy', 'blocking'] as const)('writes %s through the canonical blocked_by endpoint using database IDs', async kind => {
    const { api, fetcher } = client();
    await api.changeRelationship({ issue, related, kind, action: 'add' });
    const [url, options] = writes(fetcher)[0]!;
    expect(url).toBe(`https://api.github.com${path(kind === 'blockedBy' ? issue : related)}/dependencies/blocked_by`);
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', headers: { Authorization: 'Bearer secret-fixture-token', 'Content-Type': 'application/json' } });
    expect(JSON.parse(options.body as string)).toEqual({ issue_id: kind === 'blockedBy' ? 700 : 200 });
  });

  it.each(['blockedBy', 'blocking'] as const)('removes %s with the blocking issue database ID in the path', async kind => {
    const { api, fetcher } = client();
    await api.changeRelationship({ issue, related, kind, action: 'remove' });
    const [url, options] = writes(fetcher)[0]!;
    expect(url).toBe(`https://api.github.com${path(kind === 'blockedBy' ? issue : related)}/dependencies/blocked_by/${kind === 'blockedBy' ? 700 : 200}`);
    expect(options.method).toBe('DELETE');
    expect(options.body).toBeUndefined();
  });

  it.each(['parent', 'child'] as const)('adds a %s without replacing an existing parent', async kind => {
    const { api, fetcher } = client();
    await api.changeRelationship({ issue, related, kind, action: 'add' });
    const [url, options] = writes(fetcher)[0]!;
    expect(url).toBe(`https://api.github.com${path(kind === 'parent' ? related : issue)}/sub_issues`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ sub_issue_id: kind === 'parent' ? 200 : 700, replace_parent: false });
  });

  it.each(['parent', 'child'] as const)('removes a %s through the parent issue', async kind => {
    const { api, fetcher } = client();
    await api.changeRelationship({ issue, related, kind, action: 'remove' });
    const [url, options] = writes(fetcher)[0]!;
    expect(url).toBe(`https://api.github.com${path(kind === 'parent' ? related : issue)}/sub_issue`);
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual({ sub_issue_id: kind === 'parent' ? 200 : 700 });
  });

  it.each(['parent', 'child'] as const)('rejects another existing parent when adding %s', async kind => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname.endsWith('/parent') ? json(row(other)) : fixtures(url, options));
    await expect(api.changeRelationship({ issue, related, kind, action: 'add' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(writes(fetcher)).toHaveLength(0);
  });

  it.each(['parent', 'child'] as const)('accepts an already established %s without another write', async kind => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname.endsWith('/parent') ? json(row(kind === 'parent' ? related : issue)) : fixtures(url, options));
    await api.changeRelationship({ issue, related, kind, action: 'add' });
    expect(writes(fetcher)).toHaveLength(0);
  });

  it.each(['blockedBy', 'blocking', 'parent', 'child'] satisfies RelationshipKind[])('rejects self-reference before requesting %s', async kind => {
    const { api, fetcher } = client();
    await expect(api.changeRelationship({ issue, related: { ...issue, owner: 'ACME' }, kind, action: 'add' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([issue, related])('rejects a pull request at either end before writing: %s', async pullRequest => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname === path(pullRequest) ? json({ ...row(pullRequest), pull_request: {} }) : fixtures(url, options));
    await expect(api.changeRelationship({ issue, related, kind: 'blockedBy', action: 'add' })).rejects.toMatchObject({ code: 'SCHEMA' });
    expect(writes(fetcher)).toHaveLength(0);
  });

  it.each([undefined, 0, -1, '700', Number.MAX_SAFE_INTEGER + 1])('rejects an invalid numeric issue ID %s', async id => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname === path(related) ? json({ ...row(related), id }) : fixtures(url, options));
    await expect(api.changeRelationship({ issue, related, kind: 'blockedBy', action: 'add' })).rejects.toMatchObject({ code: 'SCHEMA' });
    expect(writes(fetcher)).toHaveLength(0);
  });

  it('rejects an issue response whose identity differs from the requested issue', async () => {
    const { api, fetcher } = client((url, options) => new URL(url).pathname === path(related) ? json(row(other)) : fixtures(url, options));
    await expect(api.changeRelationship({ issue, related, kind: 'child', action: 'add' })).rejects.toMatchObject({ code: 'SCHEMA' });
    expect(writes(fetcher)).toHaveLength(0);
  });

  it.each([[403, 'WRITE_FORBIDDEN'], [409, 'CONFLICT'], [422, 'VALIDATION'], [500, 'API']] as const)('sanitizes write failure %s without retry or rollback', async (status, code) => {
    const { api, fetcher } = client((url, options) => options.method !== 'GET' ? json({ message: 'sensitive server response' }, status) : fixtures(url, options));
    expect(await api.changeRelationship({ issue, related, kind: 'blockedBy', action: 'add' }).catch(safeError)).toEqual({ code });
    expect(writes(fetcher)).toHaveLength(1);
  });

  it('sanitizes a network failure after sending a write and does not repeat it', async () => {
    const { api, fetcher } = client((url, options) => {
      if (options.method !== 'GET') throw new Error('secret-fixture-token');
      return fixtures(url, options);
    });
    await expect(api.changeRelationship({ issue, related, kind: 'blockedBy', action: 'add' })).rejects.toMatchObject({ code: 'NETWORK', message: 'NETWORK' });
    expect(writes(fetcher)).toHaveLength(1);
  });

  it('prevents requests if the session is disposed while authentication is pending', async () => {
    let resolve!: (token: string) => void;
    const getToken = vi.fn(() => new Promise<string>(complete => { resolve = complete; }));
    const fetcher = vi.fn().mockImplementation(async () => json({ data: {} }));
    const api = new GitHubApi({ getToken }, fetcher as typeof fetch);
    const pending = api.graphql('mutation CreateField { createProjectV2Field { id } }', {});
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));
    api.dispose();
    resolve('secret-fixture-token');
    await expect(pending).rejects.toMatchObject({ code: 'STALE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { issue: { ...issue, number: -2 }, related, kind: 'child', action: 'add' },
    { issue, related, kind: 'other', action: 'add' },
    { issue, related, kind: 'child', action: 'replace' },
  ])('rejects malformed change requests before fetching', async change => {
    const { api, fetcher } = client();
    await expect(api.changeRelationship(change as ChangeRelationship)).rejects.toMatchObject({ code: 'MESSAGE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GraphQL transport for Projects integration', () => {
  it('uses the authenticated API origin and returns only data', async () => {
    const { api, fetcher } = client(() => json({ data: { viewer: { id: 'viewer-id' } } }));
    const query = 'query Viewer { viewer { id } }';
    expect(await api.graphql(query, { project: 7 })).toEqual({ viewer: { id: 'viewer-id' } });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/graphql');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(JSON.parse(options.body as string)).toEqual({ query, variables: { project: 7 } });
  });

  it.each([
    ['FORBIDDEN', 'FORBIDDEN'], ['INSUFFICIENT_SCOPES', 'FORBIDDEN'], ['NOT_FOUND', 'NOT_FOUND'], ['BAD_USER_INPUT', 'VALIDATION'], ['UNPROCESSABLE', 'VALIDATION'], ['CONFLICT', 'CONFLICT'], ['UNKNOWN', 'API'],
  ])('sanitizes GraphQL %s errors, even when partial data is present', async (type, code) => {
    const { api } = client(() => json({ data: { partial: 'private' }, errors: [{ type, message: 'private error details' }] }));
    expect(await api.graphql('query { viewer { id } }', {}).catch(safeError)).toEqual({ code });
  });

  it.each(['FORBIDDEN', 'INSUFFICIENT_SCOPES'])('reports GraphQL mutation permission failures distinctly (%s)', async code => {
    const { api } = client(() => json({ errors: [{ extensions: { code }, message: 'private' }] }));
    await expect(api.graphql('mutation CreateField { createProjectV2Field { id } }', {})).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN' });
  });

  it('persists GraphQL rate limits and prevents another request', async () => {
    let until = 0;
    const fetcher = vi.fn().mockImplementation(async () => json({ errors: [{ type: 'RATE_LIMITED' }] }));
    const api = new GitHubApi(auth, fetcher as typeof fetch, () => 1000, 1000, { read: async () => until, write: async value => { until = value; } });
    await expect(api.graphql('query { viewer { id } }', {})).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: 61000 });
    await expect(api.graphql('query { viewer { id } }', {})).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(until).toBe(61000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { data: null }, { data: 1 }, { data: [] }, { errors: 'private' }, { errors: [null] }])('rejects malformed GraphQL payloads', async body => {
    const { api } = client(() => json(body));
    await expect(api.graphql('query { viewer { id } }', {})).rejects.toMatchObject({ code: 'SCHEMA' });
  });

  it('rejects an empty query without fetching', async () => {
    const { api, fetcher } = client();
    await expect(api.graphql(' ', {})).rejects.toMatchObject({ code: 'MESSAGE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
