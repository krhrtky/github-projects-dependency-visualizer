import { isProjectUrl } from '../shared/config';
export const BOARD_SELECTOR = '#project-items-region[data-dnd-drop-id="board"][data-dnd-drop-type="column"], [data-testid="board-view"], [data-testid="board-view-container"], [data-view-type="board"], [aria-roledescription="board"]';
export const CARD_SELECTOR = '[data-board-card-id], [data-testid="board-card"], [data-testid="board-view-card"], [data-testid="project-board-card"], [role="listitem"]';
export function displayed(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return !element.closest('[hidden], [aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}
export function detectBoard(doc: Document, url: string): HTMLElement | null {
  if (!isProjectUrl(url)) return null;
  const boards = [...doc.querySelectorAll<HTMLElement>(BOARD_SELECTOR)].filter(displayed);
  // Ambiguous roots are rejected rather than drawing across unrelated containers.
  return boards.length === 1 ? boards[0]! : null;
}
