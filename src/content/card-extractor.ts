import { issueKey, parseIssueUrl, type IssueIdentity } from '../domain/issue';
import { CARD_SELECTOR, ROW_SELECTOR, TITLE_SELECTOR, ROADMAP_BAR_SELECTOR, displayed, type ProjectViewKind } from './board-detector';
export interface BoardCard { issue: IssueIdentity; element: HTMLElement; rect: DOMRect; anchor?: 'title' | 'bar' }
export function visibleRect(element: HTMLElement): DOMRect {
  let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
export function projectViewRect(element: HTMLElement, kind: ProjectViewKind): DOMRect {
  const clip = visibleRect(element);
  if (kind === 'board') return clip;
  const headers = new Set<HTMLElement>();
  for (const cell of element.querySelectorAll<HTMLElement>('[role="columnheader"]')) {
    for (let node: HTMLElement | null = cell; node && node !== element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.position === 'sticky' && style.top && style.top !== 'auto' && displayed(node)) headers.add(node);
    }
  }
  const roadmapHeader = kind === 'roadmap' ? element.querySelector('#end-of-markers')?.closest<HTMLElement>('[role="rowgroup"]') : null;
  if (roadmapHeader && displayed(roadmapHeader) && getComputedStyle(roadmapHeader).position === 'sticky') headers.add(roadmapHeader);
  const top = Math.max(clip.top, ...[...headers].map(header => clippedRect(header).bottom));
  return new DOMRect(clip.left, top, clip.width, Math.max(0, clip.bottom - top));
}
function visible(element: HTMLElement, bounds?: DOMRect): boolean {
  if (!displayed(element)) return false;
  const rect = clippedRect(element, bounds);
  return rect.width > 0 && rect.height > 0;
}
function identity(element: HTMLElement): IssueIdentity | null {
  const identities = new Map<string, IssueIdentity>();
  for (const anchor of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (anchor.closest('ul[aria-label="Fields"], [data-testid="card-labels"], [data-dependency-relationships]')) continue;
    const issue = parseIssueUrl(anchor.href);
    if (issue) identities.set(issueKey(issue), issue);
  }
  return identities.size === 1 ? [...identities.values()][0]! : null;
}
function clippedRect(element: HTMLElement, bounds?: DOMRect): DOMRect {
  const rect = element.getBoundingClientRect(); const visible = visibleRect(element);
  const clip = bounds ? { left: Math.max(visible.left, bounds.left), right: Math.min(visible.right, bounds.right), top: Math.max(visible.top, bounds.top), bottom: Math.min(visible.bottom, bounds.bottom) } : visible;
  const left = Math.max(rect.left, clip.left); const top = Math.max(rect.top, clip.top);
  return new DOMRect(left, top, Math.max(0, Math.min(rect.right, clip.right) - left), Math.max(0, Math.min(rect.bottom, clip.bottom) - top));
}
function roadmapBarRect(bar: HTMLAnchorElement, row: HTMLElement, title: HTMLElement, bounds: DOMRect): DOMRect {
  const rect = clippedRect(bar, bounds);
  const fixed = [title, ...row.querySelectorAll<HTMLElement>('.roadmap-table-cell')]
    .filter(cell => !cell.contains(bar) && (cell === title || getComputedStyle(cell).position === 'sticky') && visible(cell, bounds));
  // Overflow clipping does not account for the sticky title/date cells covering the timeline.
  const left = Math.max(rect.left, ...fixed.map(cell => clippedRect(cell, bounds).right));
  return new DOMRect(left, rect.top, Math.max(0, rect.right - left), rect.height);
}
export function extractCards(board: HTMLElement, kind: ProjectViewKind = 'board'): BoardCard[] {
  const cards: BoardCard[] = [];
  if (kind !== 'board') {
    const bounds = projectViewRect(board, kind);
    for (const row of board.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (!displayed(row)) continue;
      const titles = [...row.querySelectorAll<HTMLElement>(TITLE_SELECTOR)].filter(cell => cell.closest(ROW_SELECTOR) === row);
      if (titles.length !== 1) continue;
      const title = titles[0]!; const issue = identity(title);
      if (!issue) continue;
      // A recycled virtualized row can retain a stale bar; only its matching issue link is used.
      const bars = kind === 'roadmap' ? [...row.querySelectorAll<HTMLAnchorElement>(ROADMAP_BAR_SELECTOR)]
        .filter(bar => {
          const candidate = parseIssueUrl(bar.href);
          return bar.closest(ROW_SELECTOR) === row && visible(bar, bounds) && !!candidate && issueKey(candidate) === issueKey(issue);
        }).map(bar => roadmapBarRect(bar, row, title, bounds)).filter(rect => rect.width > 0 && rect.height > 0) : [];
      const bar = bars[0];
      if (!bar && !visible(title, bounds)) continue;
      cards.push({ issue, element: row, rect: bar ?? clippedRect(title, bounds), anchor: bar ? 'bar' : 'title' });
    }
    return cards;
  }
  for (const element of board.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
    if (!displayed(element) || element.querySelector(CARD_SELECTOR)) continue;
    const issue = identity(element);
    if (!issue || !visible(element)) continue;
    cards.push({ issue, element, rect: element.getBoundingClientRect() });
  }
  return cards;
}
