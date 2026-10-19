import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectBoard } from '../src/content/board-detector';
import { extractCards } from '../src/content/card-extractor';
import { route } from '../src/renderer/geometry';
import { SvgRenderer, OVERLAY_ID } from '../src/renderer/svg-renderer';
const url = 'https://github.com/orgs/acme/projects/1/views/1';
export function layout(): void {
 vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) { return [this.getBoundingClientRect()] as unknown as DOMRectList; });
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
   const n = [...document.querySelectorAll('article')].indexOf(this);
   return n < 0 ? new DOMRect(0, 0, 900, 600) : new DOMRect(30 + n * 150, 80, 120, 90);
 });
}
beforeEach(() => { document.documentElement.innerHTML = readFileSync('tests/fixtures/board.html', 'utf8'); layout(); });
describe('fixture DOM adapter (not a live GitHub DOM contract)', () => {
 it('requires a Project URL and a visible board root', () => {
   expect(detectBoard(document, url)?.id).toBe('board');
   expect(detectBoard(document, 'https://github.com/acme/app')).toBeNull();
   document.querySelector('#board')!.setAttribute('hidden', ''); expect(detectBoard(document, url)).toBeNull();
 });
 it('safely rejects table, roadmap, ambiguous and unknown markup', () => {
   const board = document.querySelector('#board')!;
   for (const value of ['table', 'roadmap', 'unknown']) { board.setAttribute('data-testid', value); expect(detectBoard(document, url)).toBeNull(); }
   board.setAttribute('data-testid', 'board-view'); document.body.append(board.cloneNode(true)); expect(detectBoard(document, url)).toBeNull();
 });
 it('extracts repository-qualified issues and skips drafts and PRs', () => {
   const cards = extractCards(detectBoard(document, url)!);
   expect(cards.map(c => `${c.issue.repo}#${c.issue.number}`)).toEqual(['app#1', 'api#1', 'app#3']);
 });
 it('keeps card identity when native fields reference other issues', () => {
   const board = detectBoard(document, url)!;
   const card = board.querySelector('article')!;
   const fields = document.createElement('ul'); fields.setAttribute('aria-label', 'Fields'); fields.dataset.testid = 'card-labels';
   fields.append(Object.assign(document.createElement('a'), { href: '/acme/app/issues/42', textContent: 'Parent issue' })); card.append(fields);
   expect(extractCards(board).map(c => `${c.issue.repo}#${c.issue.number}`)).toEqual(['app#1', 'api#1', 'app#3']);
 });
 it('skips ambiguous cards and offscreen cards and safely retains duplicate instances', () => {
   const board = detectBoard(document, url)!;
   const first = board.querySelector('article')!;
   first.append(Object.assign(document.createElement('a'), { href: '/acme/other/issues/8' }));
   expect(extractCards(board)).toHaveLength(2);
   first.lastElementChild!.remove(); board.append(first.cloneNode(true));
   expect(extractCards(board)).toHaveLength(4);
   first.getBoundingClientRect = () => new DOMRect(-400, 0, 100, 100); expect(extractCards(board)).toHaveLength(3);
 });
});
describe('SVG routing and ownership', () => {
 it('restores the complete overlay after the page removes its host', () => {
   const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
   const renderer = new SvgRenderer(); const cards = extractCards(detectBoard(document, url)!);
   const edges = [{ blocker: cards[0]!.issue, blocked: cards[1]!.issue }];
   renderer.render(cards, edges, new DOMRect(0, 0, 900, 600));
   document.getElementById(OVERLAY_ID)!.remove();
   renderer.render(cards, edges, new DOMRect(0, 0, 900, 600));
   const shadow = attach.mock.results[1]!.value as ShadowRoot;
   expect(shadow.querySelectorAll('g[data-edge-key]')).toHaveLength(1);
   expect(shadow.querySelector('.metric strong')!.textContent).toBe('1');
   renderer.destroy();
 });
 it('retains keyboard focus when selecting a dependency and clearing its highlight', () => {
   const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
   const renderer = new SvgRenderer(); const cards = extractCards(detectBoard(document, url)!);
   renderer.render(cards, [{ blocker: cards[0]!.issue, blocked: cards[1]!.issue }], new DOMRect(0, 0, 900, 600), { loading: true, incomplete: true });
   const shadow = attach.mock.results[0]!.value as ShadowRoot;
   const list = shadow.querySelector<HTMLDetailsElement>('.relations')!;
   expect(list.open).toBe(true);
   const button = list.querySelector('button')!; button.focus(); button.click();
   expect(button.querySelector('.dependency-sentence')!.textContent).toBe('api#1 は app#1 に依存');
   expect(button.querySelector('.dependency-identities')!.textContent).toBe('acme/app#1 → acme/api#1');
   expect(button.querySelector('.dependency-depth')!.textContent).toBe('深さ 0 → 1');
   expect(button.getAttribute('aria-label')).toBe('acme/api#1 は acme/app#1 に依存 · 深さ 0 → 1');
   expect(shadow.querySelector('text[data-dependency-pair]')!.textContent).toBe('app#1 → api#1');
   expect(shadow.querySelector('text[data-dependency-depth]')!.textContent).toBe('深さ 0 → 1');
   expect(shadow.activeElement).toBe(button);
   expect(button.getAttribute('aria-pressed')).toBe('true');
   const clear = shadow.querySelector<HTMLButtonElement>('.clear-edge')!;
   expect(clear.textContent).toBe('強調を解除');
   clear.focus(); clear.click();
   expect(button.getAttribute('aria-pressed')).toBe('false');
   expect(shadow.activeElement).toBe(button);
   expect(shadow.querySelector('.selected')!.textContent).toBe('一覧で依存を選ぶと、該当する矢印を強調します。');
   expect(shadow.querySelector('.note.warning')!.textContent).toContain('取得中の暫定値');
   expect(shadow.querySelector('.note.warning')!.textContent).toContain('解析は不完全');
   renderer.render(cards, [{ blocker: cards[0]!.issue, blocked: cards[1]!.issue }], new DOMRect(0, 0, 900, 600), { loading: false, incomplete: false });
   expect(list.querySelector('button')).toBe(button);
   expect(shadow.activeElement).toBe(button);
   renderer.destroy();
 });
 it('routes right, left and vertical with endpoints on card boundaries', () => {
   expect(route(new DOMRect(0, 0, 100, 100), new DOMRect(200, 0, 100, 100))).toBe('M 100 50 C 148.5 50, 148.5 50, 197 50');
   expect(route(new DOMRect(200, 0, 100, 100), new DOMRect(0, 0, 100, 100))).toMatch(/^M 200 50 .*103 50$/);
   expect(route(new DOMRect(0, 0, 100, 100), new DOMRect(0, 200, 100, 100))).toMatch(/^M 50 100 .*50 197$/);
 });
 it('has one overlay, reroutes moved cards, clears absent paths and cleans up', () => {
   const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
   const renderer = new SvgRenderer();
   const cards = extractCards(detectBoard(document, url)!);
   const edges = [{ blocker: cards[0]!.issue, blocked: cards[1]!.issue }];
   expect(renderer.render(cards, [...edges, ...edges], new DOMRect(0, 0, 900, 600))).toBe(1);
   const shadow = attach.mock.results[0]!.value as ShadowRoot;
   const path = shadow.querySelector('g path')!; const initial = path.getAttribute('d');
   renderer.render(cards, [...edges, ...edges], new DOMRect(0, 0, 900, 600));
   expect(shadow.querySelector('g path')).toBe(path);
   expect(path.getAttribute('marker-end')).toBe('url(#dependency-arrow)');
   cards[1]!.rect = new DOMRect(700, 100, 100, 90); renderer.render(cards, edges, new DOMRect(0, 0, 900, 600));
   expect(shadow.querySelector('g path')!.getAttribute('d')).not.toBe(initial);
   expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
   expect((document.querySelector(`#${OVERLAY_ID}`) as HTMLElement).style.pointerEvents).toBe('none');
   renderer.render([], edges, new DOMRect(0, 0, 900, 600)); expect(shadow.querySelectorAll('g path')).toHaveLength(0);
   renderer.destroy(); expect(document.getElementById(OVERLAY_ID)).toBeNull();
 });
});

