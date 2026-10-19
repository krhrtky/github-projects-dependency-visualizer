import { chromium, test, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

async function shadowCall<T>(kind: 'item' | 'toolbar' | 'dialog', functionDeclaration: string, values: unknown[] = []): Promise<T> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const pending = [root as DomNode];
  const host = (() => {
    for (let index = 0; index < pending.length; index++) {
      const node = pending[index]!; const attributes = node.attributes ?? [];
      const attribute = attributes.indexOf(ownerAttribute);
      if (attribute !== -1 && attributes[attribute + 1] === kind) return node;
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
    const button = [...this.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label);
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
