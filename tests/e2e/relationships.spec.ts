import { chromium, test, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface DomNode { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }
interface Field { id: string; name: string; dataType: string; options?: { id: string; name: string }[] }
interface RequestLog { method: string; path: string; body?: Record<string, unknown> }
interface GraphqlLog { operation: string; variables: Record<string, unknown>; mutation: boolean }
interface Backend {
  rest: RequestLog[]; graphql: GraphqlLog[]; blockers: Record<number, number[]>; parents: Record<number, number>;
  fields: Field[]; visible: string[]; values: Record<string, Record<string, string>>;
  denyRestWrites: boolean; failedItem: string | null;
}
interface FixtureScope { relationshipBackend: Backend }
let context: BrowserContext;
let worker: Worker;
let page: Page;
let popup: Page;
let cdp: CDPSession;
let profile: string;
const ownerAttribute = 'data-dependency-relationships';

async function shadowCall<T>(kind: 'item' | 'toolbar' | 'dialog' | 'overlay', functionDeclaration: string, values: unknown[] = []): Promise<T> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const pending = [root as DomNode];
  const host = (() => {
    for (let index = 0; index < pending.length; index++) {
      const node = pending[index]!; const attributes = node.attributes ?? [];
      const attribute = attributes.indexOf(kind === 'overlay' ? 'id' : ownerAttribute);
      if (attribute !== -1 && attributes[attribute + 1] === (kind === 'overlay' ? 'github-dependency-visualizer-overlay' : kind)) return node;
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    }
    throw new Error(`Missing ${kind} relationship control`);
  })();
  const shadow = host.shadowRoots?.[0];
  if (!shadow) throw new Error(`Missing ${kind} closed shadow root`);
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
  if (!object.objectId) throw new Error('Could not resolve relationship shadow root');
  try {
    const response = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: values.map(value => ({ value })), returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value as T;
  } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
}
async function click(kind: 'item' | 'toolbar' | 'dialog', text: string): Promise<void> {
  await shadowCall(kind, function(this: ShadowRoot, label: string) {
    const button = [...this.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.title === label);
    if (!button || button.disabled) throw new Error(`Unavailable button: ${label}`);
    button.click();
  }.toString(), [text]);
}
async function dialogStatus(): Promise<string> {
  return shadowCall('dialog', function(this: ShadowRoot) { return this.querySelector('[role="status"]')?.textContent ?? ''; }.toString());
}
async function dialogSections(): Promise<string[][]> {
  return shadowCall('dialog', function(this: ShadowRoot) {
    return [...this.querySelectorAll('section')].map(section => [...section.querySelectorAll('li a')].map(link => link.textContent ?? ''));
  }.toString());
}
async function openItem(): Promise<void> {
  await click('item', 'Relationships');
  await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(1);
  await expect.poll(async () => (await dialogSections()).length).toBe(4);
}
async function add(section: number, related: number): Promise<void> {
  await shadowCall('dialog', function(this: ShadowRoot, section: number, related: number) {
    const form = this.querySelectorAll('section')[section]!.querySelector('form')!;
    form.querySelector('input')!.value = `acme/app#${related}`;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }.toString(), [section, related]);
}
async function remove(section: number, related: number): Promise<void> {
  await shadowCall('dialog', function(this: ShadowRoot, section: number, related: number) {
    const list = this.querySelectorAll('section')[section]!;
    const item = [...list.querySelectorAll('li')].find(item => item.querySelector('a')?.textContent === `acme/app#${related}`);
    if (!item) throw new Error('Missing relationship to remove');
    item.querySelector<HTMLButtonElement>('button')!.click();
  }.toString(), [section, related]);
}
async function nativeSectionFilter(section: number): Promise<void> {
  await shadowCall('dialog', function(this: ShadowRoot, section: number) {
    this.querySelectorAll('section')[section]!.querySelector<HTMLButtonElement>('.filter')!.click();
  }.toString(), [section]);
}
async function backend(): Promise<Backend> {
  return worker.evaluate(() => (globalThis as typeof globalThis & FixtureScope).relationshipBackend);
}
async function resetLog(): Promise<void> {
  await worker.evaluate(() => {
    const state = (globalThis as typeof globalThis & FixtureScope).relationshipBackend;
    state.rest = []; state.graphql = [];
  });
}
async function overlayState(): Promise<{ metrics: string[]; selected: string; edges: { key: string; drawn: boolean }[] }> {
  return shadowCall('overlay', function(this: ShadowRoot) {
    return {
      metrics: [...this.querySelectorAll('.metric strong')].map(element => element.textContent ?? ''),
      selected: this.querySelector('select')!.value,
      edges: [...this.querySelectorAll('g[data-edge-key]')].map(group => ({ key: group.getAttribute('data-edge-key')!, drawn: Boolean(group.querySelector('path')!.getAttribute('d')) })),
    };
  }.toString());
}

async function installObservedTable(): Promise<void> {
  await popup.locator('#enabled').uncheck();
  await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 720 });
  const html = await readFile('tests/fixtures/github-table-observed.html', 'utf8');
  await page.evaluate(html => {
    const fixture = new DOMParser().parseFromString(html, 'text/html');
    for (const attribute of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attribute.name);
    for (const attribute of fixture.documentElement.attributes) document.documentElement.setAttribute(attribute.name, attribute.value);
    document.head.replaceChildren(...[...fixture.head.childNodes].map(node => document.importNode(node, true)));
    document.body.replaceChildren(...[...fixture.body.childNodes].map(node => document.importNode(node, true)));
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="rowheader"] button')) {
      button.addEventListener('click', () => { button.dataset.fixtureClicks = String(Number(button.dataset.fixtureClicks ?? 0) + 1); });
    }
  }, html);
}

