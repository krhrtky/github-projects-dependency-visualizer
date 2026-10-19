import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '../src/content/card-extractor';
import { appendNativeFilter, applyNativeFilter, nativeFilterUrl, readNativeFilter } from '../src/content/native-project-controls';
import type { IssueRelationships } from '../src/domain/relationships';
import { parseRelationshipIssue, RelationshipControls, RELATIONSHIPS_ATTRIBUTE } from '../src/renderer/relationship-controls';

const issue = (number: number) => ({ owner: 'acme', repo: 'app', number });
const empty = (): IssueRelationships => ({ blockedBy: [], blocking: [], parent: null, children: [] });
let controls: RelationshipControls;
let changed: ReturnType<typeof vi.fn<() => void>>;
let sendMessage: ReturnType<typeof vi.fn>;
let shadows: Map<Element, ShadowRoot>;
let cards: BoardCard[];
const rootFor = (kind: string): ShadowRoot => shadows.get(document.querySelector(`[${RELATIONSHIPS_ATTRIBUTE}="${kind}"]`)!)!;
const clickByText = (root: ShadowRoot, text: string): HTMLButtonElement => {
  const button = [...root.querySelectorAll('button')].find(button => button.textContent === text)!;
  expect(button).toBeDefined(); button.click(); return button;
};
async function settled(): Promise<void> { for (let count = 0; count < 5; count++) await Promise.resolve(); }

beforeEach(() => {
  history.replaceState({}, '', '/orgs/acme/projects/1/views/2');
  document.body.innerHTML = '<input id="filter-bar-component" value="status:Todo"><main data-testid="board-view"><article><a href="/acme/app/issues/1">One</a></article><article><a href="/acme/app/issues/2">Two</a></article></main>';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  shadows = new Map();
  const attach = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function(this: HTMLElement, options: ShadowRootInit) {
    const shadow = attach.call(this, options); shadows.set(this, shadow); return shadow;
  });
  cards = [...document.querySelectorAll('article')].map((element, index) => ({ issue: issue(index + 1), element, rect: new DOMRect(0, 0, 100, 100) }));
  sendMessage = vi.fn(async () => ({ ok: true, data: empty() }));
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  changed = vi.fn(); controls = new RelationshipControls(changed); controls.update(cards);
});
afterEach(() => { controls.destroy(); vi.unstubAllGlobals(); });

describe('GitHub native filters', () => {
  it('preserves existing filters and URL settings, and groups OR expressions before adding an AND condition', () => {
    expect(appendNativeFilter('status:Todo', 'is:blocked')).toBe('status:Todo is:blocked');
    expect(appendNativeFilter('status:Todo OR label:bug', 'is:blocked')).toBe('(status:Todo OR label:bug) is:blocked');
    expect(appendNativeFilter('title:"OR label"', 'is:blocking')).toBe('title:"OR label" is:blocking');
    const url = new URL(nativeFilterUrl('https://github.com/orgs/acme/projects/1/views/2?layout=table&visibleFields=%5B%22Title%22%5D', 'parent-issue:"acme/app#2"'));
    expect(url.searchParams.get('filterQuery')).toBe('parent-issue:"acme/app#2"');
    expect(url.searchParams.get('layout')).toBe('table');
    expect(url.searchParams.get('visibleFields')).toBe('["Title"]');
  });
  it('updates the native controlled input and raises input events', () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    const changedInput = vi.fn(); input.addEventListener('input', changedInput);
    applyNativeFilter('blocked-by:"acme/app#1"');
    expect(input.value).toBe('status:Todo blocked-by:"acme/app#1"');
    expect(changedInput).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(input);
  });
  it('preserves the saved view filter when the native input is unavailable', () => {
    document.querySelector('input')!.remove();
    const views = document.createElement('script'); views.id = 'memex-views'; views.type = 'application/json';
    views.textContent = JSON.stringify([{ number: 1, filter: 'is:open' }, { number: 2, filter: 'label:bug OR label:feature' }]); document.body.append(views);
    expect(readNativeFilter(document, location.href)).toBe('label:bug OR label:feature');
    expect(readNativeFilter(document, `${location.href}?filterQuery=`)).toBe('');
  });
});

