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
  edgeLabels: string[];
  edgeDepths: string[];
  labelsOverlap: boolean;
  labelsOverlapCards: boolean;
  relations: string[];
  relationIdentities: string[];
  relationDepths: string[];
  relationAriaLabels: (string | null)[];
  relationsOpen: boolean;
  analysisDetailsOpen: boolean;
  guide: string;
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
    const labels = [...this.querySelectorAll('g[data-dependency-label]')].map(element => element.getBoundingClientRect());
    const cards = [...this.ownerDocument.querySelectorAll('article[data-testid="board-card"]')].map(element => element.getBoundingClientRect());
    const overlaps = (first: DOMRect, second: DOMRect): boolean => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    return {
      metrics: [...this.querySelectorAll('.metric strong')].map(element => element.textContent ?? ''),
      counts: this.querySelector('.body > .note')?.textContent ?? '',
      note: this.querySelector('.note.warning')?.textContent ?? '',
      selected: this.querySelector('.selected')?.textContent ?? '',
      criticalDisabled: critical.disabled,
      edges: [...this.querySelectorAll<SVGGElement>('g[data-edge-key]')].map(group => {
        const path = group.querySelector('path')!;
        return { key: group.getAttribute('data-edge-key')!, path: path.getAttribute('d')!, opacity: group.getAttribute('opacity')!, width: path.getAttribute('stroke-width')!, critical: group.getAttribute('data-critical') === 'true', cyclic: group.getAttribute('data-cycle') === 'true', dash: path.getAttribute('stroke-dasharray') };
      }),
      edgeLabels: [...this.querySelectorAll('text[data-dependency-pair]')].map(element => element.textContent ?? ''),
      edgeDepths: [...this.querySelectorAll('text[data-dependency-depth]')].map(element => element.textContent ?? ''),
      labelsOverlap: labels.some((label, index) => labels.slice(index + 1).some(other => overlaps(label, other))),
      labelsOverlapCards: labels.some(label => cards.some(card => overlaps(label, card))),
      relations: [...this.querySelectorAll('.dependency-sentence')].map(element => element.textContent ?? ''),
      relationIdentities: [...this.querySelectorAll('.dependency-identities')].map(element => element.textContent ?? ''),
      relationDepths: [...this.querySelectorAll('.dependency-depth')].map(element => element.textContent ?? ''),
      relationAriaLabels: [...this.querySelectorAll('.relations button')].map(element => element.getAttribute('aria-label')),
      relationsOpen: this.querySelector<HTMLDetailsElement>('.relations')!.open,
      analysisDetailsOpen: this.querySelector<HTMLDetailsElement>('.analysis-details')!.open,
      guide: this.querySelector('.reading-guide')!.textContent ?? '',
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
async function panelLayout(): Promise<{ insideViewport: boolean; horizontalOverflow: boolean; textOverflow: boolean }> {
  return shadowCall(function (this: ShadowRoot) {
    const panel = this.querySelector<HTMLElement>('.panel')!;
    const rect = panel.getBoundingClientRect();
    return {
      insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      horizontalOverflow: panel.scrollWidth > panel.clientWidth,
      textOverflow: [...this.querySelectorAll<HTMLElement>('.dependency-sentence,.dependency-identities,.selected')].some(element => element.scrollWidth > element.clientWidth),
    };
  }.toString());
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

test('separates same-column lines and explains dependency direction while supporting line and card focus', async () => {
  await page.bringToFront();
  await expect.poll(async () => (await state()).edges.length).toBe(5);
  expect(await page.locator('#github-dependency-visualizer-overlay').evaluate(element => element.shadowRoot)).toBeNull();
  const initial = await state();
  expect(initial.metrics).toEqual(['3', '1', '1']);
  expect(initial.counts).toBe('5 カード / 5 本の依存線');
  expect(initial.relationsOpen).toBe(true);
  expect(initial.analysisDetailsOpen).toBe(false);
  expect(initial.guide).toContain('矢印の先の Issue が、手前の Issue に依存します。');
  expect(initial.guide).toContain('A → B は「B が A に依存」');
  const sameColumn = initial.edges.filter(edge => edge.key !== key(1, 5));
  expect(new Set(sameColumn.map(edge => edge.path)).size).toBe(4);
  expect(sameColumn.every(edge => edge.path.includes(' L '))).toBe(true);
  expect(initial.edges.filter(edge => edge.critical).map(edge => edge.key)).toEqual([key(1, 2), key(2, 3), key(3, 4)]);
  expect(initial.edgeDepths).toEqual(['深さ 0 → 1', '深さ 0 → 2', '深さ 0 → 1', '深さ 1 → 2', '深さ 2 → 3']);
  expect(initial.relationDepths).toEqual(initial.edgeDepths);
  expect(initial.labelsOverlap).toBe(false);
  expect(initial.labelsOverlapCards).toBe(false);

  await click('.filters button:nth-child(2)');
  const critical = await state();
  expect(critical.edges.map(edge => edge.key)).toEqual([key(1, 2), key(2, 3), key(3, 4)]);
  expect(critical.edgeLabels).toEqual(['#1 → #2', '#2 → #3', '#3 → #4']);
  expect(critical.edgeDepths).toEqual(['深さ 0 → 1', '深さ 1 → 2', '深さ 2 → 3']);
  expect(critical.relations[3]).toBe('#3 は #2 に依存');
  expect(critical.relations[4]).toBe('#4 は #3 に依存');
  expect(critical.relationIdentities[3]).toBe('acme/app#2 → acme/app#3');
  expect(critical.relationAriaLabels[3]).toBe('acme/app#3 は acme/app#2 に依存 · 深さ 1 → 2');
  await click('.filters button:first-child');
  await selectIssue('acme/app#3');
  const selected = await state();
  expect(selected.selected).toBe('依存の深さ 2 · 前提 2 件 / 後続 1 件 · 下流の影響先 1 件');
  expect(selected.edges.filter(edge => edge.opacity === '.12').map(edge => edge.key)).toEqual([key(1, 5)]);
  await selectIssue('');

  expect((await state()).relations[2]).toBe('#5 は #1 に依存');
  await click('.relations li:nth-child(3) button');
  const focused = await state();
  expect(focused.selected).toBe('#5 は #1 に依存 · 深さ 0 → 1');
  expect(focused.edges.filter(edge => edge.opacity === '1').map(edge => edge.key)).toEqual([key(1, 5)]);
  expect(focused.edges.find(edge => edge.key === key(1, 5))?.width).toBe('4');
  await shadowCall(function (this: ShadowRoot) { this.querySelector<HTMLButtonElement>('.clear-edge')!.focus(); }.toString());
  await page.keyboard.press('Enter');
  expect((await state()).edges.every(edge => edge.opacity === '1')).toBe(true);
  expect((await state()).selected).toBe('一覧で依存を選ぶと、該当する矢印を強調します。');
  expect(await shadowCall(function (this: ShadowRoot) { return (this.activeElement as HTMLButtonElement)?.dataset.edge; }.toString())).toBe(key(1, 5));

  expect((await state()).background).toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: 'docs/dependency-analysis-light.png' });
  await page.evaluate(() => { document.documentElement.dataset.colorMode = 'dark'; });
  await expect.poll(async () => (await state()).background).toBe('rgb(13, 17, 23)');
  expect((await state()).metrics).toEqual(['3', '1', '1']);
  await page.screenshot({ path: 'docs/dependency-analysis-dark.png' });

  await page.setViewportSize({ width: 720, height: 512 });
  try {
    await expect.poll(async () => (await state()).edges.length).toBeLessThan(initial.edges.length);
    expect((await state()).edges.length).toBeGreaterThan(0);
    expect(await panelLayout()).toEqual({ insideViewport: true, horizontalOverflow: false, textOverflow: false });
    await shadowCall(function (this: ShadowRoot) { this.querySelector<HTMLElement>('.relations summary')!.focus(); }.toString());
    await page.keyboard.press('Tab');
    expect(await shadowCall(function (this: ShadowRoot) { return this.activeElement?.matches('.relations button'); }.toString())).toBe(true);
    await page.keyboard.press('Enter');
    expect((await state()).selected).toMatch(/ に依存 · 深さ \d+ → \d+$/);
    await shadowCall(function (this: ShadowRoot) { this.querySelector<HTMLButtonElement>('.clear-edge')!.focus(); }.toString());
    await page.keyboard.press('Enter');

    const originalText = await shadowCall<string[]>(function (this: ShadowRoot) {
      const targets = [...this.querySelectorAll('.dependency-sentence,.dependency-identities,.selected')];
      const original = targets.map(element => element.textContent ?? '');
      const issue = `acme/${'dependency-visualization-'.repeat(4)}#12345`;
      for (const target of targets) target.textContent = target.matches('.dependency-identities') ? `${issue} → ${issue}` : `${issue} は ${issue} に依存`;
      return original;
    }.toString());
    try {
      expect(await panelLayout()).toEqual({ insideViewport: true, horizontalOverflow: false, textOverflow: false });
    } finally {
      await shadowCall(function (this: ShadowRoot, original: string[]) {
        [...this.querySelectorAll('.dependency-sentence,.dependency-identities,.selected')].forEach((element, index) => { element.textContent = original[index]!; });
      }.toString(), [originalText]);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 1024 });
  }
  await expect.poll(async () => (await state()).edges.length).toBe(5);
});

