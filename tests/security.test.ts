import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorized, parseRequest } from '../src/shared/messages';
import { SessionAuth } from '../src/background/auth';
import { readFileSync } from 'node:fs';
const popup = 'chrome-extension://extension-id/src/popup/index.html';
const content = { id: 'extension-id', url: 'https://github.com/orgs/acme/projects/1', tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender;
describe('message trust boundary', () => {
 it('accepts only exact fixed operations and validated IDs', () => {
   expect(parseRequest({ type: 'FETCH', url: 'https://evil.test' })).toBeNull();
   expect(parseRequest({ type: 'GET_STATE', token: 'extra' })).toBeNull();
   expect(parseRequest({ type: 'SET_TOKEN', token: 'garbage' })).toBeNull();
   expect(parseRequest({ type: 'DEPENDENCIES', issues: [{ owner: '../x', repo: 'x', number: 1 }] })).toBeNull();
   expect(parseRequest({ type: 'DEPENDENCIES', issues: Array.from({ length: 201 }, () => ({ owner: 'a', repo: 'b', number: 1 })) })).toBeNull();
 });
 it('does not expose auth mutations or cache invalidation to content scripts', () => {
   for (const request of [{ type: 'SET_TOKEN', token: 'secret' }, { type: 'SET_ENABLED', enabled: true }, { type: 'LOGOUT' }, { type: 'REFRESH' }] as const) expect(authorized(request, content, 'extension-id', popup)).toBe(false);
   expect(authorized({ type: 'GET_STATE' }, content, 'extension-id', popup)).toBe(true);
   expect(authorized({ type: 'GET_STATE' }, { ...content, frameId: 2 }, 'extension-id', popup)).toBe(false);
   expect(authorized({ type: 'GET_STATE' }, { ...content, id: 'evil' }, 'extension-id', popup)).toBe(false);
   expect(authorized({ type: 'GET_STATE' }, { ...content, url: 'https://evil.test' }, 'extension-id', popup)).toBe(false);
   expect(authorized({ type: 'LOGOUT' }, { id: 'extension-id', url: popup }, 'extension-id', popup)).toBe(true);
 });
});
describe('session-only auth', () => {
 let session: Record<string, unknown>;
 let local: Record<string, unknown>;
 const access = vi.fn();
 beforeEach(() => {
   session = {}; local = {}; access.mockClear();
   const area = (data: Record<string, unknown>) => ({ setAccessLevel: access.mockResolvedValue(undefined), get: vi.fn(async (key: string) => ({ [key]: data[key] })), set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); }), remove: vi.fn(async (key: string) => { delete data[key]; }) });
   vi.stubGlobal('chrome', { storage: { session: area(session), local: area(local) } });
 });
 it('survives worker object restarts, restricts access, stores only toggle locally, logs out', async () => {
   const auth = new SessionAuth();
   await expect(auth.setEnabled(true)).rejects.toMatchObject({ code: 'AUTH_MISSING' });
   await auth.setToken('fixture-only'); await auth.setEnabled(true);
   expect(await new SessionAuth().getToken()).toBe('fixture-only');
   expect(await auth.settings()).toEqual({ authenticated: true, enabled: true });
   expect(local).toEqual({ enabled: true }); expect(session).toEqual({ token: 'fixture-only' });
   expect(access).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
   await auth.logout(); await auth.setEnabled(false); expect(session).toEqual({});
   expect(await auth.settings()).toEqual({ authenticated: false, enabled: false });
 });
 it('ships minimal manifest privileges and no remote scripts', () => {
   const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
   expect(manifest.permissions).toEqual(['storage']);
   expect(manifest.host_permissions).toEqual(['https://github.com/*', 'https://api.github.com/*']);
   expect(manifest).not.toHaveProperty('externally_connectable');
   expect(manifest.content_security_policy.extension_pages).toContain('connect-src https://api.github.com;');
 });
});