async function configureObservedTable(width: number, height: number, wrapping: boolean, theme = 'light'): Promise<void> {
  await page.evaluate(({ width, height, wrapping, theme }) => {
    const grid = document.querySelector<HTMLElement>('#project-items-region')!;
    grid.style.setProperty('--column-Title-width', String(width));
    grid.style.setProperty('--table-cell-height', `${height}px`);
    grid.style.setProperty('--table-cell-padding-y', `${height === 37 ? 12 : height === 56 ? 8 : 10}px`);
    grid.style.setProperty('--table-cell-align-items', height === 37 ? 'center' : 'flex-start');
    document.querySelector<HTMLElement>('.tableScrollContainerInner__CUGIVZ')!.style.width = `${width + 1325}px`;
    for (const link of grid.querySelectorAll<HTMLElement>('.Link__x8mIvq')) {
      link.classList.toggle('wrapping__6kAcxN', wrapping);
      link.style.setProperty('--line-clamp', String(height === 120 ? 5 : height === 80 ? 3 : 2));
    }
    document.documentElement.dataset.colorMode = theme;
    document.documentElement.dataset.lightTheme = 'light';
    document.documentElement.dataset.darkTheme = 'dark';
  }, { width, height, wrapping, theme });
}

async function observedTableLayout() {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('#project-items-region')!;
    const origin = grid.getBoundingClientRect();
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { x: Math.round((value.x - origin.x) * 1000) / 1000, y: Math.round((value.y - origin.y) * 1000) / 1000, width: Math.round(value.width * 1000) / 1000, height: Math.round(value.height * 1000) / 1000 };
    };
    const pseudo = (element: Element) => {
      const style = getComputedStyle(element, '::before');
      return { content: style.content, position: style.position, inset: style.inset, border: style.border, background: style.backgroundColor, pointerEvents: style.pointerEvents, zIndex: style.zIndex };
    };
    return [...grid.querySelectorAll<HTMLElement>('[data-item-id]')].map(row => {
      const title = row.querySelector<HTMLElement>('[role="rowheader"]')!;
      const link = title.querySelector<HTMLAnchorElement>('a[href]');
      const host = title.querySelector<HTMLElement>('[data-dependency-relationships="item"]');
      const native = [...title.querySelectorAll<HTMLElement>('button,.Box__t6Xr2Z,.Box_1__8BKx5T')].map(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { label: element.getAttribute('aria-label') ?? element.className, rect: rect(element), clickable: element.tagName === 'BUTTON', hit: hit === element || element.contains(hit) };
      });
      const linkStyle = link ? getComputedStyle(link) : undefined;
      const issue = link?.href.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
      return { id: row.dataset.itemId, issue: issue ? `${issue[1]}#${issue[2]}` : null, row: rect(row), columns: [...row.children].map(rect), title: rect(title), pseudo: pseudo(title), link: link ? { rect: rect(link), scrollWidth: link.scrollWidth, clientWidth: link.clientWidth, overflow: linkStyle!.overflow, ellipsis: linkStyle!.textOverflow, clamp: linkStyle!.webkitLineClamp } : null, native, action: host && getComputedStyle(host).display !== 'none' ? rect(host) : null, fallback: Boolean(host?.hidden && getComputedStyle(host).display === 'none'), styles: [title, ...title.querySelectorAll<HTMLElement>('*')].filter(element => !element.closest('[data-dependency-relationships]')).map(element => element.style.cssText || null) };
    });
  });
}

function observedNativeGeometry(rows: Awaited<ReturnType<typeof observedTableLayout>>) {
  return rows.map(({ id, row, columns, title, pseudo }) => ({ id, row, columns, title, pseudo }));
}

