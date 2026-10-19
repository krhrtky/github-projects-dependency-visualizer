import { SessionAuth } from './auth';
import { GitHubApi } from './github-api';
import { DependencyRepository } from './dependency-repository';
import { authorized, parseRequest, type IssueResult, type Reply, type Request, type RelationshipChangeReport } from '../shared/messages';
import { AppError, safeError } from '../shared/errors';
import { issueKey } from '../domain/issue';
import { ProjectIntegration } from './project-integration';
import type { OwnedProjectFields, ProjectFieldStore } from '../domain/project';
const auth = new SessionAuth();
function createApi(): GitHubApi {
  return new GitHubApi(auth, fetch, Date.now, 15_000, {
    async read() { const { rateLimitUntil } = await chrome.storage.session.get('rateLimitUntil'); return typeof rateLimitUntil === 'number' ? rateLimitUntil : 0; },
    async write(rateLimitUntil) { await chrome.storage.session.set({ rateLimitUntil }); }
  });
}
let api = createApi();
let repository = new DependencyRepository(api);
const projectFields: ProjectFieldStore = {
  async get(key) {
    const data = await chrome.storage.local.get(`relationshipFields:${key}`);
    const value: unknown = data[`relationshipFields:${key}`];
    if (!value || typeof value !== 'object') return null;
    return Object.fromEntries(Object.entries(value).filter(([name, id]) => ['blockers', 'blocking', 'status'].includes(name) && typeof id === 'string' && id.length > 0 && id.length < 256)) as OwnedProjectFields;
  },
  async set(key, fields) { await chrome.storage.local.set({ [`relationshipFields:${key}`]: fields }); }
};
function reset(): void { api.dispose(); repository.clear(); api = createApi(); repository = new DependencyRepository(api); }
async function notifyTab(tabId: number, message: unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })
    ]);
  } finally { clearTimeout(timer); }
}
async function broadcast(relationshipsOnly = false): Promise<void> {
  const settings = await auth.settings();
  const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  await Promise.allSettled(tabs.filter(t => t.id !== undefined && !t.discarded && !('frozen' in t && t.frozen === true)).map(t => notifyTab(t.id!, { type: 'SETTINGS_CHANGED', settings, ...(relationshipsOnly ? { relationshipsOnly: true } : {}) })));
}
async function relationshipsChanged(): Promise<void> {
  repository.clear();
  const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  await Promise.allSettled(tabs.filter(t => t.id !== undefined && !t.discarded && !('frozen' in t && t.frozen === true)).map(t => notifyTab(t.id!, { type: 'RELATIONSHIPS_CHANGED' })));
}
async function requireEnabled(): Promise<void> {
  const settings = await auth.settings();
  if (!settings.authenticated) throw new AppError('AUTH_MISSING');
  if (!settings.enabled) throw new AppError('STALE');
}
async function handle(request: Request): Promise<unknown> {
  const currentApi = api;
  switch (request.type) {
    case 'GET_STATE': return auth.settings();
    case 'SET_TOKEN': await auth.setToken(request.token); reset(); await broadcast(); return auth.settings();
    case 'SET_ENABLED': await auth.setEnabled(request.enabled); reset(); await broadcast(); return auth.settings();
    case 'SET_RELATIONSHIPS_VISIBLE': await auth.setRelationshipsVisible(request.visible); await broadcast(true); return auth.settings();
    case 'LOGOUT': await auth.logout(); await auth.setEnabled(false); reset(); await broadcast(); return auth.settings();
    case 'REFRESH': reset(); await broadcast(); return auth.settings();
    case 'RELATIONSHIPS': {
      await requireEnabled();
      if (currentApi !== api) throw new AppError('STALE');
      const current = currentApi;
      const result = await current.relationships(request.issue);
      if (current !== api) throw new AppError('STALE');
      return result;
    }
    case 'CHANGE_RELATIONSHIP': {
      await requireEnabled();
      if (currentApi !== api) throw new AppError('STALE');
      const current = currentApi;
      let report: RelationshipChangeReport = { changed: true };
      try {
        await current.changeRelationship(request.change);
        if (current !== api) throw new AppError('STALE');
        if (request.project) {
          try { report = { changed: true, sync: await new ProjectIntegration(current, projectFields).refresh(request.project, [request.change.issue, request.change.related]) }; }
          catch (error) { report = { changed: true, syncError: safeError(error) }; }
        }
      } finally { await relationshipsChanged(); }
      return report;
    }
    case 'PROJECT_PREVIEW':
    case 'PROJECT_SYNC': {
      await requireEnabled();
      if (currentApi !== api) throw new AppError('STALE');
      const current = currentApi;
      const integration = new ProjectIntegration(current, projectFields);
      const result = request.type === 'PROJECT_PREVIEW' ? await integration.preview(request.project) : await integration.sync(request.project);
      if (current !== api) throw new AppError('STALE');
      return result;
    }
    case 'DEPENDENCIES': {
      await requireEnabled();
      if (currentApi !== api) throw new AppError('STALE');
      const current = repository;
      const issues = [...new Map(request.issues.map(i => [issueKey(i), i])).values()];
      const results = await Promise.all(issues.map(async (issue): Promise<IssueResult> => {
        try { return { issue, ok: true, dependencies: await current.get(issue) }; }
        catch (error) { return { issue, ok: false, error: safeError(error) }; }
      }));
      if (current !== repository) throw new AppError('STALE');
      return results;
    }
  }
}
// Serializing settings mutations prevents token rotation and logout from overtaking each other.
let mutations = Promise.resolve<unknown>(undefined);
let relationshipWrites = Promise.resolve<unknown>(undefined);
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  const request = parseRequest(raw);
  if (!request || !authorized(request, sender, chrome.runtime.id, chrome.runtime.getURL('src/popup/index.html'))) {
    respond({ ok: false, error: { code: 'MESSAGE' } }); return false;
  }
  const isMutation = ['SET_TOKEN', 'SET_ENABLED', 'SET_RELATIONSHIPS_VISIBLE', 'LOGOUT', 'REFRESH'].includes(request.type);
  const isWrite = request.type === 'CHANGE_RELATIONSHIP' || request.type === 'PROJECT_SYNC';
  const requestedApi = api;
  const task = isWrite ? relationshipWrites.then(() => mutations).then(() => {
    if (requestedApi !== api) throw new AppError('STALE');
    return handle(request);
  }) : mutations.then(() => handle(request));
  if (isMutation) mutations = task.catch(() => undefined);
  if (isWrite) relationshipWrites = task.catch(() => undefined);
  void task.then(data => respond({ ok: true, data } satisfies Reply<unknown>), error => respond({ ok: false, error: safeError(error) } satisfies Reply<unknown>));
  return true;
});