describe('relationship controls', () => {
  it('reports host and toolbar layout changes while keeping identity-only updates stable', () => {
    expect(controls.update(cards)).toBe(false);
    expect(controls.update([{ ...cards[0]!, issue: issue(9) }, cards[1]!])).toBe(false);
    expect(controls.update([cards[0]!])).toBe(true);
    expect(controls.update([cards[0]!])).toBe(false);
    expect(controls.update(cards)).toBe(true);
    document.querySelector(`[${RELATIONSHIPS_ATTRIBUTE}="toolbar"]`)!.remove();
    expect(controls.update(cards)).toBe(true);
    expect(controls.update(cards)).toBe(false);
    document.querySelector('main')!.removeAttribute('data-testid');
    expect(controls.update([])).toBe(true);
    expect(controls.update([])).toBe(false);
    document.querySelector('main')!.setAttribute('data-testid', 'board-view');
    expect(controls.update([])).toBe(true);
    expect(controls.update([])).toBe(false);
  });
  it('keeps a recycled row bound to its current issue, contains card events, and cleans up every host', async () => {
    const first = rootFor('item'); const itemButton = first.querySelector('button')!;
    const click = vi.fn(); cards[0]!.element.addEventListener('click', click);
    controls.update([{ ...cards[0]!, issue: issue(9) }, cards[1]!]);
    expect(document.querySelectorAll(`[${RELATIONSHIPS_ATTRIBUTE}="item"]`)).toHaveLength(2);
    itemButton.click(); await settled();
    expect(click).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'RELATIONSHIPS', issue: issue(9) });
    expect(rootFor('dialog').querySelector('h2')!.textContent).toContain('acme/app#9');
    expect(document.querySelector('main')!.previousElementSibling!.getAttribute(RELATIONSHIPS_ATTRIBUTE)).toBe('toolbar');
    controls.destroy(); expect(document.querySelectorAll(`[${RELATIONSHIPS_ATTRIBUTE}]`)).toHaveLength(0);
  });
  it('shows canonical relations and edits each relation through the background message contract', async () => {
    const relationships = { ...empty(), blockedBy: [issue(3)], parent: issue(8), children: [issue(4)] };
    sendMessage.mockImplementation(async (message: { type: string }) => ({ ok: true, data: message.type === 'RELATIONSHIPS' ? relationships : { changed: true } }));
    rootFor('item').querySelector('button')!.click(); await settled();
    const dialog = rootFor('dialog');
    expect(dialog.querySelectorAll('section')).toHaveLength(4);
    expect(dialog.querySelector('a')!.getAttribute('href')).toBe('https://github.com/acme/app/issues/3');
    expect(dialog.textContent).toContain('画面外の Issue も含みます');
    const parent = dialog.querySelectorAll('section')[2]!;
    expect(parent.querySelector('input')!.disabled).toBe(true);
    const remove = dialog.querySelector<HTMLButtonElement>('button[aria-label="acme/app#3 の Blocked by · 前提 を解除"]')!;
    remove.click(); await settled();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'CHANGE_RELATIONSHIP', change: { issue: issue(1), related: issue(3), kind: 'blockedBy', action: 'remove' }, project: { kind: 'orgs', owner: 'acme', number: 1, view: 2 } });
    expect(changed).toHaveBeenCalledOnce();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('関係を GitHub に保存しました');
  });
  it('validates issue references and prevents duplicate writes while a save is pending', async () => {
    let finish: (value: unknown) => void = () => {};
    sendMessage.mockImplementation((message: { type: string }) => message.type === 'CHANGE_RELATIONSHIP' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, data: empty() }));
    rootFor('item').querySelector('button')!.click(); await settled();
    const dialog = rootFor('dialog'); const form = dialog.querySelector('form')!; const input = form.querySelector('input')!;
    input.value = 'https://attacker.example/acme/app/issues/2'; form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CHANGE_RELATIONSHIP')).toHaveLength(0);
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('別の Issue');
    input.value = 'acme/app#7'; form.dispatchEvent(new Event('submit', { cancelable: true })); form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CHANGE_RELATIONSHIP')).toHaveLength(1);
    expect(input.disabled).toBe(true); expect(changed).not.toHaveBeenCalled();
    finish({ ok: true, data: { changed: true } }); await settled(); expect(changed).toHaveBeenCalledOnce();
    expect(dialog.querySelector('input')!.disabled).toBe(false);
  });
  it('uses native relationship filters and restores keyboard focus after closing', async () => {
    const trigger = rootFor('item').querySelector('button')!;
    trigger.click(); await settled(); const dialog = rootFor('dialog');
    const firstSection = dialog.querySelector('section')!;
    firstSection.querySelector<HTMLButtonElement>('.filter')!.click();
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('status:Todo blocking:"acme/app#1"');
    expect(document.querySelector(`[${RELATIONSHIPS_ATTRIBUTE}="dialog"]`)).toBeNull();
    trigger.click(); await settled(); clickByText(rootFor('dialog'), '閉じる');
    expect(rootFor('item').activeElement).toBe(trigger);
  });
  it('reports read and write failures without treating them as empty relationships or successful changes', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN' } });
    rootFor('item').querySelector('button')!.click(); await settled();
    expect(rootFor('dialog').querySelector('[role="status"]')!.textContent).toContain('権限');
    expect(rootFor('dialog').querySelectorAll('section')).toHaveLength(0);
    expect(changed).not.toHaveBeenCalled();
    clickByText(rootFor('dialog'), '閉じる');
    rootFor('item').querySelector('button')!.click(); await settled();
    sendMessage.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN' } });
    const dialog = rootFor('dialog'); const form = dialog.querySelector('form')!; form.querySelector('input')!.value = 'acme/app#7';
    form.dispatchEvent(new Event('submit', { cancelable: true })); await settled();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('Issues: Read and write');
    expect(changed).not.toHaveBeenCalled(); expect(form.querySelector('input')!.disabled).toBe(false);
  });
  it.each([
    { changed: true, syncError: { code: 'WRITE_FORBIDDEN' } },
    { changed: true, sync: { failed: [{ issue: issue(2), error: { code: 'NETWORK' } }] } },
  ])('keeps canonical success distinct from a mirror refresh failure and never repeats the write', async report => {
    sendMessage.mockImplementation(async (message: { type: string }) => ({ ok: true, data: message.type === 'RELATIONSHIPS' ? empty() : report }));
    rootFor('item').querySelector('button')!.click(); await settled();
    const dialog = rootFor('dialog'); const form = dialog.querySelector('form')!;
    form.querySelector('input')!.value = 'acme/app#7'; form.dispatchEvent(new Event('submit', { cancelable: true })); await settled();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('関係を GitHub に保存しました');
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('標準フィールドの同期は未完了または未確認');
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CHANGE_RELATIONSHIP')).toHaveLength(1);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('keeps a successful write visible when reloading its relationship list fails', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, data: empty() }).mockResolvedValueOnce({ ok: true, data: { changed: true } }).mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK' } });
    rootFor('item').querySelector('button')!.click(); await settled();
    const dialog = rootFor('dialog'); const form = dialog.querySelector('form')!;
    form.querySelector('input')!.value = 'acme/app#7'; form.dispatchEvent(new Event('submit', { cancelable: true })); await settled();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('関係を GitHub に保存しました');
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('保存後の一覧を取得できません');
    expect(changed).toHaveBeenCalledOnce();
    expect([...dialog.querySelectorAll('section input,section button')].every(control => (control as HTMLInputElement).disabled)).toBe(true);
    form.dispatchEvent(new Event('submit', { cancelable: true })); await settled();
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CHANGE_RELATIONSHIP')).toHaveLength(1);
    sendMessage.mockResolvedValueOnce({ ok: true, data: { ...empty(), blockedBy: [issue(7)] } });
    clickByText(dialog, '関係を再取得'); await settled();
    expect(dialog.querySelector('a')!.textContent).toBe('acme/app#7');
    expect(dialog.querySelector('input')!.disabled).toBe(false);
    expect(dialog.querySelector('[data-retry]')).toBeNull();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('関係を GitHub に保存しました');
  });
  it('previews concrete project changes before allowing sync and offers reload after completion', async () => {
    const preview = { project: { kind: 'orgs', owner: 'acme', number: 1, view: 2 }, projectId: 'PVT_1', issueCount: 14, skipped: 2, fieldsToCreate: ['Relationship blockers', 'Relationship blocking', 'Relationship status'], fieldsToShow: ['Parent issue', 'Sub-issues progress', 'Relationship blockers'] };
    sendMessage.mockImplementation(async (message: { type: string }) => ({ ok: true, data: message.type === 'PROJECT_PREVIEW' ? preview : { ...preview, createdFields: preview.fieldsToCreate, changed: 12, failed: [] } }));
    clickByText(rootFor('toolbar'), '標準フィールドに同期'); await settled();
    const dialog = rootFor('dialog');
    expect(dialog.textContent).toContain('14 Issue'); expect(dialog.textContent).toContain('作成するフィールド: Relationship blockers');
    expect(dialog.textContent).toContain('セルの文字列を直接編集しても Issue の関係は変わりません');
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['PROJECT_PREVIEW']);
    clickByText(dialog, '同期を実行'); await settled();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'PROJECT_SYNC', project: preview.project });
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain('12 Issue を更新');
    expect(dialog.textContent).toContain('ページを再読み込み'); expect(changed).toHaveBeenCalledOnce();
  });
  it('does not reopen or append a dialog after a pending lookup finishes after destroy', async () => {
    let finish: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    rootFor('item').querySelector('button')!.click(); controls.destroy();
    finish({ ok: true, data: empty() }); await settled();
    expect(document.querySelectorAll(`[${RELATIONSHIPS_ATTRIBUTE}]`)).toHaveLength(0);
  });
  it('adds row actions within the title cell without adding native grid columns', () => {
    const row = document.createElement('div'); row.setAttribute('role', 'row');
    row.innerHTML = '<div role="rowheader"><a href="/acme/app/issues/4">Four</a></div><div role="gridcell">Todo</div>';
    document.querySelector('main')!.replaceChildren(row);
    controls.update([{ issue: issue(4), element: row, rect: new DOMRect(0, 0, 100, 40) }]);
    expect(row.children).toHaveLength(2);
    expect(row.querySelector('[role="rowheader"]')!.lastElementChild!.getAttribute(RELATIONSHIPS_ATTRIBUTE)).toBe('item');
    expect(document.querySelectorAll(`[${RELATIONSHIPS_ATTRIBUTE}="item"]`)).toHaveLength(1);
  });
  it('accepts repository-qualified issue references and rejects malformed or non-GitHub targets', () => {
    expect(parseRelationshipIssue(' acme/app#123 ')).toEqual(issue(123));
    expect(parseRelationshipIssue('https://github.com/acme/app/issues/9')).toEqual(issue(9));
    for (const value of ['#123', 'acme/app#0', 'https://example.com/acme/app/issues/1', 'acme/app#1 trailing', 'acme/app#99999999999999999']) expect(parseRelationshipIssue(value)).toBeNull();
  });
});