async function restoreTableFixture(initial: Backend): Promise<void> {
  await popup.getByRole('switch', { name: 'Relationships の操作UIを表示', exact: true }).check();
  await popup.locator('#enabled').check();
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.reload();
  await expect(page.locator(`[${ownerAttribute}="item"]`)).toHaveCount(4);
  await worker.evaluate(({ rest, graphql }) => {
    const state = (globalThis as typeof globalThis & FixtureScope).relationshipBackend;
    state.rest = rest; state.graphql = graphql;
  }, { rest: initial.rest, graphql: initial.graphql });
}

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'project-relationships-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1024 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & FixtureScope;
    const state: Backend = {
      rest: [], graphql: [], blockers: { 1: [], 2: [1], 3: [1, 2], 4: [3], 99: [1] }, parents: { 1: 90, 91: 1 },
      fields: [{ id: 'title', name: 'Title', dataType: 'TITLE' }, { id: 'native-status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }, { id: 'priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: [] }, { id: 'parent', name: 'Parent issue', dataType: 'PARENT_ISSUE' }, { id: 'progress', name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS' }],
      visible: ['title', 'native-status', 'priority'], values: {}, denyRestWrites: false, failedItem: null,
    };
    scope.relationshipBackend = state;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const issue = (number: number) => ({ id: 1000 + number, number, html_url: `https://github.com/acme/app/issues/${number}` });
    const connection = (nodes: unknown[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
    scope.fetch = async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET';
      if (url.origin !== 'https://api.github.com') throw new Error('Unexpected API origin');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      if (url.pathname === '/graphql') {
        const query = String(body?.query); const variables = body?.variables as Record<string, unknown>;
        const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
        state.graphql.push({ operation, variables, mutation: /^\s*mutation/.test(query) });
        if (operation === 'IntegrationProject') return json({ data: { owner: { projectV2: { id: 'project-1' } } } });
        if (operation === 'IntegrationFields') return json({ data: { node: { fields: connection(state.fields) } } });
        if (operation === 'IntegrationItems') {
          const numbers = variables.after === null ? [1, 2, 3] : [4, 99];
          const items: unknown[] = numbers.map(number => {
            const values = state.values[`item-${number}`] ?? {};
            const value = (field: string, key: string) => values[field] === undefined ? null : { [key]: values[field], field: { id: field } };
            return { id: `item-${number}`, isArchived: false, content: { __typename: 'Issue', url: issue(number).html_url, number }, blockers: value('field-blockers', 'text'), blocking: value('field-blocking', 'text'), status: value('field-status', 'optionId') };
          });
          if (variables.after !== null) items.push({ id: 'draft-1', isArchived: false, content: { __typename: 'DraftIssue' } });
          return json({ data: { node: { items: connection(items, variables.after === null ? 'items-2' : null) } } });
        }
        if (operation === 'IntegrationView') return json({ data: { node: { view: { id: 'view-2', number: 2, layout: 'TABLE_LAYOUT', configuration: { visibleFields: connection(state.visible.map(id => ({ id }))) } } } } });
        if (operation === 'IntegrationCreateField') {
          const fieldInput = variables.input as { name: string; dataType: string; singleSelectOptions?: { name: string }[] };
          const id = fieldInput.name === 'Dependency blockers' ? 'field-blockers' : fieldInput.name === 'Dependency blocking' ? 'field-blocking' : 'field-status';
          const field: Field = { id, name: fieldInput.name, dataType: fieldInput.dataType, ...(fieldInput.dataType === 'SINGLE_SELECT' ? { options: fieldInput.singleSelectOptions!.map(option => ({ id: `option-${option.name}`, name: option.name })) } : {}) };
          state.fields.push(field); return json({ data: { createProjectV2Field: { projectV2Field: field } } });
        }
        if (operation === 'IntegrationShowFields') {
          const update = variables.input as { configuration: { visibleFieldIds: string[] } };
          state.visible = [...update.configuration.visibleFieldIds];
          return json({ data: { updateProjectV2View: { projectV2View: { id: 'view-2' } } } });
        }
        if (operation === 'IntegrationUpdateItem') {
          const inputs = Object.entries(variables) as [string, { itemId: string; fieldId: string; value?: { text?: string; singleSelectOptionId?: string } }][];
          if (inputs.some(([, input]) => input.itemId === state.failedItem)) return json({ errors: [{ type: 'FORBIDDEN', message: 'Fixture rejected field update' }] });
          const result: Record<string, unknown> = {};
          for (const [key, input] of inputs) {
            const current = state.values[input.itemId] ?? {}; state.values[input.itemId] = current;
            if (input.value) current[input.fieldId] = input.value.text ?? input.value.singleSelectOptionId!;
            else delete current[input.fieldId];
            result[key.replace('input', 'value')] = { projectV2Item: { id: input.itemId } };
          }
          return json({ data: result });
        }
        throw new Error(`Unexpected GraphQL operation ${operation}`);
      }
      state.rest.push({ method, path: url.pathname, ...(body ? { body } : {}) });
      const match = /^\/repos\/acme\/app\/issues\/(\d+)(.*)$/.exec(url.pathname);
      if (!match) throw new Error('Unexpected REST endpoint');
      const number = Number(match[1]); const suffix = match[2];
      if (method === 'GET') {
        if (!suffix) return json(issue(number));
        if (suffix === '/dependencies/blocked_by') return json((state.blockers[number] ?? []).map(issue));
        if (suffix === '/dependencies/blocking') return json(Object.entries(state.blockers).filter(([, blockers]) => blockers.includes(number)).map(([number]) => issue(Number(number))));
        if (suffix === '/parent') return state.parents[number] ? json(issue(state.parents[number]!)) : json({}, 404);
        if (suffix === '/sub_issues') return json(Object.entries(state.parents).filter(([, parent]) => parent === number).map(([number]) => issue(Number(number))));
      }
      if (method !== 'GET' && state.denyRestWrites) return json({ message: 'Fixture write denied' }, 403);
      if (method === 'POST' && suffix === '/dependencies/blocked_by') {
        state.blockers[number] = [...new Set([...(state.blockers[number] ?? []), Number(body!.issue_id) - 1000])]; return json({}, 201);
      }
      const remove = /^\/dependencies\/blocked_by\/(\d+)$/.exec(suffix ?? '');
      if (method === 'DELETE' && remove) {
        state.blockers[number] = (state.blockers[number] ?? []).filter(blocker => blocker !== Number(remove[1]) - 1000); return new Response(null, { status: 204 });
      }
      if (method === 'POST' && suffix === '/sub_issues') { state.parents[Number(body!.sub_issue_id) - 1000] = number; return json({}, 201); }
      if (method === 'DELETE' && suffix === '/sub_issue') { delete state.parents[Number(body!.sub_issue_id) - 1000]; return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected REST operation ${method} ${suffix}`);
    };
  });
  const fixture = (await readFile('tests/fixtures/table.html', 'utf8')).replace('</header>', '<label style="display:block;margin-top:10px">Filter <input id="filter-bar-component" aria-label="Filter by keyword or by field" value="status:Todo OR label:bug" style="width:420px;padding:6px"></label></header>');
  await context.route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  page = await context.newPage(); await page.goto('https://github.com/orgs/acme/projects/1/views/2');
  popup = await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/index.html`);
  await popup.locator('#token').fill('github_pat_' + 'x'.repeat(50));
  await popup.getByRole('button', { name: 'PAT を設定' }).click(); await popup.locator('#enabled').check();
  cdp = await context.newCDPSession(page); await page.bringToFront();
  await expect(page.locator(`[${ownerAttribute}="item"]`)).toHaveCount(4);
  await expect.poll(async () => (await backend()).rest.length).toBe(4);
});
test.afterAll(async () => { await cdp?.detach(); await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });

test('preserves observed GitHub table cells and native controls at native row heights and narrow title widths', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const initial = await backend();
  const layouts: unknown[] = [];
  try {
    await installObservedTable();
    await page.evaluate(() => {
      for (const id of ['1', '2']) document.querySelector(`[data-item-id="${id}"] .Link__x8mIvq`)!.textContent = 'タイトル列が狭い状態でも GitHub 標準操作と Relationships を重ねずに表示する AContinuousIssueTitleWithoutSpaces';
      document.querySelector<HTMLAnchorElement>('[data-item-id="2"] .Link__x8mIvq')!.href = 'https://github.com/acme/app/issues/983';
      document.querySelector('[data-item-id="2"] .Box_1__8BKx5T')!.textContent = '#983';
      document.querySelector('[data-item-id="1"] [role="rowheader"]')!.classList.add('is-selected', 'is-focused');
    });
    const baselines = new Map<string, Awaited<ReturnType<typeof observedTableLayout>>>();
    for (const width of [150, 180, 240, 589]) {
      for (const height of [37, 56, 80, 120]) {
        for (const wrapping of [false, true]) {
          await configureObservedTable(width, height, wrapping);
          baselines.set(`${width}/${height}/${wrapping}`, await observedTableLayout());
          if (width === 150 && height === 37 && !wrapping) await page.screenshot({ path: testInfo.outputPath('github-native37-150px-controls-off.png') });
        }
      }
    }
    await configureObservedTable(180, 37, false);
    await page.screenshot({ path: testInfo.outputPath('github-native37-narrow-controls-off.png') });
    await popup.locator('#enabled').check();
    await expect(page.locator('[data-item-id="1"] [data-dependency-relationships="item"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('github-native37-narrow-controls-on.png') });

    for (const width of [150, 180, 240, 589]) {
      for (const height of [37, 56, 80, 120]) {
        for (const wrapping of [false, true]) {
          await configureObservedTable(width, height, wrapping);
          const baseline = baselines.get(`${width}/${height}/${wrapping}`)!;
          await expect.poll(async () => observedNativeGeometry(await observedTableLayout()), { message: `GitHub native boundaries: Title ${width}px, row ${height}px, wrapping ${wrapping}` }).toEqual(observedNativeGeometry(baseline));
          await page.locator('[data-item-id="2"] [role="rowheader"]').hover();
          const enabled = await observedTableLayout();
          layouts.push({ width, height, wrapping, baseline, enabled });
          if (height === 37 && !wrapping) expect(enabled[1]!.fallback).toBe(width === 150);
          for (const row of enabled.slice(0, 2)) {
            expect(row.row.height).toBe(height);
            expect(row.action !== null || row.fallback, `Relationship action or native-preserving fallback for row ${row.id}`).toBe(true);
            const action = row.action;
            if (action) {
              expect(action.x).toBeGreaterThanOrEqual(row.title.x);
              expect(action.x + action.width).toBeLessThanOrEqual(row.title.x + row.title.width);
              expect(action.y).toBeGreaterThanOrEqual(row.title.y);
              expect(action.y + action.height).toBeLessThanOrEqual(row.title.y + row.title.height);
              expect(row.link!.rect.x + row.link!.rect.width).toBeLessThanOrEqual(action.x);
            } else {
              const nativeBaseline = baseline.find(candidate => candidate.id === row.id)!;
              expect(row.native.map(native => native.rect)).toEqual(nativeBaseline.native.map(native => native.rect));
            }
            for (const native of row.native) {
              if (action) {
                const horizontal = native.rect.x < action.x + action.width && native.rect.x + native.rect.width > action.x;
                const vertical = native.rect.y < action.y + action.height && native.rect.y + native.rect.height > action.y;
                expect(horizontal && vertical, `Native ${native.label} must not overlap Relationships (${width}/${height}/${wrapping})`).toBe(false);
              }
              if (native.clickable) expect(native.hit, `Native ${native.label} must receive pointer events`).toBe(true);
            }
            if (width <= 240) {
              expect(row.link!.scrollWidth).toBeGreaterThan(row.link!.clientWidth);
              expect(row.link!.overflow).toBe('hidden');
              expect(row.link!.ellipsis === 'ellipsis' || Number(row.link!.clamp) > 0).toBe(true);
            }
          }
          if (height === 37 && !wrapping) {
            await expect.poll(async () => shadowCall<string[]>('toolbar', function(this: ShadowRoot) {
              const select = this.querySelector<HTMLSelectElement>('[aria-label="Relationships を編集する Issue"]');
              return select ? [...select.options].map(option => option.value).filter(Boolean) : [];
            }.toString())).toEqual(enabled.filter(row => row.fallback).map(row => row.issue));
            for (const button of await page.locator('[data-item-id="2"] [role="rowheader"] button').all()) {
              const previous = Number(await button.getAttribute('data-fixture-clicks') ?? 0);
              await button.click();
              await expect(button).toHaveAttribute('data-fixture-clicks', String(previous + 1));
            }
            for (const row of enabled.slice(0, 2).filter(row => row.fallback)) {
              await shadowCall('toolbar', function(this: ShadowRoot, issue: string) {
                const select = this.querySelector<HTMLSelectElement>('[aria-label="Relationships を編集する Issue"]')!;
                if (![...select.options].some(option => option.value === issue)) throw new Error(`Missing fallback Issue ${issue}`);
                select.value = issue; select.dispatchEvent(new Event('change', { bubbles: true }));
              }.toString(), [row.issue]);
              await expect.poll(async () => shadowCall<string>('dialog', function(this: ShadowRoot) { return this.querySelector('h2')!.textContent!; }.toString())).toBe(`${row.issue} · Relationships`);
              await click('dialog', '閉じる');
            }
          }
          if ([150, 180, 589].includes(width) && [37, 120].includes(height) && !wrapping) {
            await page.screenshot({ path: testInfo.outputPath(`github-native-${width}px-${height}px-controls-on.png`) });
          }
        }
      }
    }
    await configureObservedTable(180, 37, false);
    const trigger = page.locator('[data-item-id="1"] [data-dependency-relationships="item"]');
    await trigger.click();
    await expect.poll(async () => (await dialogSections()).length).toBe(4);
    await page.keyboard.press('Escape');
    expect(await shadowCall('item', function(this: ShadowRoot) { return this.activeElement === this.querySelector('button'); }.toString())).toBe(true);
    await configureObservedTable(240, 37, false);
    const resizingTrigger = page.locator('[data-item-id="2"] [data-dependency-relationships="item"]');
    await expect(resizingTrigger).toBeVisible();
    await resizingTrigger.click();
    await expect.poll(async () => (await dialogSections()).length).toBe(4);
    await configureObservedTable(150, 37, false);
    await expect(resizingTrigger).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(0);
    expect(await shadowCall('toolbar', function(this: ShadowRoot) {
      const select = this.querySelector('[aria-label="Relationships を編集する Issue"]');
      return Boolean(select && this.activeElement === select);
    }.toString())).toBe(true);
    await shadowCall('toolbar', function(this: ShadowRoot) {
      const select = this.querySelector<HTMLSelectElement>('[aria-label="Relationships を編集する Issue"]')!;
      select.value = 'acme/app#983'; select.dispatchEvent(new Event('change', { bubbles: true }));
    }.toString());
    await expect.poll(async () => (await dialogSections()).length).toBe(4);
    await configureObservedTable(240, 37, false);
    await expect(resizingTrigger).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(0);
    expect(await resizingTrigger.evaluate(element => document.activeElement === element)).toBe(true);
    await configureObservedTable(180, 37, false);
    await popup.locator('#enabled').uncheck();
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    const restored = await observedTableLayout();
    expect(restored.map(row => row.styles)).toEqual(baselines.get('180/37/false')!.map(row => row.styles));
    expect(observedNativeGeometry(restored)).toEqual(observedNativeGeometry(baselines.get('180/37/false')!));
  } finally {
    const path = testInfo.outputPath('github-observed-native-layouts.json');
    await writeFile(path, JSON.stringify(layouts, null, 2));
    await testInfo.attach('github-observed-native-layouts', { path, contentType: 'application/json' });
    await restoreTableFixture(initial);
  }
});

test('keeps observed GitHub table controls synchronized through themes, visibility, scrolling and virtual row reuse', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const initial = await backend();
  const visible = popup.getByRole('switch', { name: 'Relationships の操作UIを表示', exact: true });
  const snapshots: unknown[] = [];
  try {
    await installObservedTable();
    await configureObservedTable(240, 37, false);
    const baseline = await observedTableLayout();
    const scroll = page.locator('[data-testid="table-scroll-container"]');
    const nativeAdd = page.locator('[data-item-id="5"] .PlusIconContainer__Mt37vh button');
    await scroll.evaluate(element => { element.scrollLeft = 260; });
    await expect.poll(async () => scroll.evaluate(element => element.scrollLeft)).toBe(260);
    const nativeBox = (await nativeAdd.boundingBox())!;
    expect(nativeBox.x).toBeGreaterThanOrEqual(0);
    await page.mouse.move(nativeBox.x + nativeBox.width / 2, nativeBox.y + nativeBox.height / 2);
    const nativeClippedBaseline = (await observedTableLayout()).find(row => row.id === '5')!;
    expect(nativeClippedBaseline.native.find(control => control.label === 'Add sub-issue')!.hit).toBe(true);
    snapshots.push({ controls: 'off', left: 260, nativeClippedBaseline });
    await page.screenshot({ path: testInfo.outputPath('github-observed-horizontal-edge-controls-off.png') });
    await scroll.evaluate(element => { element.scrollLeft = 0; });
    await popup.locator('#enabled').check();
    await expect(page.locator('[data-item-id="1"] [data-dependency-relationships="item"]')).toHaveCount(1);
    await expect.poll(async () => (await overlayState()).edges.filter(edge => edge.drawn).length).toBe(4);
    const overlay = page.locator('#github-dependency-visualizer-overlay');
    const originalOverlay = await overlay.evaluateHandle(element => element);
    const originalState = await overlayState();
    const requests = await backend();
    await visible.uncheck();
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    expect(await overlay.evaluate((element, previous) => element === previous, originalOverlay)).toBe(true);
    expect(await overlayState()).toEqual(originalState);
    expect((await backend()).rest).toEqual(requests.rest);
    expect((await backend()).graphql).toEqual(requests.graphql);
    expect((await observedTableLayout()).map(row => row.styles)).toEqual(baseline.map(row => row.styles));
    await page.screenshot({ path: testInfo.outputPath('github-observed-visibility-off.png') });
    await visible.check();
    await expect(page.locator('[data-item-id="1"] [data-dependency-relationships="item"]')).toHaveCount(1);
    expect(await overlay.evaluate((element, previous) => element === previous, originalOverlay)).toBe(true);
    await originalOverlay.dispose();
    await page.locator('[data-item-id="1"] [data-dependency-relationships="item"]').click();
    await expect.poll(async () => (await dialogSections()).length).toBe(4);
    await click('dialog', '閉じる');

    for (const theme of ['light', 'dark']) {
      await configureObservedTable(240, 37, false, theme);
      for (const { left, top } of [{ left: 0, top: 0 }, { left: 120, top: 0 }, { left: 260, top: 0 }, { left: 0, top: 185 }, { left: 0, top: 0 }]) {
        await scroll.evaluate((element, { left, top }) => { element.scrollLeft = left; element.scrollTop = top; }, { left, top });
        await expect.poll(async () => scroll.evaluate(element => element.scrollLeft)).toBe(left);
        if (top) await expect.poll(async () => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        else await expect.poll(async () => scroll.evaluate(element => element.scrollTop)).toBe(0);
        const bounds = await page.locator('#project-items-region').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
        await expect.poll(async () => {
          const rows = await observedTableLayout();
          const visibleRows = rows.filter(row => row.issue && row.title.x + row.title.width > 0 && row.title.x < bounds.width && row.title.y + row.title.height > 34 && row.title.y < bounds.height);
          return visibleRows.length > 0 && visibleRows.every(row => row.fallback || (row.action && row.action.x >= row.title.x && row.action.x + row.action.width <= row.title.x + row.title.width));
        }).toBe(true);
        const actualScroll = await scroll.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
        snapshots.push({ theme, left, top, actualScroll, layout: await observedTableLayout(), overlay: await overlayState() });
        if (left === 260) {
          await expect.poll(async () => (await observedTableLayout()).find(row => row.id === '5')!.fallback).toBe(true);
          const box = (await nativeAdd.boundingBox())!;
          expect({ x: box.x, width: box.width, height: box.height }).toEqual({ x: nativeBox.x, width: nativeBox.width, height: nativeBox.height });
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          expect((await observedTableLayout()).find(row => row.id === '5')!.native.find(control => control.label === 'Add sub-issue')!.hit).toBe(true);
          const previous = Number(await nativeAdd.getAttribute('data-fixture-clicks') ?? 0);
          await nativeAdd.click();
          await expect(nativeAdd).toHaveAttribute('data-fixture-clicks', String(previous + 1));
          await expect.poll(async () => scroll.evaluate(element => element.scrollLeft)).toBe(260);
          await page.screenshot({ path: testInfo.outputPath(`github-observed-horizontal-edge-${theme}-controls-on.png`) });
        }
        await expect(overlay).toHaveCount(1);
      }
      await page.screenshot({ path: testInfo.outputPath(`github-observed-${theme}-controls-on.png`) });
    }
    await page.evaluate(() => {
      const chunk = document.querySelector('[data-virtualized-chunk="1"]')!;
      const retained = chunk.querySelector('[data-item-id="1"]')!;
      retained.setAttribute('data-item-id', '101');
      const link = retained.querySelector<HTMLAnchorElement>('.Link__x8mIvq')!;
      link.href = 'https://github.com/acme/app/issues/101'; link.textContent = 'Recycled GitHub virtual row';
      const next = document.querySelector('[data-virtualized-chunk="2"]')!;
      next.replaceChildren(...[...next.children].reverse());
    });
    await expect(page.locator('[data-item-id="101"] [data-dependency-relationships="item"]')).toHaveCount(1);
    await expect.poll(async () => shadowCall<string>('item', function(this: ShadowRoot) { return this.querySelector('button')!.getAttribute('aria-label')!; }.toString())).toBe('acme/app#101 の Relationships');
    await page.locator('[data-item-id="101"] [data-dependency-relationships="item"]').click();
    await expect.poll(async () => shadowCall<string>('dialog', function(this: ShadowRoot) { return this.querySelector('h2')!.textContent!; }.toString())).toBe('acme/app#101 · Relationships');
    await click('dialog', '閉じる');
    await page.evaluate(() => document.querySelector('[data-virtualized-chunk="1"]')!.remove());
    await expect(page.locator('[data-item-id="101"]')).toHaveCount(0);
    await expect(page.locator('[data-item-id="6"] [data-dependency-relationships="item"]')).toHaveCount(1);
    snapshots.push({ virtualized: await observedTableLayout(), overlay: await overlayState() });
    await page.screenshot({ path: testInfo.outputPath('github-observed-dark-virtualized.png') });
  } finally {
    const path = testInfo.outputPath('github-observed-lifecycle-layouts.json');
    await writeFile(path, JSON.stringify(snapshots, null, 2));
    await testInfo.attach('github-observed-lifecycle-layouts', { path, contentType: 'application/json' });
    await restoreTableFixture(initial);
  }
});

test('keeps narrow table rows aligned and relationship actions accessible through resizing and scrolling', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const initial = await backend();
  const configureTable = async (width: number, scrollLeft: number) => {
    await page.evaluate(({ width, scrollLeft }) => {
      for (const row of document.querySelectorAll<HTMLElement>('[role="row"]')) row.style.gridTemplateColumns = `66px ${width}px 190px 250px 850px`;
      document.querySelector('#project-items-region')!.scrollLeft = scrollLeft;
    }, { width, scrollLeft });
  };
  const snapshot = async () => page.evaluate(() => {
    const grid = document.querySelector('#project-items-region')!.getBoundingClientRect();
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x - grid.x, y: box.y - grid.y, width: box.width, height: box.height };
    };
    return [...document.querySelectorAll<HTMLElement>('[data-item-id]')].slice(0, 4).map(row => {
      const title = row.querySelector<HTMLElement>('[role="rowheader"]')!;
      const link = title.querySelector<HTMLAnchorElement>('a')!;
      return { row: rect(row), columns: [...row.children].map(rect), title: rect(title), link: rect(link), styles: [title.style.cssText, link.style.cssText] };
    });
  });
  const nativeLayout = (rows: Awaited<ReturnType<typeof snapshot>>) => rows.map(({ row, columns }) => ({ row, columns }));
  const action = async () => shadowCall<{ x: number; y: number; left: number; right: number; top: number; bottom: number; width: number; height: number; label: string | null; enabled: boolean; hit: boolean }>('item', function(this: ShadowRoot) {
    const button = this.querySelector<HTMLButtonElement>('button')!;
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2;
    return { x, y, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, label: button.getAttribute('aria-label'), enabled: !button.disabled, hit: document.elementFromPoint(x, y) === this.host && this.elementFromPoint(x, y) === button };
  }.toString());
  try {
    await popup.locator('#enabled').uncheck();
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    await page.evaluate(() => {
      document.querySelector('[data-item-id="1"] [role="rowheader"] a')!.textContent = 'タイトル列の折り返しで行と列の配置を変えずに関係を操作する';
      document.querySelector('[data-item-id="2"] [role="rowheader"] a')!.textContent = 'AContinuousIssueTitleWithoutAnySpacesThatMustStayInsideItsOwnTitleColumn';
    });
    const baselines = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const width of [180, 240]) {
      for (const scrollLeft of [0, 320]) {
        await configureTable(width, scrollLeft);
        baselines.set(`${width}/${scrollLeft}`, await snapshot());
      }
    }
    await configureTable(180, 0);
    await popup.locator('#enabled').check();
    await expect(page.locator(`[${ownerAttribute}="item"]`)).toHaveCount(4);
    for (const [width, scrollLeft] of [[180, 0], [180, 320], [240, 320], [240, 0]] as const) {
      await configureTable(width, scrollLeft);
      const baseline = baselines.get(`${width}/${scrollLeft}`)!;
      const enabled = await snapshot();
      const control = await action();
      await testInfo.attach(`table-layout-${width}-${scrollLeft}`, { body: JSON.stringify({ baseline, enabled, control }, null, 2), contentType: 'application/json' });
      await expect.poll(async () => nativeLayout(await snapshot()), { message: `Native rows and column boundaries at Title ${width}px, scroll ${scrollLeft}px` }).toEqual(nativeLayout(baseline));
      if (scrollLeft === 0) await page.screenshot({ path: testInfo.outputPath(`table-relationships-${width}px.png`) });
      expect(control.label).toBe('acme/app#1 の Relationships');
      expect(control.enabled).toBe(true);
      expect(control.hit).toBe(true);
      expect(control.width).toBeGreaterThan(0);
      expect(control.height).toBeGreaterThan(0);
      const title = await page.locator('[data-item-id="1"] [role="rowheader"]').boundingBox();
      expect(title).not.toBeNull();
      expect(control.left).toBeGreaterThanOrEqual(title!.x);
      expect(control.right).toBeLessThanOrEqual(title!.x + title!.width);
      expect(control.top).toBeGreaterThanOrEqual(title!.y);
      expect(control.bottom).toBeLessThanOrEqual(title!.y + title!.height);
      for (const row of enabled) {
        expect(row.link.x).toBeGreaterThanOrEqual(row.title.x);
        expect(row.link.x + row.link.width).toBeLessThanOrEqual(row.title.x + row.title.width);
      }
      expect(enabled[0]!.link.x + enabled[0]!.link.width).toBeLessThanOrEqual(control.left - (title!.x - enabled[0]!.title.x));
      await page.mouse.click(control.x, control.y);
      await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(1);
      await expect.poll(async () => (await dialogSections()).length).toBe(4);
      if (scrollLeft === 0) await page.keyboard.press('Escape'); else await click('dialog', '閉じる');
      await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(0);
      expect(await shadowCall('item', function(this: ShadowRoot) { return this.activeElement === this.querySelector('button'); }.toString())).toBe(true);
    }
    await popup.locator('#enabled').uncheck();
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    expect(await snapshot()).toEqual(baselines.get('240/0'));
  } finally {
    await popup.locator('#enabled').check();
    await page.reload();
    await expect(page.locator(`[${ownerAttribute}="item"]`)).toHaveCount(4);
    await worker.evaluate(({ rest, graphql }) => {
      const state = (globalThis as typeof globalThis & FixtureScope).relationshipBackend;
      state.rest = rest; state.graphql = graphql;
    }, { rest: initial.rest, graphql: initial.graphql });
  }
});

