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
