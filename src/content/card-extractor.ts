import { issueKey, parseIssueUrl, type IssueIdentity } from '../domain/issue';
import { CARD_SELECTOR, displayed } from './board-detector';
export interface BoardCard { issue: IssueIdentity; element: HTMLElement; rect: DOMRect }
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
export function extractCards(board: HTMLElement): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const element of board.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
    if (!displayed(element) || element.querySelector(CARD_SELECTOR)) continue;
    const identities = new Map<string, IssueIdentity>();
    for (const anchor of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const issue = parseIssueUrl(anchor.href);
      if (issue) identities.set(issueKey(issue), issue);
    }
    if (identities.size !== 1) continue;
    const issue = [...identities.values()][0]!;
    const rect = element.getBoundingClientRect();
    const clip = visibleRect(element);
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= clip.left || rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom) continue;
    cards.push({ issue, element, rect });
  }
  return cards;
}