test('toggles relationship controls independently and keeps the preference across reloads', async () => {
  test.setTimeout(60_000);
  const initial = await backend();
  const visible = popup.getByRole('switch', { name: 'Relationships の操作UIを表示', exact: true });
  const overlay = page.locator('#github-dependency-visualizer-overlay');
  const expectControls = async () => {
    await expect(page.locator(`[${ownerAttribute}="item"]`)).toHaveCount(4);
    await expect(page.locator(`[${ownerAttribute}="toolbar"]`)).toHaveCount(1);
    await expect(page.locator(`[${ownerAttribute}="dialog"]`)).toHaveCount(0);
  };
  const selectIssue = async () => {
    await shadowCall('overlay', function(this: ShadowRoot) {
      const select = this.querySelector('select')!;
      select.value = 'acme/app#3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }.toString());
    await expect.poll(overlayState).toMatchObject({ selected: 'acme/app#3' });
    return overlayState();
  };
  try {
    await expect(visible).toBeChecked();
    await expectControls();
    await openItem();
    const displayed = await overlayState();
    expect(displayed.metrics).toEqual(['3', '1', '1']);
    expect(displayed.edges).toHaveLength(4);
    expect(displayed.edges.every(edge => edge.drawn)).toBe(true);
    const selected = await selectIssue();
    const displayedOverlay = await overlay.evaluateHandle(element => element);
    const requests = await backend();

    await visible.uncheck();
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    await expect(popup.locator('#enabled')).toBeChecked();
    await expect(overlay).toHaveCount(1);
    await expect.poll(overlayState).toEqual(selected);
    expect(await overlay.evaluate((element, previous) => element === previous, displayedOverlay)).toBe(true);
    await displayedOverlay.dispose();
    expect((await backend()).rest).toEqual(requests.rest);
    expect((await backend()).graphql).toEqual(requests.graphql);

    await popup.reload();
    await expect(visible).not.toBeChecked();
    await page.reload();
    await expect(overlay).toHaveCount(1);
    await expect.poll(overlayState).toEqual(displayed);
    await expect(page.locator(`[${ownerAttribute}]`)).toHaveCount(0);
    const hiddenSelection = await selectIssue();
    const hiddenOverlay = await overlay.evaluateHandle(element => element);
    const hiddenRequests = await backend();

    await visible.check();
    await expectControls();
    await expect.poll(overlayState).toEqual(hiddenSelection);
    expect(await overlay.evaluate((element, previous) => element === previous, hiddenOverlay)).toBe(true);
    await hiddenOverlay.dispose();
    expect((await backend()).rest).toEqual(hiddenRequests.rest);
    expect((await backend()).graphql).toEqual(hiddenRequests.graphql);
    await openItem();
    await click('dialog', '閉じる');

    await popup.reload();
    await expect(visible).toBeChecked();
    await page.reload();
    await expectControls();
    await expect.poll(overlayState).toEqual(displayed);
  } finally {
    await visible.check();
    await page.reload();
    await expectControls();
    await worker.evaluate(({ rest, graphql }) => {
      const state = (globalThis as typeof globalThis & FixtureScope).relationshipBackend;
      state.rest = rest; state.graphql = graphql;
    }, { rest: initial.rest, graphql: initial.graphql });
  }
});

test('edits canonical relationships, uses native filters and synchronizes real project fields', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const initial = await backend();
  expect(initial.rest.every(request => request.method === 'GET' && request.path.endsWith('/dependencies/blocked_by'))).toBe(true);
  expect(initial.graphql).toEqual([]);

  await click('toolbar', 'ブロック中の Issue');
  await expect(page.locator('#filter-bar-component')).toHaveValue('(status:Todo OR label:bug) is:blocked');
  await openItem();
  expect(await dialogSections()).toEqual([[], ['acme/app#2', 'acme/app#3', 'acme/app#99'], ['acme/app#90'], ['acme/app#91']]);
  await page.screenshot({ path: testInfo.outputPath('relationships-dialog.png') });

  await add(0, 5); await expect.poll(async () => (await dialogSections())[0]).toEqual(['acme/app#5']);
  expect((await backend()).blockers[1]).toEqual([5]);
  await remove(0, 5); await expect.poll(async () => (await dialogSections())[0]).toEqual([]);
  await remove(2, 90); await expect.poll(async () => (await dialogSections())[2]).toEqual([]);
  await add(2, 92); await expect.poll(async () => (await dialogSections())[2]).toEqual(['acme/app#92']);
  expect((await backend()).parents[1]).toBe(92);
  await add(3, 93); await expect.poll(async () => (await dialogSections())[3]).toContain('acme/app#93');
  await remove(3, 93); await expect.poll(async () => (await dialogSections())[3]).not.toContain('acme/app#93');
  await add(1, 6); await expect.poll(async () => (await dialogSections())[1]).toContain('acme/app#6');
  await remove(1, 6); await expect.poll(async () => (await dialogSections())[1]).not.toContain('acme/app#6');

  await click('dialog', '閉じる'); await page.locator('#filter-bar-component').fill('status:Todo OR label:bug'); await openItem();
  await nativeSectionFilter(1);
  await expect(page.locator('#filter-bar-component')).toHaveValue('(status:Todo OR label:bug) blocked-by:"acme/app#1"');
  await page.locator('#filter-bar-component').fill('status:Todo OR label:bug'); await openItem(); await nativeSectionFilter(3);
  await expect(page.locator('#filter-bar-component')).toHaveValue('(status:Todo OR label:bug) parent-issue:"acme/app#1"');

  await resetLog(); await click('toolbar', '標準フィールドに同期');
  await expect.poll(dialogStatus).toContain('5 Issue');
  const preview = await backend();
  expect(preview.graphql.every(request => !request.mutation)).toBe(true);
  expect(preview.graphql.filter(request => request.operation === 'IntegrationItems')).toHaveLength(2);
  expect(preview.rest).toEqual([]);
  expect(await shadowCall('dialog', function(this: ShadowRoot) { return this.textContent; }.toString())).toContain('Dependency blockers');
  await click('dialog', '同期を実行'); await expect.poll(dialogStatus).toContain('5 Issue を更新');
  const synced = await backend();
  expect(synced.fields.filter(field => field.name.startsWith('Dependency ')).map(field => field.name)).toEqual(['Dependency blockers', 'Dependency blocking', 'Dependency status']);
  expect(synced.fields.filter(field => field.name === 'Parent issue')).toHaveLength(1);
  expect(synced.visible).toEqual(['title', 'native-status', 'priority', 'field-blockers', 'field-blocking', 'field-status', 'parent', 'progress']);
  expect(synced.values['item-99']).toEqual({ 'field-blockers': 'acme/app#1', 'field-status': 'option-Blocked' });
  expect(new Set(synced.graphql.filter(request => request.operation === 'IntegrationUpdateItem').flatMap(request => Object.values(request.variables).map(value => (value as { itemId: string }).itemId)))).toEqual(new Set(['item-1', 'item-2', 'item-3', 'item-4', 'item-99']));
  await click('dialog', '閉じる'); await openItem(); await resetLog();

  await add(1, 4); await expect.poll(dialogStatus).toContain('表示用データも更新しました');
  const updated = await backend();
  expect(updated.blockers[4]).toEqual([3, 1]);
  expect(updated.values['item-4']!['field-blockers']).toBe('acme/app#1, acme/app#3');
  const refreshed = updated.graphql.filter(request => request.operation === 'IntegrationUpdateItem').flatMap(request => Object.values(request.variables).map(value => (value as { itemId: string }).itemId));
  expect(new Set(refreshed)).toEqual(new Set(['item-1', 'item-4']));
  expect(updated.graphql.some(request => ['IntegrationCreateField', 'IntegrationShowFields'].includes(request.operation))).toBe(false);

  await worker.evaluate(() => { (globalThis as typeof globalThis & FixtureScope).relationshipBackend.failedItem = 'item-4'; });
  await resetLog(); await remove(1, 4); await expect.poll(dialogStatus).toContain('標準フィールドの同期は未完了または未確認');
  const partial = await backend();
  expect(partial.blockers[4]).toEqual([3]);
  expect(partial.values['item-4']!['field-blockers']).toBe('acme/app#1, acme/app#3');
  expect(partial.rest.filter(request => request.method === 'DELETE')).toHaveLength(1);
  expect(await dialogStatus()).toContain('関係を GitHub に保存しました');
  await worker.evaluate(() => { const state = (globalThis as typeof globalThis & FixtureScope).relationshipBackend; state.failedItem = null; state.denyRestWrites = true; });
  await resetLog(); await add(0, 7); await expect.poll(dialogStatus).toContain('変更できません');
  const forbidden = await backend();
  expect(forbidden.blockers[1]).toEqual([]);
  expect(forbidden.rest.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(forbidden.graphql.some(request => request.mutation)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('relationships-write-error.png') });
});