describe('observed GitHub Board structure with synthetic issue identities', () => {
 beforeEach(() => { document.documentElement.innerHTML = readFileSync('tests/fixtures/github-board-observed.html', 'utf8'); });
 it('detects the Board DnD root and role=button issue links without test IDs', () => {
   const board = detectBoard(document, url)!;
   expect(board.id).toBe('project-items-region');
   expect(document.querySelectorAll('[data-testid]')).toHaveLength(0);
   expect(extractCards(board).map(c => c.issue)).toEqual([
     { owner: 'acme', repo: 'app', number: 1 },
     { owner: 'acme', repo: 'api', number: 1 },
     { owner: 'acme', repo: 'app', number: 3 }
   ]);
 });
 it('does not treat the shared project-items-region ID as a Board in Table or Roadmap', () => {
   const board = document.getElementById('project-items-region')!;
   board.removeAttribute('data-dnd-drop-id'); board.removeAttribute('data-dnd-drop-type'); board.setAttribute('role', 'grid');
   expect(detectBoard(document, url)).toBeNull();
   board.setAttribute('role', 'region'); expect(detectBoard(document, url)).toBeNull();
 });
 it('does not infer issue identities from disabled virtualized placeholders', () => {
   const board = detectBoard(document, url)!;
   expect(extractCards(board).some(c => c.issue.number === 4)).toBe(false);
   const card = board.querySelector('[data-board-card-id="104"]')!;
   card.setAttribute('aria-disabled', 'false');
   const anchor = document.createElement('a'); anchor.href = 'https://github.com/acme/app/issues/4'; anchor.setAttribute('role', 'button'); card.append(anchor);
   expect(extractCards(board).map(c => c.issue.number)).toContain(4);
   anchor.remove(); expect(extractCards(board).map(c => c.issue.number)).not.toContain(4);
 });
});
