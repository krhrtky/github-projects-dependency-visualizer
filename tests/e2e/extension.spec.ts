import { chromium, test, expect, type BrowserContext, type Page, type Worker, type CDPSession } from '@playwright/test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
let context: BrowserContext;
let worker: Worker;
let popup: Page;
let page: Page;
let profile: string;
const fixtureToken = 'github_pat_' + 'x'.repeat(50);
interface DomNode { nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }
async function paths(cdp: CDPSession): Promise<string[]> {
 const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
 const walk = (node: DomNode): string[] => {
   const attrs = node.attributes ?? [];
   const current = node.nodeName === 'path' && attrs.includes('marker-end') ? [attrs[attrs.indexOf('d') + 1]!] : [];
   return [...current, ...(node.children ?? []).flatMap(walk), ...(node.shadowRoots ?? []).flatMap(walk)];
 };
 return walk(root as DomNode);
}
test.beforeAll(async () => {
 profile = await mkdtemp(join(tmpdir(), 'dependency-visualizer-'));
 const extension = resolve('dist');
 context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
 worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
 await worker.evaluate(() => {
   const scope = globalThis as typeof globalThis & { fixtureCalls: number; fixtureMode: string; nativeFixtureFetch: typeof fetch };
   scope.fixtureCalls = 0; scope.fixtureMode = 'ok'; scope.nativeFixtureFetch = fetch;
   scope.fetch = async (input, init) => {
     scope.fixtureCalls++;
     const url = new URL(String(input));
     if (url.origin !== 'https://api.github.com' || init?.method !== 'GET') throw new Error('unexpected network operation');
     if (scope.fixtureMode === 'forbidden') return new Response('{}', { status: 403 });
     const dependencies = url.pathname.includes('/api/') ? [{ number: 1, html_url: 'https://github.com/acme/app/issues/1' }] : [];
     return new Response(JSON.stringify(dependencies), { status: 200 });
   };
 });
 const fixture = await readFile('tests/fixtures/board.html', 'utf8');
 await context.route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
 page = await context.newPage(); await page.goto('https://github.com/orgs/acme/projects/1/views/1');
 popup = await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
 const sleepingPage = await context.newPage();
 await sleepingPage.goto('https://github.com/orgs/acme/projects/1/views/2');
 const sleepingCdp = await context.newCDPSession(sleepingPage);
 await popup.bringToFront();
 await sleepingCdp.send('Page.setWebLifecycleState', { state: 'frozen' });
});
test.afterAll(async () => { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });
test('loads MV3, keeps PAT trusted, follows board geometry, recovers and logs out', async () => {
 const overlay = page.locator('#github-dependency-visualizer-overlay');
 await expect(overlay).toHaveCount(0); await expect(popup.locator('#enabled')).toBeDisabled();
 await popup.locator('#token').fill(fixtureToken); await popup.getByRole('button', { name: 'PAT を設定' }).click();
 await popup.locator('#enabled').check(); await expect(overlay).toHaveCount(1);
 const cdp = await context.newCDPSession(page);
 await expect.poll(() => paths(cdp)).toHaveLength(1);
 const initial = await paths(cdp);
 await page.locator('section').nth(1).locator('article').evaluate(e => { e.style.marginTop = '80px'; });
 await expect.poll(() => paths(cdp)).not.toEqual(initial);
 const moved = await paths(cdp);
 await page.locator('#board').evaluate(e => { e.scrollLeft = 70; });
 await expect.poll(() => paths(cdp)).not.toEqual(moved);
 expect(await worker.evaluate(() => (globalThis as typeof globalThis & { fixtureCalls: number }).fixtureCalls)).toBe(3);
 const local = await worker.evaluate(() => chrome.storage.local.get(null)); expect(local).toEqual({ enabled: true });
 expect(await page.content()).not.toContain(fixtureToken);
 const contexts: { id: number; origin: string; name: string }[] = [];
 cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
 await cdp.send('Runtime.enable');
 const extensionContext = contexts.find(c => c.origin === new URL(worker.url()).origin || c.name === 'GitHub Projects Dependency Visualizer');
 expect(extensionContext).toBeDefined();
 const probe = await cdp.send('Runtime.evaluate', { contextId: extensionContext!.id, expression: 'typeof chrome.storage.session === "undefined" ? "unavailable" : chrome.storage.session.get("token").then(x => JSON.stringify(x)).catch(() => "denied")', awaitPromise: true, returnByValue: true });
 expect(['unavailable', 'denied', '{}']).toContain(probe.result.value);
 const hit = await page.locator('section').nth(1).locator('a').evaluate(e => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + 5, r.y + 5) === e; });
 expect(hit).toBe(true);
 await worker.evaluate(() => { (globalThis as typeof globalThis & { fixtureMode: string }).fixtureMode = 'forbidden'; });
 await popup.getByRole('button', { name: 'Refresh', exact: true }).click();
 await expect.poll(async () => { await page.bringToFront(); return popup.locator('#errors').innerText(); }).toContain('アクセスできません');
 await worker.evaluate(() => { (globalThis as typeof globalThis & { fixtureMode: string }).fixtureMode = 'ok'; });
 await popup.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect.poll(() => paths(cdp)).toHaveLength(1);
 await page.screenshot({ path: 'docs/fixture-board.png' });
 await page.bringToFront(); await expect.poll(() => popup.locator('#board').innerText()).toContain('取得完了');
 await popup.locator('main').screenshot({ path: 'docs/fixture-popup.png' });
 await page.locator('#board').evaluate(e => { e.setAttribute('data-testid', 'table-view'); }); await expect(overlay).toHaveCount(0);
 await page.locator('#board').evaluate(e => { e.setAttribute('data-testid', 'board-view'); }); await expect(overlay).toHaveCount(1);
 await popup.locator('#enabled').uncheck(); await expect(overlay).toHaveCount(0);
 await popup.locator('#enabled').check(); await page.reload(); await expect(overlay).toHaveCount(1);
 await popup.getByRole('button', { name: 'Logout', exact: true }).click(); await expect(overlay).toHaveCount(0);
 expect(await worker.evaluate(() => chrome.storage.session.get('token'))).toEqual({});
 await cdp.detach();
});

