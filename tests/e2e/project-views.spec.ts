import { chromium, test, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface DomNode { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }
interface OverlayState {
  metrics: string[];
  view: string;
  edges: { key: string; path: string; opacity: string }[];
  edgeLabels: string[];
  edgeDepths: string[];
  labelsOverlap: boolean;
  labelsOverlapItems: boolean;
  note: string;
}
interface Status { state: string; view?: string; cards: number; edges: number; analysis?: { maxDepth: number | null } }
let context: BrowserContext;
let worker: Worker;
let page: Page;
let popup: Page;
let cdp: CDPSession;
let profile: string;
const edgeKey = (from: number, to: number): string => `acme/app#${from}->acme/app#${to}`;

async function shadowCall<T>(functionDeclaration: string, values: unknown[] = []): Promise<T> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const pending = [root as DomNode];
  const overlay = (() => {
    for (let index = 0; index < pending.length; index += 1) {
      const node = pending[index]!; const attributes = node.attributes ?? [];
      const id = attributes.indexOf('id');
      if (id !== -1 && attributes[id + 1] === 'github-dependency-visualizer-overlay') return node;
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    }
    throw new Error('Dependency overlay is not mounted');
  })();
  const shadow = overlay.shadowRoots?.[0];
  if (!shadow) throw new Error('Dependency overlay has no shadow root');
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
  if (!object.objectId) throw new Error('Could not resolve dependency shadow root');
  try {
    const response = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: values.map(value => ({ value })), returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value as T;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
  }
}
async function overlayState(): Promise<OverlayState> {
  return shadowCall<OverlayState>(function (this: ShadowRoot) {
    const labels = [...this.querySelectorAll('g[data-dependency-label]')].map(element => element.getBoundingClientRect());
    const items = [...this.ownerDocument.querySelectorAll<HTMLElement>(':is([data-item-id="1"],[data-item-id="2"],[data-item-id="3"],[data-item-id="4"]) :is([role="rowheader"],.roadmap-pill)')]
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const overlaps = (first: DOMRect, second: DOMRect): boolean => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    return {
      metrics: [...this.querySelectorAll('.metric strong')].map(element => element.textContent ?? ''),
      view: this.querySelector('.eyebrow')?.textContent ?? '',
      edges: [...this.querySelectorAll('g[data-edge-key]')].map(group => ({ key: group.getAttribute('data-edge-key')!, path: group.querySelector('path')!.getAttribute('d')!, opacity: group.getAttribute('opacity')! })),
      edgeLabels: [...this.querySelectorAll('text[data-dependency-pair]')].map(element => element.textContent ?? ''),
      edgeDepths: [...this.querySelectorAll('text[data-dependency-depth]')].map(element => element.textContent ?? ''),
      labelsOverlap: labels.some((label, index) => labels.slice(index + 1).some(other => overlaps(label, other))),
      labelsOverlapItems: labels.some(label => items.some(item => overlaps(label, item))),
      note: [...this.querySelectorAll('.note')].map(element => element.textContent ?? '').join(' '),
    };
  }.toString());
}
async function pageStatus(): Promise<Status> {
  return popup.evaluate(async url => {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs.find(candidate => candidate.url === url)!;
    return chrome.tabs.sendMessage(tab.id!, { type: 'PAGE_STATUS' });
  }, page.url()) as Promise<Status>;
}
async function clickFilter(index: number): Promise<void> {
  await shadowCall(function (this: ShadowRoot, index: number) {
    this.querySelectorAll<HTMLButtonElement>('.filters button')[index]!.click();
  }.toString(), [index]);
}
async function switchView(name: 'table' | 'roadmap' | 'complex-board'): Promise<void> {
  const fixture = await readFile(`tests/fixtures/${name}.html`, 'utf8');
  await page.evaluate(html => {
    const source = new DOMParser().parseFromString(html, 'text/html');
    const root = document.querySelector<HTMLElement>('#project-items-region, #board')!;
    const next = source.querySelector<HTMLElement>('#project-items-region, #board')!;
    for (const attribute of [...root.attributes]) root.removeAttribute(attribute.name);
    for (const attribute of next.attributes) root.setAttribute(attribute.name, attribute.value);
    root.innerHTML = next.innerHTML;
    for (const style of document.head.querySelectorAll('style')) style.remove();
    for (const style of source.head.querySelectorAll('style')) document.head.append(style.cloneNode(true));
    document.querySelector('header')!.innerHTML = source.querySelector('header')!.innerHTML;
    root.scrollLeft = 0; root.scrollTop = 0;
  }, fixture);
}
async function expectReady(view: string, cards: number, edges: number): Promise<void> {
  await expect.poll(pageStatus).toMatchObject({ state: 'ready', view, cards, edges });
  await expect(page.locator('#github-dependency-visualizer-overlay')).toHaveCount(1);
}

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'dependency-project-views-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1024 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { projectViewRequests: number[] };
    scope.projectViewRequests = [];
    scope.fetch = async (input, init) => {
      const url = new URL(String(input));
      const match = /^\/repos\/acme\/app\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(url.pathname);
      if (url.origin !== 'https://api.github.com' || init?.method !== 'GET' || !match) throw new Error('Unexpected network operation');
      const number = Number(match[1]); scope.projectViewRequests.push(number);
      const parents: Record<number, number[]> = { 1: [], 2: [1], 3: [1, 2], 4: [3], 5: [] };
      return new Response(JSON.stringify((parents[number] ?? []).map(blocker => ({ number: blocker, html_url: `https://github.com/acme/app/issues/${blocker}` }))), { status: 200 });
    };
  });
  const fixture = await readFile('tests/fixtures/table.html', 'utf8');
  await context.route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  page = await context.newPage(); await page.goto('https://github.com/orgs/acme/projects/1/views/2');
  popup = await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
  await popup.locator('#token').fill('github_pat_' + 'x'.repeat(50));
  await popup.getByRole('button', { name: 'PAT を設定' }).click();
  await popup.locator('#enabled').check();
  cdp = await context.newCDPSession(page);
  await expectReady('table', 4, 4);
});
test.afterAll(async () => {
  await cdp?.detach(); await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('shows Table dependencies using titles, survives scrolling and tracks virtualized rows', async () => {
  const initial = await overlayState();
  expect(initial.metrics).toEqual(['3', '1', '1']);
  expect(initial.view).toContain('Table');
  expect(initial.edgeLabels).toEqual(['#1 → #2', '#1 → #3', '#2 → #3', '#3 → #4']);
  expect(initial.edgeDepths).toEqual(['深さ 0 → 1', '深さ 0 → 2', '深さ 1 → 2', '深さ 2 → 3']);
  expect(initial.labelsOverlap).toBe(false);
  expect(initial.labelsOverlapItems).toBe(false);
  expect(await worker.evaluate(() => (globalThis as typeof globalThis & { projectViewRequests: number[] }).projectViewRequests.slice().sort())).toEqual([1, 2, 3, 4]);
  await clickFilter(1);
  expect((await overlayState()).edges.map(edge => edge.key)).toEqual([edgeKey(1, 2), edgeKey(2, 3), edgeKey(3, 4)]);
  await clickFilter(0);
  const anchor = page.locator('[data-item-id="1"] [role="rowheader"] a');
  expect(await anchor.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + 2, rect.y + 2) === element; })).toBe(true);
  await page.bringToFront(); await page.screenshot({ path: 'docs/table-view.png' });

  await page.locator('#project-items-region').evaluate(element => { element.scrollLeft = 60; element.scrollTop = 25; });
  await expect.poll(async () => (await overlayState()).edges.map(edge => edge.path)).not.toEqual(initial.edges.map(edge => edge.path));
  await expectReady('table', 4, 4);
  expect(await worker.evaluate(() => (globalThis as typeof globalThis & { projectViewRequests: number[] }).projectViewRequests.length)).toBe(4);
  await page.locator('#project-items-region').evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });

  await page.locator('[data-item-id="4"]').evaluate(element => {
    const scope = window as typeof window & { virtualizedRow?: Element; virtualizedNext?: ChildNode | null };
    scope.virtualizedRow = element; scope.virtualizedNext = element.nextSibling; element.remove();
  });
  await expectReady('table', 3, 3);
  expect((await overlayState()).metrics[0]).toBe('2');
  await page.locator('#project-items-region').evaluate(root => {
    const scope = window as typeof window & { virtualizedRow?: Element; virtualizedNext?: ChildNode | null };
    root.insertBefore(scope.virtualizedRow!, scope.virtualizedNext ?? null);
  });
  await expectReady('table', 4, 4);
  expect((await overlayState()).metrics[0]).toBe('3');
});

