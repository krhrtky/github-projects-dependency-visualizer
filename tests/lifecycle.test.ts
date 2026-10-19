import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/content/controller';
import { OVERLAY_ID } from '../src/renderer/svg-renderer';
import type { IssueIdentity } from '../src/domain/issue';
let controller: Controller;
let sendMessage: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
let fail = false;
async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(160); }
beforeEach(() => {
 vi.useFakeTimers(); fail = false;
 history.replaceState({}, '', '/orgs/acme/projects/1');
 document.documentElement.innerHTML = readFileSync('tests/fixtures/board.html', 'utf8');
 vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
   const n = [...document.querySelectorAll('article')].indexOf(this);
   return n < 0 ? new DOMRect(0, 0, 900, 600) : new DOMRect(10 + n * 120, 60, 100, 80);
 });
 disconnect = vi.fn();
 vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = disconnect; });
 vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
 vi.stubGlobal('cancelAnimationFrame', clearTimeout);
 sendMessage = vi.fn(async (message: { type: string; issues?: IssueIdentity[] }) => message.type === 'GET_STATE' ? { ok: true, data: { enabled: true, authenticated: true, relationshipsVisible: true } } : {
   ok: true, data: message.issues!.map(issue => fail ? { issue, ok: false, error: { code: 'FORBIDDEN' } } : { issue, ok: true, dependencies: issue.repo === 'api' ? [{ blocker: { owner: 'acme', repo: 'app', number: 1 }, blocked: issue }] : [] })
 });
 vi.stubGlobal('chrome', { runtime: { sendMessage } });
 controller = new Controller(); controller.start();
});
afterEach(() => { controller.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('lifecycle', () => {
 it('turns on/off, avoids duplicate overlays and fetches no API on pure DOM changes', async () => {
   await settle(); expect(controller.status.state).toBe('ready'); expect(controller.status.edges).toBe(1);
   const calls = sendMessage.mock.calls.filter(c => c[0].type === 'DEPENDENCIES').length;
   document.querySelector('article')!.setAttribute('style', 'transform:translateX(10px)'); await settle();
   window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); await settle();
   expect(sendMessage.mock.calls.filter(c => c[0].type === 'DEPENDENCIES')).toHaveLength(calls);
   expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
   controller.configure({ enabled: false, authenticated: true, relationshipsVisible: true }); await settle(); expect(document.getElementById(OVERLAY_ID)).toBeNull(); expect(disconnect).toHaveBeenCalled();
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: true }); await settle(); expect(controller.status.state).toBe('ready');
 });
 it('keeps dependency selection when a control receives focus and refreshes on window focus', async () => {
   const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
   await settle();
   const shadow = attach.mock.results.map(result => result.value as ShadowRoot).find(root => root.host.id === OVERLAY_ID)!;
   const dependency = shadow.querySelector<HTMLButtonElement>('.relations button')!;
   dependency.click();
   const lookups = sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES').length;
   const settings = sendMessage.mock.calls.filter(call => call[0].type === 'GET_STATE').length;
   shadow.querySelector<HTMLSelectElement>('select')!.focus();
   await settle();
   expect(shadow.querySelector('.relations button')!.getAttribute('aria-pressed')).toBe('true');
   expect(controller.status).toMatchObject({ state: 'ready', edges: 1 });
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES')).toHaveLength(lookups);
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'GET_STATE')).toHaveLength(settings);
   window.dispatchEvent(new Event('focus'));
   await settle();
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'GET_STATE')).toHaveLength(settings + 1);
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES')).toHaveLength(lookups + 1);
   expect(controller.status).toMatchObject({ state: 'ready', edges: 1 });
 });
 it('toggles relationship controls without losing dependency results or selection', async () => {
   const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
   await settle();
   const shadows = () => attach.mock.results.map(result => result.value as ShadowRoot);
   const overlay = document.getElementById(OVERLAY_ID);
   const analysis = shadows().find(root => root.host === overlay)!;
   analysis.querySelector<HTMLButtonElement>('.relations button')!.click();
   sendMessage.mockResolvedValueOnce({ ok: true, data: { blockedBy: [], blocking: [], parent: null, children: [] } });
   shadows().find(root => root.host.getAttribute('data-dependency-relationships') === 'item')!.querySelector<HTMLButtonElement>('button')!.click();
   await settle();
   expect(document.querySelector('[data-dependency-relationships="dialog"]')).not.toBeNull();
   const lookups = sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES').length;
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: false }, true);
   await settle();
   expect(document.querySelectorAll('[data-dependency-relationships]')).toHaveLength(0);
   window.dispatchEvent(new Event('scroll')); await settle();
   expect(document.querySelectorAll('[data-dependency-relationships]')).toHaveLength(0);
   expect(document.getElementById(OVERLAY_ID)).toBe(overlay);
   expect(controller.status).toMatchObject({ state: 'ready', edges: 1 });
   expect(analysis.querySelector('.relations button')!.getAttribute('aria-pressed')).toBe('true');
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: true }, true); await settle();
   expect(document.querySelectorAll('[data-dependency-relationships="item"]')).toHaveLength(3);
   expect(document.querySelectorAll('[data-dependency-relationships="toolbar"]')).toHaveLength(1);
   expect(document.querySelector('[data-dependency-relationships="dialog"]')).toBeNull();
   expect(analysis.querySelector('.relations button')!.getAttribute('aria-pressed')).toBe('true');
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES')).toHaveLength(lookups);
 });
 it('keeps a pending dependency lookup when relationship controls are hidden', async () => {
   let complete: ((value: unknown) => void) | undefined;
   sendMessage.mockImplementation((message: { type: string }) => message.type === 'GET_STATE'
     ? Promise.resolve({ ok: true, data: { enabled: true, authenticated: true, relationshipsVisible: true } })
     : new Promise(resolve => { complete = resolve; }));
   await settle();
   expect(controller.status.state).toBe('loading');
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: false }, true); await settle();
   const issues = sendMessage.mock.calls.find(call => call[0].type === 'DEPENDENCIES')![0].issues as IssueIdentity[];
   complete!({ ok: true, data: issues.map(issue => ({ issue, ok: true, dependencies: [] })) });
   await settle();
   expect(controller.status).toMatchObject({ state: 'ready', cards: 3 });
   expect(document.querySelectorAll('[data-dependency-relationships]')).toHaveLength(0);
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES')).toHaveLength(1);
 });
 it('refreshes dependency results when a regular settings update also changes relationship visibility', async () => {
   await settle();
   const lookups = sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES').length;
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: false }); await settle();
   expect(controller.status).toMatchObject({ state: 'ready', edges: 1 });
   expect(document.querySelectorAll('[data-dependency-relationships]')).toHaveLength(0);
   expect(sendMessage.mock.calls.filter(call => call[0].type === 'DEPENDENCIES')).toHaveLength(lookups + 1);
 });
 it('releases resources on view switches and SPA navigation', async () => {
   await settle(); const root = document.querySelector('#board')!;
   root.setAttribute('data-testid', 'table'); await settle(); expect(controller.status.state).toBe('no-view'); expect(document.getElementById(OVERLAY_ID)).toBeNull();
   root.setAttribute('data-testid', 'board-view'); await settle(); expect(controller.status.state).toBe('ready');
   history.pushState({}, '', '/acme/app'); window.dispatchEvent(new PopStateEvent('popstate')); await settle(); expect(document.getElementById(OVERLAY_ID)).toBeNull();
   history.pushState({}, '', '/orgs/acme/projects/1'); window.dispatchEvent(new PopStateEvent('popstate')); await settle(); expect(controller.status.state).toBe('ready');
   controller.destroy(); expect(document.getElementById(OVERLAY_ID)).toBeNull();
   const count = sendMessage.mock.calls.length;
   window.dispatchEvent(new Event('scroll')); document.querySelector('article')!.remove(); await settle(); expect(sendMessage).toHaveBeenCalledTimes(count);
 });
 it('distinguishes errors from empty results and recovers after refresh', async () => {
   fail = true; await settle(); expect(controller.status).toMatchObject({ state: 'error', failed: 3, edges: 0 });
   fail = false; controller.configure({ enabled: true, authenticated: true, relationshipsVisible: true }); await settle(); expect(controller.status).toMatchObject({ state: 'ready', failed: 0, edges: 1 });
 });
 it('handles 100 visible issues with one batched lookup and no refetch during scroll', async () => {
   const root = document.querySelector('#board')!;
   root.replaceChildren();
   for (let n = 1; n <= 100; n++) {
     const card = document.createElement('article'); card.dataset.testid = 'board-card';
     const link = document.createElement('a'); link.href = `/acme/app/issues/${n}`; card.append(link);
     card.getBoundingClientRect = () => new DOMRect((n % 10) * 90, Math.floor((n - 1) / 10) * 50, 80, 40);
     root.append(card);
   }
   await settle(); expect(controller.status).toMatchObject({ state: 'ready', cards: 100 });
   const calls = sendMessage.mock.calls.filter(c => c[0].type === 'DEPENDENCIES');
   expect(calls).toHaveLength(1); expect(calls[0]![0].issues).toHaveLength(100);
   for (let n = 0; n < 100; n++) window.dispatchEvent(new Event('scroll'));
   await settle(); expect(sendMessage.mock.calls.filter(c => c[0].type === 'DEPENDENCIES')).toHaveLength(1);
 });
 it('shows partial failures without hiding successful edges', async () => {
   await settle();
   sendMessage.mockImplementation(async (message: { issues: IssueIdentity[] }) => ({ ok: true, data: message.issues.map(issue => issue.number === 3 ? { issue, ok: false, error: { code: 'NOT_FOUND' } } : { issue, ok: true, dependencies: issue.repo === 'api' ? [{ blocker: { owner: 'acme', repo: 'app', number: 1 }, blocked: issue }] : [] }) }));
   controller.configure({ enabled: true, authenticated: true, relationshipsVisible: true }); await settle(); expect(controller.status).toMatchObject({ state: 'partial', failed: 1, edges: 1 });
 });
});
