import { isProjectUrl } from '../shared/config';
export const BOARD_SELECTOR = '#project-items-region[data-dnd-drop-id="board"][data-dnd-drop-type="column"], [data-testid="board-view"], [data-testid="board-view-container"], [data-view-type="board"], [aria-roledescription="board"]';
export const CARD_SELECTOR = '[data-board-card-id], [data-testid="board-card"], [data-testid="board-view-card"], [data-testid="project-board-card"], [role="listitem"]';
export type ProjectViewKind = 'board' | 'table' | 'roadmap';
export interface ProjectView { element: HTMLElement; kind: ProjectViewKind }
export const GRID_SELECTOR = '#project-items-region[role="grid"]';
export const ROW_SELECTOR = '[role="row"]';
export const TITLE_SELECTOR = '[role="rowheader"]';
export const ROADMAP_ROW_SELECTOR = '.roadmap-row[role="row"]';
export const ROADMAP_BAR_SELECTOR = 'a.roadmap-pill[href]';
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
export function detectProjectView(doc: Document, url: string): ProjectView | null {
  if (!isProjectUrl(url)) return null;
  const boards: ProjectView[] = [...doc.querySelectorAll<HTMLElement>(BOARD_SELECTOR)].filter(displayed).map(element => ({ element, kind: 'board' }));
  const grids: ProjectView[] = [...doc.querySelectorAll<HTMLElement>(GRID_SELECTOR)]
    .filter(element => displayed(element) && !element.matches(BOARD_SELECTOR))
    .flatMap<ProjectView>(element => {
      if (element.querySelector(ROADMAP_ROW_SELECTOR) || element.querySelector('.roadmap-table-cell')) return [{ element, kind: 'roadmap' as const }];
      if (element.querySelector(`${ROW_SELECTOR} ${TITLE_SELECTOR}`)) return [{ element, kind: 'table' as const }];
      return [];
    });
  const views = [...boards, ...grids];
  return views.length === 1 ? views[0]! : null;
}
