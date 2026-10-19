import { OVERLAY_ID } from '../renderer/svg-renderer';
const owned = `#${OVERLAY_ID}, [data-dependency-relationships]`;
export function isExternalMutation(records: MutationRecord[]): boolean {
  return records.some(record => {
    if (record.target instanceof Element && record.target.closest(owned)) return false;
    if (record.type !== 'childList') return true;
    return [...record.addedNodes, ...record.removedNodes].some(n => !(n instanceof Element && n.matches(owned)));
  });
}
export class BoardObserver {
  private readonly resize: ResizeObserver;
  private readonly mutation: MutationObserver;
  constructor(root: HTMLElement, update: () => void) {
    this.resize = new ResizeObserver(update);
    this.resize.observe(root);
    this.mutation = new MutationObserver(records => { if (isExternalMutation(records)) update(); });
    this.mutation.observe(root, { childList: true, subtree: true, attributes: true });
  }
  cards(elements: HTMLElement[], root: HTMLElement): void { this.resize.disconnect(); this.resize.observe(root); elements.forEach(e => this.resize.observe(e)); }
  disconnect(): void { this.resize.disconnect(); this.mutation.disconnect(); }
}
