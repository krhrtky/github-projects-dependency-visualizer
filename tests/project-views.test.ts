import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectBoard, detectProjectView } from '../src/content/board-detector';
import { extractCards, projectViewRect } from '../src/content/card-extractor';

const projectUrl = 'https://github.com/orgs/acme/projects/1/views/2';
function loadFixture(name: 'table' | 'roadmap'): HTMLElement {
  document.documentElement.innerHTML = readFileSync(`tests/fixtures/${name}.html`, 'utf8');
  return document.getElementById('project-items-region')!;
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const values = this.dataset.rect?.split(',').map(Number);
    if (values?.length === 4) return new DOMRect(values[0], values[1], values[2], values[3]);
    return this.matches('[role="rowheader"]') ? new DOMRect(86, 540, 440, 64) : new DOMRect(0, 0, 100, 30);
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
});

describe('Project Table adapter', () => {
  it('identifies a Project table by its grid rows while preserving Board-only detection', () => {
    const root = loadFixture('table');
    expect(detectProjectView(document, projectUrl)).toEqual({ element: root, kind: 'table' });
    expect(detectBoard(document, projectUrl)).toBeNull();
    expect(detectProjectView(document, 'https://github.com/acme/app/issues')).toBeNull();
    root.hidden = true;
    expect(detectProjectView(document, projectUrl)).toBeNull();
  });
  it('uses only the title column for identity and routes from its rectangle', () => {
    const root = loadFixture('table');
    const cards = extractCards(root, 'table');
    expect(cards.map(card => card.issue.number)).toEqual([1, 2, 3, 4]);
    expect(cards.every(card => card.issue.repo === 'app')).toBe(true);
    expect(cards[0]!.element).toBe(root.querySelector('[data-item-id="1"]'));
    expect(cards[0]!.rect).toEqual(new DOMRect(86, 280, 440, 64));
    expect(cards.every(card => card.anchor === 'title')).toBe(true);
  });
  it('ignores offscreen rows and tracks virtualized row replacement', () => {
    const root = loadFixture('table');
    const last = root.querySelector('[data-item-id="4"]')!;
    last.remove();
    expect(extractCards(root, 'table').map(card => card.issue.number)).toEqual([1, 2, 3]);
    root.append(last);
    expect(extractCards(root, 'table').map(card => card.issue.number)).toEqual([1, 2, 3, 4]);
    last.querySelector<HTMLElement>('[role="rowheader"]')!.dataset.rect = '86,900,440,64';
    expect(extractCards(root, 'table').map(card => card.issue.number)).toEqual([1, 2, 3]);
  });
  it('rejects incomplete grids and simultaneous visible view roots', () => {
    const root = loadFixture('table');
    const duplicate = root.cloneNode(true) as HTMLElement;
    document.body.append(duplicate);
    expect(detectProjectView(document, projectUrl)).toBeNull();
    duplicate.remove();
    root.replaceChildren(document.createElement('div'));
    expect(detectProjectView(document, projectUrl)).toBeNull();
  });
  it('excludes rows hidden by a sticky header wrapper and clips partially visible titles', () => {
    const root = loadFixture('table');
    const header = root.querySelector<HTMLElement>('.header-row')!;
    const wrapper = document.createElement('div');
    wrapper.style.position = 'sticky'; wrapper.style.top = '0px'; wrapper.dataset.rect = '20,200,1000,43';
    header.style.position = 'static'; header.before(wrapper); wrapper.append(header);
    expect(projectViewRect(root, 'table')).toEqual(new DOMRect(20, 243, 1000, 497));
    root.querySelector<HTMLElement>('[data-item-id="1"] [role="rowheader"]')!.dataset.rect = '86,210,440,30';
    root.querySelector<HTMLElement>('[data-item-id="2"] [role="rowheader"]')!.dataset.rect = '86,230,440,64';
    const cards = extractCards(root, 'table');
    expect(cards.map(card => card.issue.number)).toEqual([2, 3, 4]);
    expect(cards[0]!.rect).toEqual(new DOMRect(86, 243, 440, 51));
  });
});