test('switches the same root to Roadmap and connects visible bars with title fallbacks', async () => {
  await page.locator('#project-items-region').evaluate(root => { (window as typeof window & { originalViewRoot?: Element }).originalViewRoot = root; });
  await switchView('roadmap');
  await expectReady('roadmap', 4, 4);
  expect(await page.locator('#project-items-region').evaluate(root => root === (window as typeof window & { originalViewRoot?: Element }).originalViewRoot)).toBe(true);
  const initial = await overlayState();
  expect(initial.view).toContain('Roadmap');
  expect(initial.metrics).toEqual(['3', '1', '1']);
  expect(initial.edgeLabels).toEqual(['#1 → #2', '#1 → #3', '#2 → #3', '#3 → #4']);
  expect(initial.edgeDepths).toEqual(['深さ 0 → 1', '深さ 0 → 2', '深さ 1 → 2', '深さ 2 → 3']);
  expect(initial.labelsOverlap).toBe(false);
  expect(initial.labelsOverlapItems).toBe(false);
  const bar = await page.locator('[data-item-id="1"] a.roadmap-pill').boundingBox();
  const fromBar = initial.edges.find(edge => edge.key === edgeKey(1, 2))!.path.match(/^M ([-\d.]+) ([-\d.]+)/)!;
  expect(Math.min(Math.abs(Number(fromBar[1]) - bar!.x), Math.abs(Number(fromBar[1]) - bar!.x - bar!.width))).toBeLessThan(1);
  await page.bringToFront(); await page.screenshot({ path: 'docs/roadmap-view.png' });

  await page.locator('[data-item-id="1"] a.roadmap-pill').evaluate(element => { (element as HTMLElement).style.left = '85px'; });
  await expect.poll(async () => (await overlayState()).edges.map(edge => edge.path)).not.toEqual(initial.edges.map(edge => edge.path));
  const moved = await overlayState();
  await page.locator('#project-items-region').evaluate(element => { element.scrollLeft = 180; element.scrollTop = 25; });
  await expect.poll(async () => (await overlayState()).edges.map(edge => edge.path)).not.toEqual(moved.edges.map(edge => edge.path));
  await expectReady('roadmap', 4, 4);
  const stickyTitle = await page.locator('[data-item-id="1"] [role="rowheader"]').boundingBox();
  const partialBar = (await overlayState()).edges.find(edge => edge.key === edgeKey(1, 2))!.path.match(/^M ([-\d.]+) ([-\d.]+)/)!;
  expect(Number(partialBar[1])).toBeGreaterThanOrEqual(stickyTitle!.x + stickyTitle!.width - 0.5);
  await page.locator('#project-items-region').evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  await page.locator('[data-item-id="1"] a.roadmap-pill').evaluate(element => {
    (window as typeof window & { removedRoadmapBar?: Element }).removedRoadmapBar = element; element.remove();
  });
  await expect.poll(async () => (await overlayState()).edges.find(edge => edge.key === edgeKey(1, 2))?.path).not.toBe(moved.edges.find(edge => edge.key === edgeKey(1, 2))!.path);
  await expectReady('roadmap', 4, 4);
  const title = await page.locator('[data-item-id="1"] [role="rowheader"]').boundingBox();
  const fallback = (await overlayState()).edges.find(edge => edge.key === edgeKey(1, 2))!.path.match(/^M ([-\d.]+) ([-\d.]+)/)!;
  expect(Math.min(Math.abs(Number(fallback[1]) - title!.x), Math.abs(Number(fallback[1]) - title!.x - title!.width))).toBeLessThan(1);
  await page.locator('[data-item-id="1"] [role="gridcell"]').evaluate(cell => { cell.append((window as typeof window & { removedRoadmapBar?: Element }).removedRoadmapBar!); });
  await clickFilter(1);
  expect((await overlayState()).edges).toHaveLength(3);
  await clickFilter(0);
  await page.locator('#project-items-region').evaluate(element => { element.scrollTop = 110; });
  await expectReady('roadmap', 3, 2);
  expect((await overlayState()).metrics[0]).toBe('2');
  await page.locator('#project-items-region').evaluate(element => { element.scrollTop = 0; });
  await expectReady('roadmap', 4, 4);
});

test('returns to Board and follows Project and non-Project SPA navigation', async () => {
  await switchView('complex-board');
  await expectReady('board', 5, 4);
  expect((await overlayState()).view).toContain('Board');
  expect((await overlayState()).metrics[0]).toBe('3');
  await page.evaluate(() => { history.pushState({}, '', '/orgs/acme/projects/2/views/1'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expectReady('board', 5, 4);
  await page.evaluate(() => { history.pushState({}, '', '/acme/app'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.locator('#github-dependency-visualizer-overlay')).toHaveCount(0);
  await page.evaluate(() => { history.pushState({}, '', '/orgs/acme/projects/2/views/1'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expectReady('board', 5, 4);
});
