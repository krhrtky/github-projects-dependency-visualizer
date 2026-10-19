import { chromium, test, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface DomNode { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }
interface EdgeState { key: string; path: string; opacity: string; width: string; critical: boolean; cyclic: boolean; dash: string | null }
interface ShadowState {
  metrics: string[];
  counts: string;
  note: string;
  selected: string;
  criticalDisabled: boolean;
  edges: EdgeState[];
  relations: string[];
  background: string;
}
let context: BrowserContext;
let worker: Worker;
let popup: Page;
let page: Page;
let cdp: CDPSession;
let profile: string;
const key = (from: number, to: number): string => `acme/app#${from}->acme/app#${to}`;

async function shadowCall<T>(functionDeclaration: string, values: unknown[] = []): Promise<T> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const pending = [root as DomNode];
  const overlay = (() => {
    for (let index = 0; index < pending.length; index += 1) {
      const node = pending[index]!;
      const attributes = node.attributes ?? [];
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
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      arguments: values.map(value => ({ value })),
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value as T;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
  }
}
async function state(): Promise<ShadowState> {
  return shadowCall<ShadowState>(function (this: ShadowRoot) {
    const critical = this.querySelector<HTMLButtonElement>('.filters button:nth-child(2)')!;
    return {
      metrics: [...this.querySelectorAll('.metric strong')].map(element => element.textContent ?? ''),
      counts: this.querySelector('.body > .note')?.textContent ?? '',
      note: this.querySelector('.note.warning')?.textContent ?? '',
      selected: this.querySelector('label + .note')?.textContent ?? '',
      criticalDisabled: critical.disabled,
      edges: [...this.querySelectorAll<SVGGElement>('g[data-edge-key]')].map(group => {
        const path = group.querySelector('path')!;
        return { key: group.getAttribute('data-edge-key')!, path: path.getAttribute('d')!, opacity: group.getAttribute('opacity')!, width: path.getAttribute('stroke-width')!, critical: group.getAttribute('data-critical') === 'true', cyclic: group.getAttribute('data-cycle') === 'true', dash: path.getAttribute('stroke-dasharray') };
      }),
      relations: [...this.querySelectorAll('.relations button')].map(element => element.textContent ?? ''),
      background: getComputedStyle(this.querySelector('.panel')!).backgroundColor,
    };
  }.toString());
}
async function click(selector: string): Promise<void> {
  await shadowCall(function (this: ShadowRoot, selector: string) {
    const element = this.querySelector<HTMLButtonElement>(selector);
    if (!element) throw new Error(`Missing control: ${selector}`);
    element.click();
  }.toString(), [selector]);
}
async function selectIssue(value: string): Promise<void> {
  await shadowCall(function (this: ShadowRoot, value: string) {
    const select = this.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }.toString(), [value]);
}

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'dependency-analysis-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1024 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { dependencyFixtureMode: 'dag' | 'cycle' };
    scope.dependencyFixtureMode = 'dag';
    scope.fetch = async (input, init) => {
      const url = new URL(String(input));
      const match = /^\/repos\/acme\/app\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(url.pathname);
      if (url.origin !== 'https://api.github.com' || init?.method !== 'GET' || !match) throw new Error('Unexpected network operation');
      const parents: Record<string, number[]> = { 1: scope.dependencyFixtureMode === 'cycle' ? [4] : [], 2: [1], 3: [1, 2], 4: [3], 5: [1] };
      return new Response(JSON.stringify((parents[match[1]!] ?? []).map(number => ({ number, html_url: `https://github.com/acme/app/issues/${number}` }))), { status: 200 });
    };
  });
  const fixture = await readFile('tests/fixtures/complex-board.html', 'utf8');
  await context.route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  page = await context.newPage();
  await page.goto('https://github.com/orgs/acme/projects/1/views/1');
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
  await popup.locator('#token').fill('github_pat_' + 'x'.repeat(50));
  await popup.getByRole('button', { name: 'PAT を設定' }).click();
  await popup.locator('#enabled').check();
  await expect(page.locator('#github-dependency-visualizer-overlay')).toHaveCount(1);
  cdp = await context.newCDPSession(page);
  await expect.poll(async () => (await state()).edges.length).toBe(5);
});
test.afterAll(async () => {
  await cdp?.detach();
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('separates same-column lines and supports longest-path, card and numbered-relation focus', async () => {
  expect(await page.locator('#github-dependency-visualizer-overlay').evaluate(element => element.shadowRoot)).toBeNull();
  const initial = await state();
  expect(initial.metrics).toEqual(['3', '1', '1']);
  expect(initial.counts).toBe('5 カード / 5 関係');
  const sameColumn = initial.edges.filter(edge => edge.key !== key(1, 5));
  expect(new Set(sameColumn.map(edge => edge.path)).size).toBe(4);
  expect(sameColumn.every(edge => edge.path.includes(' L '))).toBe(true);
  expect(initial.edges.filter(edge => edge.critical).map(edge => edge.key)).toEqual([key(1, 2), key(2, 3), key(3, 4)]);

  await click('.filters button:nth-child(2)');
  expect((await state()).edges.map(edge => edge.key)).toEqual([key(1, 2), key(2, 3), key(3, 4)]);
  await click('.filters button:first-child');
  await selectIssue('acme/app#3');
  const selected = await state();
  expect(selected.selected).toBe('深さ 2 · 直接の入 2 / 出 1 · 下流の影響先 1 件');
  expect(selected.edges.filter(edge => edge.opacity === '.12').map(edge => edge.key)).toEqual([key(1, 5)]);
  await selectIssue('');

  await click('.relations summary');
  expect((await state()).relations[2]).toBe('03  acme/app#1 → acme/app#5');
  await click('.relations li:nth-child(3) button');
  const focused = await state();
  expect(focused.edges.filter(edge => edge.opacity === '1').map(edge => edge.key)).toEqual([key(1, 5)]);
  expect(focused.edges.find(edge => edge.key === key(1, 5))?.width).toBe('4');
  await click('.relations li:nth-child(3) button');
  expect((await state()).edges.every(edge => edge.opacity === '1')).toBe(true);

  await page.bringToFront();
  expect((await state()).background).toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: 'docs/dependency-analysis-light.png' });
  await page.evaluate(() => { document.documentElement.dataset.colorMode = 'dark'; });
  await expect.poll(async () => (await state()).background).toBe('rgb(13, 17, 23)');
  expect((await state()).metrics).toEqual(['3', '1', '1']);
  await page.screenshot({ path: 'docs/dependency-analysis-dark.png' });
});

test('warns about cycles and leaves dependency depth uncomputed', async () => {
  await worker.evaluate(() => { (globalThis as typeof globalThis & { dependencyFixtureMode: string }).dependencyFixtureMode = 'cycle'; });
  await popup.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(async () => (await state()).edges.length).toBe(6);
  const cyclic = await state();
  expect(cyclic.metrics).toEqual(['—', '1', '1']);
  expect(cyclic.counts).toContain('循環 4 カード');
  expect(cyclic.note).toContain('循環を解消するまで深さ・最長経路を算出できません');
  expect(cyclic.criticalDisabled).toBe(true);
  expect(cyclic.edges.every(edge => !edge.critical)).toBe(true);
  expect(cyclic.edges.filter(edge => edge.cyclic)).toHaveLength(5);
  expect(cyclic.edges.filter(edge => edge.cyclic).every(edge => edge.dash === '6 4')).toBe(true);
  expect(cyclic.edges.find(edge => edge.key === key(1, 5))?.cyclic).toBe(false);
  await selectIssue('acme/app#3');
  expect((await state()).selected).toContain('深さ 未算出');
});