describe('Project Roadmap adapter', () => {
  it('recognizes roadmap rows before the shared table grid root', () => {
    const root = loadFixture('roadmap');
    expect(detectProjectView(document, projectUrl)).toEqual({ element: root, kind: 'roadmap' });
    expect(detectBoard(document, projectUrl)).toBeNull();
    expect(extractCards(root, 'roadmap').map(card => card.issue.number)).toEqual([1, 2, 3, 4]);
  });
  it('anchors matching visible bars and falls back to titles for missing or hidden bars', () => {
    const cards = extractCards(loadFixture('roadmap'), 'roadmap');
    expect(cards.map(card => card.anchor)).toEqual(['bar', 'title', 'title', 'bar']);
    expect(cards[0]!.rect).toEqual(new DOMRect(515, 270, 160, 34));
    expect(cards[1]!.rect).toEqual(new DOMRect(20, 326, 440, 76));
    expect(cards[2]!.rect).toEqual(new DOMRect(20, 402, 440, 76));
    expect(cards[3]!.rect).toEqual(new DOMRect(820, 498, 170, 34));
  });
  it('does not connect a bar whose URL belongs to another issue', () => {
    const root = loadFixture('roadmap');
    root.querySelector<HTMLAnchorElement>('[data-item-id="1"] a.roadmap-pill')!.href = '/acme/app/issues/99';
    const card = extractCards(root, 'roadmap')[0]!;
    expect(card.issue.number).toBe(1);
    expect(card.anchor).toBe('title');
    expect(card.rect).toEqual(new DOMRect(20, 250, 440, 76));
  });
  it('uses the title when a timeline bar is outside the visible viewport', () => {
    const root = loadFixture('roadmap');
    root.querySelector<HTMLElement>('[data-item-id="1"] .roadmap-pill')!.dataset.rect = '1600,270,160,34';
    expect(extractCards(root, 'roadmap')[0]!.anchor).toBe('title');
  });
  it('uses the title when its sticky cell completely covers the bar', () => {
    const root = loadFixture('roadmap');
    root.querySelector<HTMLElement>('[data-item-id="1"] .roadmap-pill')!.dataset.rect = '180,270,160,34';
    const card = extractCards(root, 'roadmap')[0]!;
    expect(card.anchor).toBe('title');
    expect(card.rect).toEqual(new DOMRect(20, 250, 440, 76));
  });
  it('clips a partially covered bar at the visible sticky title boundary', () => {
    const root = loadFixture('roadmap');
    root.querySelector<HTMLElement>('[data-item-id="1"] .roadmap-pill')!.dataset.rect = '420,270,160,34';
    const card = extractCards(root, 'roadmap')[0]!;
    expect(card.anchor).toBe('bar');
    expect(card.rect).toEqual(new DOMRect(460, 270, 120, 34));
  });
  it('accounts for visible sticky date cells and falls back when they cover the whole bar', () => {
    const root = loadFixture('roadmap');
    const date = document.createElement('div');
    date.className = 'roadmap-table-cell'; date.style.position = 'sticky'; date.dataset.rect = '460,250,100,76';
    root.querySelector('[data-item-id="1"]')!.append(date);
    expect(extractCards(root, 'roadmap')[0]!.rect).toEqual(new DOMRect(560, 270, 115, 34));
    date.dataset.rect = '460,250,250,76';
    expect(extractCards(root, 'roadmap')[0]!.anchor).toBe('title');
    date.hidden = true;
    expect(extractCards(root, 'roadmap')[0]!.rect).toEqual(new DOMRect(515, 270, 160, 34));
  });
  it('does not mistake the bar container itself for a covering sticky cell', () => {
    const root = loadFixture('roadmap');
    const timeline = root.querySelector<HTMLElement>('[data-item-id="1"] .timeline')!;
    timeline.style.position = 'sticky'; timeline.dataset.rect = '460,250,540,76';
    const card = extractCards(root, 'roadmap')[0]!;
    expect(card.anchor).toBe('bar');
    expect(card.rect).toEqual(new DOMRect(515, 270, 160, 34));
  });
  it('excludes overscan items covered entirely by the sticky timeline header', () => {
    const root = loadFixture('roadmap');
    expect(projectViewRect(root, 'roadmap')).toEqual(new DOMRect(20, 244, 1000, 496));
    root.querySelector<HTMLElement>('[data-item-id="1"] [role="rowheader"]')!.dataset.rect = '20,205,440,30';
    root.querySelector<HTMLElement>('[data-item-id="1"] .roadmap-pill')!.dataset.rect = '515,210,160,20';
    expect(extractCards(root, 'roadmap').map(card => card.issue.number)).toEqual([2, 3, 4]);
  });
  it('clips partially covered timeline bars and fallback titles below the sticky header', () => {
    const root = loadFixture('roadmap');
    root.querySelector<HTMLElement>('[data-item-id="1"] .roadmap-pill')!.dataset.rect = '515,230,160,34';
    root.querySelector<HTMLElement>('[data-item-id="3"] [role="rowheader"]')!.dataset.rect = '20,220,440,76';
    const cards = extractCards(root, 'roadmap');
    expect(cards[0]!.anchor).toBe('bar');
    expect(cards[0]!.rect).toEqual(new DOMRect(515, 244, 160, 20));
    expect(cards[2]!.anchor).toBe('title');
    expect(cards[2]!.rect).toEqual(new DOMRect(20, 244, 440, 52));
  });
});
