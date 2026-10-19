import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply, Request, Settings } from '../src/shared/messages';
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean;
let listener: Listener;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let tabs: { id: number; discarded?: boolean; frozen?: boolean }[];
let sendMessage: ReturnType<typeof vi.fn>;
const popup = { id: 'fixture-id', url: 'chrome-extension://fixture-id/src/popup/index.html' };
async function request(message: Request): Promise<Reply<Settings>> {
 return new Promise(resolve => listener(message, popup, value => resolve(value as Reply<Settings>)));
}
beforeEach(async () => {
 vi.useFakeTimers(); vi.resetModules(); local = {}; session = {}; tabs = [];
 const storage = (values: Record<string, unknown>) => ({ setAccessLevel: vi.fn(async () => undefined), get: vi.fn(async (key: string) => ({ [key]: values[key] })), set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(values, data); }), remove: vi.fn(async (key: string) => { delete values[key]; }) });
 sendMessage = vi.fn(async () => ({ ok: true }));
 vi.stubGlobal('chrome', { storage: { session: storage(session), local: storage(local) }, tabs: { query: vi.fn(async () => tabs), sendMessage }, runtime: { id: 'fixture-id', getURL: (path: string) => `chrome-extension://fixture-id/${path}`, onMessage: { addListener: (fn: Listener) => { listener = fn; } } } });
 await import('../src/background/index');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('background settings do not depend on sleeping tabs', () => {
 it('stores classic PATs in the session and returns only authentication state', async () => {
   const token = 'ghp_' + 'x'.repeat(36);
   expect(await request({ type: 'SET_TOKEN', token })).toEqual({ ok: true, data: { enabled: false, authenticated: true } });
   expect(session).toEqual({ token });
   expect(local).toEqual({});
   expect(await request({ type: 'GET_STATE' })).toEqual({ ok: true, data: { enabled: false, authenticated: true } });
 });
 it('skips frozen and discarded tabs and keeps settings readable', async () => {
   tabs = [{ id: 1 }, { id: 2, frozen: true }, { id: 3, discarded: true }];
   expect(await request({ type: 'SET_TOKEN', token: 'github_pat_' + 'x'.repeat(50) })).toEqual({ ok: true, data: { enabled: false, authenticated: true } });
   expect(sendMessage.mock.calls.map(c => c[0])).toEqual([1]);
   expect(await request({ type: 'SET_ENABLED', enabled: true })).toEqual({ ok: true, data: { enabled: true, authenticated: true } });
   expect(await request({ type: 'GET_STATE' })).toEqual({ ok: true, data: { enabled: true, authenticated: true } });
   expect(local).toEqual({ enabled: true });
 });
 it('bounds notification waits and unblocks later auth and toggle operations', async () => {
   tabs = [{ id: 1 }]; sendMessage.mockImplementation(() => new Promise(() => undefined));
   const tokenReply = request({ type: 'SET_TOKEN', token: 'github_pat_' + 'x'.repeat(50) });
   const stateReply = request({ type: 'GET_STATE' });
   await vi.advanceTimersByTimeAsync(1000);
   expect(await tokenReply).toMatchObject({ ok: true, data: { authenticated: true } });
   expect(await stateReply).toMatchObject({ ok: true, data: { authenticated: true } });
   const enabledReply = request({ type: 'SET_ENABLED', enabled: true });
   await vi.advanceTimersByTimeAsync(1000);
   expect(await enabledReply).toMatchObject({ ok: true, data: { enabled: true } });
   const logoutReply = request({ type: 'LOGOUT' }); await vi.advanceTimersByTimeAsync(1000);
   expect(await logoutReply).toEqual({ ok: true, data: { enabled: false, authenticated: false } });
   expect(session).not.toHaveProperty('token');
 });
});

describe('relationship writes respect session changes', () => {
 const change: Request = { type: 'CHANGE_RELATIONSHIP', change: { issue: { owner: 'acme', repo: 'app', number: 2 }, related: { owner: 'acme', repo: 'api', number: 7 }, kind: 'blockedBy', action: 'add' } };
 const sync: Request = { type: 'PROJECT_SYNC', project: { kind: 'orgs', owner: 'acme', number: 1 } };
 const operations = [change, sync];
 const settingsChanges: Request[] = [{ type: 'SET_ENABLED', enabled: false }, { type: 'SET_TOKEN', token: 'ghp_' + 'y'.repeat(36) }, { type: 'LOGOUT' }];

 it.each(operations.flatMap(operation => settingsChanges.map(settingsChange => [operation, settingsChange] as const)))('rejects %j if %j finishes while its settings read is pending', async (operation, settingsChange) => {
   const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} })));
   vi.stubGlobal('fetch', fetcher);
   await request({ type: 'SET_TOKEN', token: 'ghp_' + 'x'.repeat(36) });
   await request({ type: 'SET_ENABLED', enabled: true });
   const snapshot = { enabled: local.enabled };
   let release: (() => void) | undefined;
   const readLocal = chrome.storage.local.get as ReturnType<typeof vi.fn>;
   readLocal.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(snapshot); }));
   const pending = request(operation);
   await vi.waitFor(() => expect(release).toBeTypeOf('function'));
   expect(await request(settingsChange)).toMatchObject({ ok: true });
   release!();
   expect(await pending).toEqual({ ok: false, error: { code: 'STALE' } });
   expect(fetcher).not.toHaveBeenCalled();
 });

 it('serializes relationship writes and completes logout while a sent write is still pending', async () => {
   let completeWrite: ((response: Response) => void) | undefined;
   const fetcher = vi.fn((url: string, options: RequestInit) => {
     if (options.method !== 'GET') return new Promise<Response>(resolve => { completeWrite = resolve; });
     const parts = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(new URL(url).pathname)!;
     return Promise.resolve(new Response(JSON.stringify({ id: Number(parts[3]) * 100, number: Number(parts[3]), html_url: `https://github.com/${parts[1]}/${parts[2]}/issues/${parts[3]}` })));
   });
   vi.stubGlobal('fetch', fetcher);
   await request({ type: 'SET_TOKEN', token: 'ghp_' + 'x'.repeat(36) });
   await request({ type: 'SET_ENABLED', enabled: true });
   const first = request(change);
   await vi.waitFor(() => expect(completeWrite).toBeTypeOf('function'));
   const second = request(change);
   await vi.advanceTimersByTimeAsync(0);
   expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
   expect(await request({ type: 'LOGOUT' })).toEqual({ ok: true, data: { enabled: false, authenticated: false } });
   expect(session).not.toHaveProperty('token');
   completeWrite!(new Response(null, { status: 204 }));
   expect(await first).toEqual({ ok: false, error: { code: 'STALE' } });
   expect(await second).toEqual({ ok: false, error: { code: 'STALE' } });
   expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
 });
});