test('warns about cycles and leaves dependency depth uncomputed', async () => {
  await worker.evaluate(() => { (globalThis as typeof globalThis & { dependencyFixtureMode: string }).dependencyFixtureMode = 'cycle'; });
  await popup.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(async () => (await state()).edges.length).toBe(6);
  const cyclic = await state();
  expect(cyclic.metrics).toEqual(['—', '1', '1']);
  expect(cyclic.counts).toContain('循環 4 カード');
  expect(cyclic.note).toContain('循環を解消するまで依存の深さ・最長経路を算出できません。循環内の線は赤い破線です。');
  expect(cyclic.criticalDisabled).toBe(true);
  expect(cyclic.edges.every(edge => !edge.critical)).toBe(true);
  expect(cyclic.edges.filter(edge => edge.cyclic)).toHaveLength(5);
  expect(cyclic.edges.filter(edge => edge.cyclic).every(edge => edge.dash === '6 4')).toBe(true);
  expect(cyclic.edges.find(edge => edge.key === key(1, 5))?.cyclic).toBe(false);
  expect(cyclic.edgeDepths).toEqual(Array(6).fill('深さ 未算出'));
  expect(cyclic.relationDepths).toEqual(Array(6).fill('深さ 未算出'));
  await selectIssue('acme/app#3');
  expect((await state()).selected).toContain('依存の深さ 未算出');
});
