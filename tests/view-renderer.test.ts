import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '../src/content/card-extractor';
import { edgeKey, type Dependency } from '../src/domain/graph';
import { issueKey } from '../src/domain/issue';
import { routeEdges } from '../src/renderer/geometry';
import { SvgRenderer, OVERLAY_ID } from '../src/renderer/svg-renderer';

const bounds = new DOMRect(0, 0, 800, 500);
const items = (): BoardCard[] => Array.from({ length: 5 }, (_, index) => ({ issue: { owner: 'acme', repo: 'app', number: index + 1 }, element: document.createElement('article'), rect: new DOMRect(0, 20 + index * 40, 800, 24) }));
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
    const cards = items().slice(0, 2);
    const edges = [relation(cards, 1, 2)];
    const path = (): string => shadow.querySelector('g[data-edge-key] path')!.getAttribute('d')!;
    const badgeCount = (): number => shadow.querySelector('svg')!.lastElementChild!.children.length;
    renderer.render(cards, edges, bounds);
    const board = path(); expect(badgeCount()).toBe(2);
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

  it('uses view-specific item terminology and preserves Board card terminology', () => {
    const cards = items(); const edges = [relation(cards, 1, 2)];
    for (const layout of ['table', 'roadmap'] as const) {
      renderer.render(cards, edges, bounds, { layout });
      const panel = shadow.querySelector('.panel')!;
      expect(panel.textContent).toContain('5 項目 / 1 関係');
      expect(panel.textContent).toContain('分岐項目'); expect(panel.textContent).toContain('合流項目');
      expect(panel.textContent).toContain('項目から上流・下流をたどる');
      expect(panel.textContent).toContain('下流の影響先を表示');
      expect(panel.textContent).not.toContain('カード');
      expect(shadow.querySelector('select option')!.textContent).toBe('すべての項目');
      expect(shadow.querySelector('.eyebrow')!.textContent).toContain(layout === 'table' ? 'Table' : 'Roadmap');
    }
    renderer.render(cards, edges, bounds);
    expect(shadow.querySelector('.panel')!.textContent).toContain('5 カード / 1 関係');
    expect(shadow.querySelector('select option')!.textContent).toBe('すべてのカード');
    expect(shadow.querySelector('.eyebrow')!.textContent).toContain('Board');
  });

  it('keeps depth, unique downstream impact, longest-path filtering and keyboard relation selection available for rows', () => {
    const cards = items();
    const edges = [relation(cards, 1, 2), relation(cards, 2, 3), relation(cards, 1, 3), relation(cards, 4, 5)];
    renderer.render(cards, edges, bounds, { layout: 'table' });
    const select = shadow.querySelector('select')!;
    select.value = issueKey(cards[0]!.issue); select.dispatchEvent(new Event('change'));
    expect(shadow.querySelector('.panel')!.textContent).toContain('深さ 0 · 直接の入 0 / 出 2 · 下流の影響先 2 件');
    expect(shadow.querySelector(`[data-edge-key="${edgeKey(edges[3]!)}"]`)!.getAttribute('opacity')).toBe('.12');
    shadow.querySelectorAll<HTMLButtonElement>('.filters button')[1]!.click();
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(2);
    const relations = shadow.querySelector<HTMLDetailsElement>('.relations')!; relations.open = true;
    const button = [...relations.querySelectorAll('button')].find(button => button.dataset.edge === edgeKey(edges[3]!))!;
    button.focus(); button.click();
    expect(shadow.activeElement).toBe(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(4);
    expect(select.value).toBe('');
    button.click(); expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(shadow.activeElement).toBe(button);
  });

  it('retains cycle and partial-fetch warnings using item terminology', () => {
    const cards = items().slice(0, 3);
    renderer.render(cards, [relation(cards, 1, 2), relation(cards, 2, 1), relation(cards, 2, 3)], bounds, { layout: 'roadmap', loading: true, incomplete: true });
    expect(shadow.querySelector('.panel')!.textContent).toContain('循環 2 項目');
    const warning = shadow.querySelector('.note.warning')!;
    expect(warning.textContent).toContain('循環を解消するまで');
    expect(warning.textContent).toContain('取得中の暫定値');
    expect(warning.textContent).toContain('解析は不完全');
    expect(shadow.querySelectorAll<HTMLButtonElement>('.filters button')[1]!.disabled).toBe(true);
    const select = shadow.querySelector('select')!; select.value = issueKey(cards[0]!.issue); select.dispatchEvent(new Event('change'));
    expect(shadow.querySelector('.panel')!.textContent).toContain('深さ 未算出 · 直接の入 1 / 出 1 · 下流の影響先 2 件');
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