test('supports observed GitHub DnD markup, virtualization and shared Table root IDs', async () => {
 const fixture = await readFile('tests/fixtures/github-board-observed.html', 'utf8');
 await context.unroute('https://github.com/**');
 await context.route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
 await page.reload();
 await popup.locator('#token').fill(fixtureToken); await popup.getByRole('button', { name: 'PAT を設定' }).click();
 await popup.locator('#enabled').check();
 const overlay = page.locator('#github-dependency-visualizer-overlay'); await expect(overlay).toHaveCount(1);
 const cdp = await context.newCDPSession(page);
 await expect.poll(() => paths(cdp)).toHaveLength(1);
 const initial = await paths(cdp);
 await page.locator('#project-items-region').evaluate(e => { e.scrollLeft = 60; });
 await expect.poll(() => paths(cdp)).not.toEqual(initial);
 await page.locator('[data-board-column="Doing"] [data-board-card-id]').evaluate(e => { e.remove(); });
 await expect.poll(() => paths(cdp)).toHaveLength(0);
 await page.locator('[data-board-column="Doing"] .column-drop-zone').evaluate(e => {
   const card = document.createElement('div'); card.dataset.boardCardId = '107'; card.setAttribute('role', 'button'); card.setAttribute('aria-roledescription', 'draggable');
   const anchor = document.createElement('a'); anchor.href = 'https://github.com/acme/api/issues/1'; anchor.setAttribute('role', 'button'); anchor.textContent = 'Restored synthetic issue'; card.append(anchor); e.append(card);
 });
 await expect.poll(() => paths(cdp)).toHaveLength(1);
 await page.locator('#project-items-region').evaluate(e => { e.removeAttribute('data-dnd-drop-id'); e.removeAttribute('data-dnd-drop-type'); e.setAttribute('role', 'grid'); });
 await expect(overlay).toHaveCount(0);
 await page.locator('#project-items-region').evaluate(e => { e.removeAttribute('role'); e.setAttribute('data-dnd-drop-id', 'board'); e.setAttribute('data-dnd-drop-type', 'column'); });
 await expect(overlay).toHaveCount(1); await expect.poll(() => paths(cdp)).toHaveLength(1);
 await popup.getByRole('button', { name: 'Logout', exact: true }).click(); await expect(overlay).toHaveCount(0); await cdp.detach();
});

