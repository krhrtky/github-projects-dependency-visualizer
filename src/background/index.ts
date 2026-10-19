import { SessionAuth } from './auth';
import { GitHubApi } from './github-api';
import { DependencyRepository } from './dependency-repository';
import { authorized, parseRequest, type IssueResult, type Reply, type Request } from '../shared/messages';
import { AppError, safeError } from '../shared/errors';
import { issueKey } from '../domain/issue';
const auth = new SessionAuth();
function createApi(): GitHubApi {
  return new GitHubApi(auth, fetch, Date.now, 15_000, {
    async read() { const { rateLimitUntil } = await chrome.storage.session.get('rateLimitUntil'); return typeof rateLimitUntil === 'number' ? rateLimitUntil : 0; },
    async write(rateLimitUntil) { await chrome.storage.session.set({ rateLimitUntil }); }
  });
}
let api = createApi();
let repository = new DependencyRepository(api);
function reset(): void { api.dispose(); repository.clear(); api = createApi(); repository = new DependencyRepository(api); }
async function notifyTab(tabId: number, settings: Awaited<ReturnType<SessionAuth['settings']>>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_CHANGED', settings }),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })
    ]);
  } finally { clearTimeout(timer); }
}
async function broadcast(): Promise<void> {
  const settings = await auth.settings();
  const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  await Promise.allSettled(tabs.filter(t => t.id !== undefined && !t.discarded && !('frozen' in t && t.frozen === true)).map(t => notifyTab(t.id!, settings)));
}
async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'GET_STATE': return auth.settings();
    case 'SET_TOKEN': await auth.setToken(request.token); reset(); await broadcast(); return auth.settings();
    case 'SET_ENABLED': await auth.setEnabled(request.enabled); reset(); await broadcast(); return auth.settings();
    case 'LOGOUT': await auth.logout(); await auth.setEnabled(false); reset(); await broadcast(); return auth.settings();
    case 'REFRESH': reset(); await broadcast(); return auth.settings();
    case 'DEPENDENCIES': {
      const settings = await auth.settings();
      if (!settings.authenticated) throw new AppError('AUTH_MISSING');
      if (!settings.enabled) throw new AppError('STALE');
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
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  const request = parseRequest(raw);
  if (!request || !authorized(request, sender, chrome.runtime.id, chrome.runtime.getURL('src/popup/index.html'))) {
    respond({ ok: false, error: { code: 'MESSAGE' } }); return false;
  }
  const isMutation = !['GET_STATE', 'DEPENDENCIES'].includes(request.type);
  const task = mutations.then(() => handle(request));
  if (isMutation) mutations = task.catch(() => undefined);
  void task.then(data => respond({ ok: true, data } satisfies Reply<unknown>), error => respond({ ok: false, error: safeError(error) } satisfies Reply<unknown>));
  return true;
});
