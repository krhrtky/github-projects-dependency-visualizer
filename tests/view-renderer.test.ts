import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '../src/content/card-extractor';
import { edgeKey, type Dependency } from '../src/domain/graph';
import { issueKey } from '../src/domain/issue';
import { routeEdges } from '../src/renderer/geometry';
import { SvgRenderer, OVERLAY_ID } from '../src/renderer/svg-renderer';

const bounds = new DOMRect(0, 0, 800, 500);
const items = (): BoardCard[] => Array.from({ length: 5 }, (_, index) => ({ issue: { owner: 'acme', repo: 'app', number: index + 1 }, element: document.createElement('article'), rect: new DOMRect(96, 20 + index * 56, 320, 24) }));
const relation = (cards: BoardCard[], from: number, to: number): Dependency => ({ blocker: cards[from - 1]!.issue, blocked: cards[to - 1]!.issue });
let renderer: SvgRenderer;
let shadow: ShadowRoot;
let shadows: ShadowRoot[];

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  shadows = [];
  const attach = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options: ShadowRootInit) {
    const root = attach.call(this, options); shadows.push(root); return root;
  });
  renderer = new SvgRenderer(); renderer.mount(); shadow = shadows[0]!;
});
afterEach(() => renderer.destroy());

describe('view-aware dependency overlay', () => {
  it('invalidates cached routes and clears row badges when the same geometry changes layout', () => {
    const cards = items().slice(0, 2).map(card => ({ ...card, rect: new DOMRect(0, card.rect.top, 800, card.rect.height) }));
    const edges = [relation(cards, 1, 2)];
    const path = (): string => shadow.querySelector('g[data-edge-key] path')!.getAttribute('d')!;
    const badgeCount = (): number => shadow.querySelector('svg')!.lastElementChild!.children.length;
    renderer.render(cards, edges, bounds);
    const board = path(); expect(badgeCount()).toBe(2);
    expect(shadow.querySelector('svg')!.lastElementChild!.textContent).toContain('依存の深さ 0 · 前提 0 · 後続 1');
    for (const layout of ['table', 'roadmap'] as const) {
      renderer.render(cards, edges, bounds, { layout });
      const expected = routeEdges([{ key: edgeKey(edges[0]!), from: cards[0]!.rect, to: cards[1]!.rect }], { bounds, cards: cards.map(card => card.rect), layout });
      expect(path()).toBe(expected[0]!.path);
      expect(path()).not.toBe(board);
      expect(badgeCount()).toBe(0);
    }
    renderer.render(cards, edges, bounds, { layout: 'board' });
    expect(path()).toBe(board); expect(badgeCount()).toBe(2);
  });

  it('explains dependency notation in every view and uses view-specific item terminology', () => {
    const cards = items(); const edges = [relation(cards, 1, 2)];
    for (const layout of ['table', 'roadmap', 'board'] as const) {
      renderer.render(cards, edges, bounds, { layout });
      const unit = layout === 'board' ? 'カード' : '項目';
      const panel = shadow.querySelector('.panel')!;
      expect(panel.textContent).toContain(`5 ${unit} / 1 本の依存線`);
      expect(panel.textContent).toContain(`分岐${unit}`); expect(panel.textContent).toContain(`合流${unit}`);
      expect(panel.textContent).toContain(`${unit}から上流・下流をたどる`);
      if (layout !== 'board') {
        expect(panel.textContent).not.toContain('カード');
      }
      expect(shadow.querySelector('.selected')!.textContent).toBe('一覧で依存を選ぶと、該当する矢印を強調します。');
      const guide = shadow.querySelector('.reading-guide')!;
      expect(guide.textContent).toContain('矢印の先の Issue が、手前の Issue に依存します。');
      expect(guide.textContent).toContain('A → B は「B が A に依存」');
      expect(guide.textContent).not.toContain('関係 01');
      const details = shadow.querySelector<HTMLDetailsElement>('.analysis-details')!;
      expect(details.open).toBe(false);
      expect(details.querySelectorAll('.metric')).toHaveLength(3);
      expect(details.textContent).toContain('A → B → C なら、深さは 0 → 1 → 2。');
      expect(shadow.querySelector<HTMLDetailsElement>('.relations')!.open).toBe(true);
      expect(shadow.querySelector('.relations summary')!.textContent).toBe('依存の一覧 (1 本)');
      expect([...shadow.querySelectorAll('.filters button')].map(button => button.textContent)).toEqual(['すべての依存', '最長経路のみ']);
      expect(shadow.querySelector('select option')!.textContent).toBe(`すべての${unit}`);
      expect(shadow.querySelector('.eyebrow')!.textContent).toContain({ table: 'Table', roadmap: 'Roadmap', board: 'Board' }[layout]);
    }
  });

  it('keeps depth, unique downstream impact, longest-path filtering and keyboard relation selection available for rows', () => {
    const cards = items();
    const edges = [relation(cards, 1, 2), relation(cards, 2, 3), relation(cards, 1, 3), relation(cards, 4, 5)];
    renderer.render(cards, edges, bounds, { layout: 'table' });
    const select = shadow.querySelector('select')!;
    expect(select.options[1]!.textContent).toBe('acme/app#1 · 前提 0 件 / 後続 2 件');
    select.value = issueKey(cards[0]!.issue); select.dispatchEvent(new Event('change'));
    expect(shadow.querySelector('.panel')!.textContent).toContain('依存の深さ 0 · 前提 0 件 / 後続 2 件 · 下流の影響先 2 件');
    expect(shadow.querySelector(`[data-edge-key="${edgeKey(edges[3]!)}"]`)!.getAttribute('opacity')).toBe('.12');
    shadow.querySelectorAll<HTMLButtonElement>('.filters button')[1]!.click();
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(2);
    expect([...shadow.querySelectorAll('text[data-dependency-pair]')].map(text => text.textContent)).toEqual(['#1 → #2', '#2 → #3']);
    expect([...shadow.querySelectorAll('text[data-dependency-depth]')].map(text => text.textContent)).toEqual(['深さ 0 → 1', '深さ 1 → 2']);
    const relations = shadow.querySelector<HTMLDetailsElement>('.relations')!;
    const secondDependency = relations.querySelector<HTMLButtonElement>(`button[data-edge="${edgeKey(edges[1]!)}"]`)!;
    expect(secondDependency.querySelector('.dependency-sentence')!.textContent).toBe('#3 は #2 に依存');
    expect(secondDependency.querySelector('.dependency-identities')!.textContent).toBe('acme/app#2 → acme/app#3');
    expect(secondDependency.querySelector('.dependency-depth')!.textContent).toBe('深さ 1 → 2');
    expect(secondDependency.getAttribute('aria-label')).toBe('acme/app#3 は acme/app#2 に依存 · 深さ 1 → 2');
    const button = [...relations.querySelectorAll('button')].find(button => button.dataset.edge === edgeKey(edges[3]!))!;
    button.focus(); button.click();
    expect(shadow.activeElement).toBe(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(4);
    expect(select.value).toBe('');
    expect(shadow.querySelector('.selected')!.textContent).toBe('#5 は #4 に依存 · 深さ 0 → 1');
    button.click(); expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(shadow.activeElement).toBe(button);
  });

  it('uses issue identities to distinguish equal issue numbers across repositories and owners', () => {
    const cards = items().slice(0, 2).map(card => ({ ...card, rect: new DOMRect(300, card.rect.top, card.rect.width, card.rect.height) }));
    cards[1]!.issue = { owner: 'acme', repo: 'api', number: 1 };
    renderer.render(cards, [relation(cards, 1, 2)], bounds, { layout: 'table' });
    expect(shadow.querySelector('text[data-dependency-pair]')!.textContent).toBe('app#1 → api#1');
    expect(shadow.querySelector('.dependency-sentence')!.textContent).toBe('api#1 は app#1 に依存');
    expect(shadow.querySelector('.relations button')!.getAttribute('aria-label')).toBe('acme/api#1 は acme/app#1 に依存 · 深さ 0 → 1');

    cards[1]!.issue = { owner: 'other', repo: 'app', number: 1 };
    renderer.render(cards, [relation(cards, 1, 2)], bounds, { layout: 'table' });
    expect(shadow.querySelector('text[data-dependency-pair]')!.textContent).toBe('acme/app#1 → other/app#1');
    expect(shadow.querySelector('.dependency-sentence')!.textContent).toBe('other/app#1 は acme/app#1 に依存');
    expect(shadow.querySelector('.dependency-identities')!.textContent).toBe('acme/app#1 → other/app#1');
  });

  it('qualifies line labels against every visible issue, including an unconnected repository', () => {
    const cards = items().slice(0, 3);
    cards[2]!.issue = { owner: 'acme', repo: 'api', number: 1 };
    const edges = [relation(cards, 1, 2)];
    renderer.render(cards, edges, bounds, { layout: 'table' });
    const label = shadow.querySelector('g[data-dependency-label]')!;
    expect(label.getAttribute('data-dependency-label')).toBe(edgeKey(edges[0]!));
    expect(label.querySelector('text[data-dependency-pair]')!.textContent).toBe('app#1 → app#2');
    expect(shadow.querySelector('.dependency-sentence')!.textContent).toBe('app#2 は app#1 に依存');
  });

  it.each([
    [{}, '表示中の Issue 間に依存はありません。'],
    [{ loading: true }, '依存を取得しています…'],
    [{ incomplete: true }, '取得できた範囲に依存はありません。'],
  ])('explains an empty dependency list with fetch state %j', (context, message) => {
    renderer.render(items(), [], bounds, { layout: 'table', ...context });
    expect(shadow.querySelector('.relations')!.textContent).toContain(message);
    expect(shadow.querySelectorAll('.relations button')).toHaveLength(0);
    expect(shadow.querySelectorAll('g[data-dependency-label]')).toHaveLength(0);
  });

  it('retains cycle and partial-fetch warnings using item terminology', () => {
    const cards = items().slice(0, 3).map(card => ({ ...card, anchor: 'title' as const }));
    renderer.render(cards, [relation(cards, 1, 2), relation(cards, 2, 1), relation(cards, 2, 3)], bounds, { layout: 'roadmap', loading: true, incomplete: true });
    expect(shadow.querySelector('.panel')!.textContent).toContain('循環 2 項目');
    const warning = shadow.querySelector('.note.warning')!;
    expect(warning.textContent).toContain('循環を解消するまで');
    expect(warning.textContent).toContain('取得中の暫定値');
    expect(warning.textContent).toContain('解析は不完全');
    expect(shadow.querySelectorAll<HTMLButtonElement>('.filters button')[1]!.disabled).toBe(true);
    const select = shadow.querySelector('select')!; select.value = issueKey(cards[0]!.issue); select.dispatchEvent(new Event('change'));
    expect(shadow.querySelector('.panel')!.textContent).toContain('依存の深さ 未算出 · 前提 1 件 / 後続 1 件 · 下流の影響先 2 件');
    expect([...shadow.querySelectorAll('text[data-dependency-depth]')].map(text => text.textContent)).toEqual(['深さ 未算出', '深さ 未算出', '深さ 未算出']);
    expect([...shadow.querySelectorAll('.dependency-depth')].map(text => text.textContent)).toEqual(['深さ 未算出', '深さ 未算出', '深さ 未算出']);
  });

  it('shows both endpoint depths on a dependency that skips an intermediate depth', () => {
    const cards = items().slice(0, 3);
    const edges = [relation(cards, 1, 2), relation(cards, 2, 3), relation(cards, 1, 3)];
    renderer.render(cards, edges, bounds, { layout: 'table' });
    const shortcut = shadow.querySelector(`g[data-dependency-label="${edgeKey(edges[2]!)}"]`)!;
    expect(shortcut.querySelector('text[data-dependency-pair]')!.textContent).toBe('#1 → #3');
    expect(shortcut.querySelector('text[data-dependency-depth]')!.textContent).toBe('深さ 0 → 2');
    const button = shadow.querySelector<HTMLButtonElement>(`.relations button[data-edge="${edgeKey(edges[2]!)}"]`)!;
    expect(button.querySelector('.dependency-depth')!.textContent).toBe('深さ 0 → 2');
    button.click();
    expect(shadow.querySelector('.selected')!.textContent).toBe('#3 は #1 に依存 · 深さ 0 → 2');
  });

  it('rebuilds view-specific controls after removal and destroy without restoring row badges', () => {
    const cards = items().slice(0, 2); const edges = [relation(cards, 1, 2)];
    renderer.render(cards, edges, bounds, { layout: 'table' });
    document.getElementById(OVERLAY_ID)!.remove();
    renderer.render(cards, edges, bounds, { layout: 'table' });
    shadow = shadows.at(-1)!;
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(1);
    expect(shadow.querySelector('.eyebrow')!.textContent).toContain('Table');
    expect(shadow.querySelector('svg')!.lastElementChild!.children).toHaveLength(0);
    renderer.destroy(); renderer.render(cards, edges, bounds, { layout: 'roadmap' });
    shadow = shadows.at(-1)!;
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
    expect(shadow.querySelector('.eyebrow')!.textContent).toContain('Roadmap');
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(1);
    expect(shadow.querySelector('svg')!.lastElementChild!.children).toHaveLength(0);
  });

  it('reroutes identical roadmap rectangles when explicit title or bar anchors change', () => {
    const cards = items().slice(0, 2).map((card, index) => ({ ...card, rect: new DOMRect(27, 337 + index * 76, 439, 76), anchor: 'title' as 'title' | 'bar' }));
    const edges = [relation(cards, 1, 2)];
    const viewBounds = new DOMRect(27, 260, 1387, 526);
    const path = (): string => shadow.querySelector('g[data-edge-key] path')!.getAttribute('d')!;
    renderer.render(cards, edges, viewBounds, { layout: 'roadmap' });
    const titlePath = path();
    expect(titlePath).toMatch(/^M 466 /); expect(titlePath).not.toContain(' C ');
    cards[0]!.anchor = 'bar';
    renderer.render(cards, edges, viewBounds, { layout: 'roadmap' });
    expect(path()).not.toBe(titlePath); expect(path()).toContain(' C ');
    cards[0]!.anchor = 'title';
    renderer.render(cards, edges, viewBounds, { layout: 'roadmap' });
    expect(path()).toBe(titlePath);
  });
});