test('accepts a classic PAT and recovers from required SSO authorization on Refresh', async () => {
 const classicToken = 'ghp_' + 'c'.repeat(36);
 const ssoMessage = 'SSO 承認が必要です。GitHub の Tokens (classic) → Configure SSO → 対象組織の Authorize を実行し、Refresh してください。';
 await worker.evaluate(() => {
   const scope = globalThis as typeof globalThis & { classicFixtureMode: string; classicFixtureAuthorizations: (string | null)[] };
   scope.classicFixtureMode = 'sso-required'; scope.classicFixtureAuthorizations = [];
   scope.fetch = async (input, init) => {
     const url = new URL(String(input));
     if (url.origin !== 'https://api.github.com' || init?.method !== 'GET') throw new Error('unexpected network operation');
     scope.classicFixtureAuthorizations.push(new Headers(init.headers).get('Authorization'));
     if (scope.classicFixtureMode === 'sso-required') return new Response('{}', { status: 403, headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso?authorization_request=fixture' } });
     const dependencies = url.pathname.includes('/api/') ? [{ number: 1, html_url: 'https://github.com/acme/app/issues/1' }] : [];
     return new Response(JSON.stringify(dependencies), { status: 200 });
   };
 });
 await expect(popup.locator('#enabled')).toBeDisabled();
 await popup.locator('#token').fill(classicToken); await popup.getByRole('button', { name: 'PAT を設定' }).click();
 await expect(popup.locator('#auth')).toContainText('PAT 設定済み');
 expect(await worker.evaluate(() => chrome.storage.session.get('token'))).toEqual({ token: classicToken });
 await popup.locator('#enabled').check();
 await expect.poll(async () => { await page.bringToFront(); return popup.locator('#errors').innerText(); }).toBe(ssoMessage);
 const failedRequests = await worker.evaluate(() => (globalThis as typeof globalThis & { classicFixtureAuthorizations: (string | null)[] }).classicFixtureAuthorizations);
 expect(failedRequests.length).toBeGreaterThan(0);
 expect(failedRequests.every(value => value === `Bearer ${classicToken}`)).toBe(true);
 const cdp = await context.newCDPSession(page);
 await expect.poll(() => paths(cdp)).toHaveLength(0);
 await worker.evaluate(() => { (globalThis as typeof globalThis & { classicFixtureMode: string }).classicFixtureMode = 'ok'; });
 await popup.getByRole('button', { name: 'Refresh', exact: true }).click();
 await expect.poll(() => paths(cdp)).toHaveLength(1);
 await expect.poll(async () => { await page.bringToFront(); return popup.locator('#board').innerText(); }).toContain('取得完了');
 await expect(popup.locator('#errors')).toBeEmpty();
 const recoveredRequests = await worker.evaluate(() => (globalThis as typeof globalThis & { classicFixtureAuthorizations: (string | null)[] }).classicFixtureAuthorizations);
 expect(recoveredRequests.length).toBeGreaterThan(failedRequests.length);
 expect(recoveredRequests.every(value => value === `Bearer ${classicToken}`)).toBe(true);
 expect(await worker.evaluate(() => chrome.storage.session.get('token'))).toEqual({ token: classicToken });
 await popup.getByRole('button', { name: 'Logout', exact: true }).click();
 await expect(page.locator('#github-dependency-visualizer-overlay')).toHaveCount(0); await cdp.detach();
});

test('uses browser native Fetch through the client without Illegal invocation', async () => {
 await worker.evaluate(() => {
   const scope = globalThis as typeof globalThis & { nativeFixtureFetch: typeof fetch; nativeFixtureCalls: number };
   scope.nativeFixtureCalls = 0;
   scope.fetch = new Proxy(scope.nativeFixtureFetch, {
     apply(target, receiver, args: Parameters<typeof fetch>) {
       const aborted = new AbortController(); aborted.abort();
       const pending = Reflect.apply(target, receiver, [args[0], { ...args[1], signal: aborted.signal }]) as Promise<Response>;
       return pending.catch((error: unknown) => {
         if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
         scope.nativeFixtureCalls++;
         const dependencies = new URL(String(args[0])).pathname.includes('/api/') ? [{ number: 1, html_url: 'https://github.com/acme/app/issues/1' }] : [];
         return new Response(JSON.stringify(dependencies), { status: 200 });
       });
     }
   });
 });
 await popup.locator('#token').fill(fixtureToken); await popup.getByRole('button', { name: 'PAT を設定' }).click();
 await popup.locator('#enabled').check();
 const cdp = await context.newCDPSession(page);
 await expect.poll(() => paths(cdp)).toHaveLength(1);
 expect(await worker.evaluate(() => (globalThis as typeof globalThis & { nativeFixtureCalls: number }).nativeFixtureCalls)).toBeGreaterThan(0);
 await popup.getByRole('button', { name: 'Logout', exact: true }).click();
 await expect(page.locator('#github-dependency-visualizer-overlay')).toHaveCount(0); await cdp.detach();
});
