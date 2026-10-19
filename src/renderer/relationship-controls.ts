import { visibleRect, type BoardCard } from '../content/card-extractor';
import { detectProjectView, TITLE_SELECTOR } from '../content/board-detector';
import { applyNativeFilter } from '../content/native-project-controls';
import { issueKey, isIssue, parseIssueUrl, type IssueIdentity } from '../domain/issue';
import { parseProjectUrl, type ProjectIdentity, type ProjectIntegrationPreview, type ProjectSyncReport } from '../domain/project';
import type { ChangeRelationship, IssueRelationships, RelationshipKind } from '../domain/relationships';
import { errorText, type PublicError } from '../shared/errors';
import { send, type RelationshipChangeReport } from '../shared/messages';

export const RELATIONSHIPS_ATTRIBUTE = 'data-dependency-relationships';
const css = `
:host{font:12px/1.5 system-ui,-apple-system,sans-serif;color:var(--fgColor-default,#1f2328)}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-default,#fff);padding:6px 9px}button{cursor:pointer}button:hover{background:var(--bgColor-muted,#f6f8fa)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid #0969da;outline-offset:2px}a{color:var(--fgColor-accent,#0969da)}
:host([data-compact]){position:absolute;inset-inline-end:6px;top:50%;transform:translateY(-50%);display:flex;z-index:1}
:host([hidden]){display:none}
.item{font-size:11px;margin:3px 0;white-space:nowrap}.item.compact{display:grid;place-items:center;width:28px;height:28px;padding:0;margin:0;font-size:16px;line-height:1}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:var(--bgColor-default,#fff);border-bottom:1px solid var(--borderColor-default,#d1d9e0)}.toolbar strong{margin-right:4px}.toolbar small{color:var(--fgColor-muted,#59636e)}
dialog{position:fixed;inset:0;margin:auto;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;padding:22px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:12px;background:var(--bgColor-default,#fff);color:inherit;box-shadow:0 16px 64px #0004;overscroll-behavior:contain}dialog::backdrop{background:#0006}dialog[open]{display:block}.header{display:flex;align-items:start;justify-content:space-between;gap:14px}h2{font-size:19px;margin:0}h3{font-size:14px;margin:0 0 7px}p{margin:8px 0}.note{font-size:11px;color:var(--fgColor-muted,#59636e)}.status{padding:9px;border-radius:6px;background:var(--bgColor-muted,#f6f8fa);overflow-wrap:anywhere}.error{color:var(--fgColor-danger,#cf222e)}section{margin-top:18px;border-top:1px solid var(--borderColor-default,#d1d9e0);padding-top:15px}ul{padding:0;list-style:none;margin:8px 0}li{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:5px 0;overflow-wrap:anywhere}li a{min-width:0;overflow-wrap:anywhere}form{display:flex;gap:6px;align-items:end;flex-wrap:wrap;margin-top:8px}label{flex:1;min-width:200px;font-size:11px}input{display:block;width:100%;margin-top:4px}.filter{font-size:11px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.primary{color:#fff;background:#1f883d;border-color:#1f883d}.primary:hover{background:#1a7f37}.fields{display:block;list-style:disc;padding-left:20px}.fields li{display:list-item}.empty{color:var(--fgColor-muted,#59636e)}
`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const element = node('button', text, className); element.type = 'button'; element.addEventListener('click', action); return element;
}
function ownedHost(kind: string): { host: HTMLDivElement; shadow: ShadowRoot } {
  const host = node('div'); host.setAttribute(RELATIONSHIPS_ATTRIBUTE, kind);
  for (const event of ['click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'dragstart']) host.addEventListener(event, event => event.stopPropagation());
  const shadow = host.attachShadow({ mode: 'closed' }); shadow.append(node('style', css));
  return { host, shadow };
}
function applyStyles(element: HTMLElement, styles: Readonly<Record<string, string>>): () => void {
  const changes = Object.entries(styles).map(([property, value]) => {
    const previous = { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) };
    element.style.setProperty(property, value);
    return { property, previous, applied: element.style.getPropertyValue(property) };
  });
  return () => {
    for (const { property, previous, applied } of changes) {
      if (element.style.getPropertyValue(property) !== applied || element.style.getPropertyPriority(property)) continue;
      if (previous.value) element.style.setProperty(property, previous.value, previous.priority); else element.style.removeProperty(property);
    }
    if (!element.style.length) element.removeAttribute('style');
  };
}
function titleContent(title: HTMLElement): HTMLElement | undefined {
  return [...title.children].find((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute(RELATIONSHIPS_ATTRIBUTE) && (child.matches('a[href]') || !!child.querySelector('a[href]')));
}
function rowLayoutKey(title: HTMLElement, content: HTMLElement | undefined): string {
  const rect = title.getBoundingClientRect();
  const clip = visibleRect(title);
  return JSON.stringify([rect.width, rect.height, Math.max(rect.left, clip.left) - rect.left, Math.min(rect.right, clip.right) - rect.left, content?.textContent, content ? [...content.children].map(child => [child.getAttribute('class'), child.getAttribute('style')]) : []]);
}
function compactRowAction(title: HTMLElement, content: HTMLElement | undefined): { restore: () => void; inline: boolean } {
  const nativeItems = content && !content.matches('a[href]') ? [...content.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.matches('a[href]') && !child.querySelector('a[href]')) : [];
  const visibleWidths = (): number[] => {
    const bounds = visibleRect(content!);
    return nativeItems.map(item => {
      const rect = item.getBoundingClientRect();
      return Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left));
    });
  };
  const before = content ? visibleWidths() : [];
  const style = getComputedStyle(title);
  const restoreTitle = applyStyles(title, {
    ...(!style.position || style.position === 'static' ? { position: 'relative' } : {}),
    'padding-inline-end': `${(parseFloat(style.paddingInlineEnd) || 0) + 36}px`,
  });
  const restoreContent = content ? applyStyles(content, { 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }) : () => {};
  const restore = (): void => { restoreContent(); restoreTitle(); };
  if (content && visibleWidths().some((width, index) => width + 0.5 < before[index]!)) {
    restore(); return { restore: () => {}, inline: false };
  }
  return { restore, inline: true };
}
export function parseRelationshipIssue(value: string): IssueIdentity | null {
  const input = value.trim();
  const url = parseIssueUrl(input);
  if (url) return url;
  const match = /^([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/.exec(input);
  if (!match) return null;
  const issue = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
  return isIssue(issue) ? issue : null;
}
interface ItemControl { host: HTMLElement; issue: IssueIdentity; button: HTMLButtonElement; content?: HTMLElement; layoutKey?: string; restoreLayout: () => void }
interface DialogSession { host: HTMLElement; shadow: ShadowRoot; dialog: HTMLDialogElement; body: HTMLElement; status: HTMLElement; trigger: HTMLElement; issue?: IssueIdentity; busy: boolean; stale: boolean }
const kinds: ReadonlyArray<{ kind: RelationshipKind; title: string }> = [
  { kind: 'blockedBy', title: 'Blocked by · 前提' }, { kind: 'blocking', title: 'Blocking · 後続' },
  { kind: 'parent', title: 'Parent issue · 親 Issue' }, { kind: 'child', title: 'Sub-issues · 子 Issue' },
];

export class RelationshipControls {
  private readonly items = new Map<HTMLElement, ItemControl>();
  private toolbar?: HTMLElement;
  private issuePicker?: HTMLSelectElement;
  private session?: DialogSession;
  constructor(private readonly onChanged: () => void) {}

  update(cards: BoardCard[]): boolean {
    let layoutChanged = false;
    const elements = new Set(cards.map(card => card.element));
    for (const [element, control] of this.items) {
      if (elements.has(element) && control.host.isConnected) continue;
      control.host.remove(); control.restoreLayout(); this.items.delete(element); layoutChanged = true;
    }
    for (const card of cards) {
      const title = card.element.querySelector<HTMLElement>(TITLE_SELECTOR);
      const target = title ?? card.element;
      const content = title ? titleContent(title) : undefined;
      const layoutKey = title ? rowLayoutKey(title, content) : undefined;
      const existing = this.items.get(card.element);
      if (existing && existing.host.parentElement === target && existing.content === content) {
        existing.issue = card.issue; existing.button.setAttribute('aria-label', `${issueKey(card.issue)} の Relationships`);
        if (title && existing.layoutKey !== layoutKey) {
          existing.restoreLayout();
          const layout = compactRowAction(title, content);
          existing.restoreLayout = layout.restore; existing.host.hidden = !layout.inline; existing.layoutKey = layoutKey; layoutChanged = true;
        }
        continue;
      }
      if (existing) { existing.host.remove(); existing.restoreLayout(); }
      const { host, shadow } = ownedHost('item');
      const layout = title ? compactRowAction(title, content) : { restore: () => {}, inline: true };
      const control: ItemControl = { host, issue: card.issue, content, layoutKey, restoreLayout: layout.restore, button: button(title ? '↔' : 'Relationships', () => this.openRelationships(control.issue, control.button), title ? 'item compact' : 'item') };
      host.hidden = !layout.inline;
      if (title) host.setAttribute('data-compact', '');
      control.button.title = 'Relationships';
      control.button.setAttribute('aria-label', `${issueKey(card.issue)} の Relationships`);
      shadow.append(control.button);
      target.append(host);
      this.items.set(card.element, control); layoutChanged = true;
    }
    const view = detectProjectView(document, location.href);
    if (!view || !parseProjectUrl(location.href)) {
      const removedToolbar = !!this.toolbar;
      this.toolbar?.remove(); this.toolbar = undefined; this.issuePicker = undefined; return layoutChanged || removedToolbar;
    }
    if (this.toolbar?.isConnected && this.toolbar.nextElementSibling === view.element) { this.updateIssuePicker(); return layoutChanged; }
    this.toolbar?.remove();
    const { host, shadow } = ownedHost('toolbar');
    const toolbar = node('div', '', 'toolbar');
    const picker = node('select'); picker.setAttribute('aria-label', 'Relationships を編集する Issue');
    picker.addEventListener('change', () => {
      const selected = [...this.items.values()].find(control => issueKey(control.issue) === picker.value);
      picker.value = ''; if (selected) this.openRelationships(selected.issue, picker);
    });
    this.issuePicker = picker;
    const sync = button('標準フィールドに同期', () => {
      const project = parseProjectUrl(location.href); if (project) void this.openSync(project, sync);
    });
    toolbar.append(node('strong', 'Relationships'), picker, button('ブロック中の Issue', () => applyNativeFilter('is:blocked')), button('他をブロックする Issue', () => applyNativeFilter('is:blocking')), sync, node('small', '絞り込みには GitHub 標準フィルターを使います。'));
    shadow.append(toolbar); view.element.before(host); this.toolbar = host;
    this.updateIssuePicker();
    return true;
  }

  private updateIssuePicker(): void {
    const picker = this.issuePicker;
    if (!picker) return;
    const issues = [...new Map([...this.items.values()].filter(control => control.host.hidden).map(control => [issueKey(control.issue), control.issue])).keys()];
    picker.hidden = !issues.length;
    if ([...picker.options].slice(1).map(option => option.value).join(',') === issues.join(',') && picker.options.length) return;
    const placeholder = node('option', 'Issue の Relationships…'); placeholder.value = '';
    picker.replaceChildren(placeholder, ...issues.map(key => { const option = node('option', key); option.value = key; return option; }));
  }

  private openDialog(title: string, trigger: HTMLElement): DialogSession {
    this.closeDialog();
    const { host, shadow } = ownedHost('dialog');
    const dialog = node('dialog'); dialog.setAttribute('aria-label', title); dialog.setAttribute('aria-modal', 'true');
    const heading = node('div', '', 'header');
    const close = button('閉じる', () => this.closeDialog()); close.dataset.close = 'true';
    heading.append(node('h2', title), close);
    const status = node('p', '取得しています…', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const body = node('div'); dialog.append(heading, status, body); shadow.append(dialog); document.documentElement.append(host);
    const session = { host, shadow, dialog, body, status, trigger, busy: false, stale: false }; this.session = session;
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeDialog(); });
    shadow.addEventListener('keydown', event => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'Escape') { event.preventDefault(); this.closeDialog(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')];
      const first = focusable[0]; const last = focusable.at(-1); const focused = shadow.activeElement;
      if (event.shiftKey && focused === first && last) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && focused === last && first) { event.preventDefault(); first.focus(); }
    });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.open = true;
    close.focus(); return session;
  }
  private closeDialog(): void {
    const session = this.session; this.session = undefined;
    if (!session) return;
    session.host.remove();
    const visible = (element: HTMLElement | undefined): element is HTMLElement => !!element?.isConnected && !element.hidden && element.getClientRects().length > 0;
    const alternatives = session.issue ? [...this.items.values()].filter(control => issueKey(control.issue) === issueKey(session.issue!)).map(control => control.button) : [];
    const trigger = visible(session.trigger) ? session.trigger : [...alternatives, this.issuePicker].find(visible);
    trigger?.focus();
  }
  private setBusy(session: DialogSession, busy: boolean): void {
    session.busy = busy; session.dialog.setAttribute('aria-busy', String(busy));
    session.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button:not([data-close]),input').forEach(control => { control.disabled = busy || (session.stale && !!control.closest('section')) || control.dataset.permanentDisabled === 'true'; });
  }
  private showError(session: DialogSession, error: PublicError): void {
    session.status.className = 'status error';
    session.status.textContent = error.code === 'FORBIDDEN' ? '権限がありません。関係の編集には Issues: Read and write、フィールド同期には Projects: Read and write が必要です。Repository・組織の承認・SSO 設定も確認してください。' : errorText[error.code];
  }
  private openRelationships(issue: IssueIdentity, trigger: HTMLElement): void {
    const session = this.openDialog(`${issueKey(issue)} · Relationships`, trigger);
    session.issue = issue;
    session.body.append(node('p', '関係の追加・解除は GitHub の Issue に保存します。Issues: Read and write と対象 Issue への権限が必要です。', 'note'));
    void this.loadRelationships(session, issue);
  }
  private async loadRelationships(session: DialogSession, issue: IssueIdentity, success = '', warning = false): Promise<void> {
    session.body.querySelector('[data-retry]')?.remove();
    this.setBusy(session, true);
    const reply = await send<IssueRelationships>({ type: 'RELATIONSHIPS', issue });
    if (this.session !== session) return;
    session.stale = !reply.ok;
    this.setBusy(session, false);
    if (!reply.ok) {
      this.showError(session, reply.error);
      if (success) session.status.textContent = `${success} 保存後の一覧を取得できません。${errorText[reply.error.code]}`;
      const retry = button('関係を再取得', () => { void this.loadRelationships(session, issue, success, warning); }); retry.dataset.retry = 'true';
      session.body.append(retry);
      return;
    }
    session.status.className = warning ? 'status error' : 'status'; session.status.textContent = success || 'GitHub に保存されている関係です。画面外の Issue も含みます。';
    session.body.querySelectorAll('section').forEach(section => section.remove());
    for (const { kind, title } of kinds) {
      const related = kind === 'parent' ? (reply.data.parent ? [reply.data.parent] : []) : kind === 'child' ? reply.data.children : reply.data[kind];
      const section = node('section'); section.append(node('h3', `${title} (${related.length})`));
      const list = node('ul');
      for (const target of related) {
        const item = node('li'); const link = node('a', issueKey(target));
        link.href = `https://github.com/${target.owner}/${target.repo}/issues/${target.number}`; link.target = '_blank'; link.rel = 'noreferrer noopener';
        const remove = button('解除', () => { void this.changeRelationship(session, { issue, related: target, kind, action: 'remove' }); });
        remove.setAttribute('aria-label', `${issueKey(target)} の ${title} を解除`); item.append(link, remove); list.append(item);
      }
      if (!related.length) list.append(node('li', '関係はありません。', 'empty'));
      const qualifier = kind === 'blockedBy' ? `blocking:"${issueKey(issue)}"` : kind === 'blocking' ? `blocked-by:"${issueKey(issue)}"` : `parent-issue:"${issueKey(kind === 'parent' && reply.data.parent ? reply.data.parent : issue)}"`;
      const filter = button(kind === 'parent' ? '同じ親の Issue を標準フィルターで表示' : '標準フィルターで表示', () => { this.closeDialog(); applyNativeFilter(qualifier); }, 'filter');
      if (kind === 'parent' && !related.length) { filter.disabled = true; filter.dataset.permanentDisabled = 'true'; }
      const form = node('form'); const label = node('label', 'owner/repo#123 または Issue URL');
      const input = node('input'); input.type = 'text'; input.required = true; input.autocomplete = 'off'; input.setAttribute('aria-label', `${title} の追加先`); label.append(input);
      const add = button('追加', () => form.requestSubmit());
      if (kind === 'parent' && related.length) {
        input.disabled = true; add.disabled = true; input.dataset.permanentDisabled = 'true'; add.dataset.permanentDisabled = 'true';
      }
      form.addEventListener('submit', event => {
        event.preventDefault(); if (session.busy || session.stale) return;
        const target = parseRelationshipIssue(input.value);
        if (!target || issueKey(target) === issueKey(issue)) { session.status.className = 'status error'; session.status.textContent = '別の Issue を owner/repo#123 または GitHub の Issue URL で入力してください。'; input.focus(); return; }
        void this.changeRelationship(session, { issue, related: target, kind, action: 'add' });
      });
      form.append(label, add); section.append(list, filter, form);
      if (kind === 'parent' && related.length) section.append(node('p', '親を変更する場合は、現在の親を解除してから追加してください。', 'note'));
      session.body.append(section);
    }
  }
  private async changeRelationship(session: DialogSession, change: ChangeRelationship): Promise<void> {
    if (session.busy || session.stale) return;
    this.setBusy(session, true); session.status.className = 'status'; session.status.textContent = 'GitHub に保存しています…';
    const project = parseProjectUrl(location.href);
    const reply = await send<RelationshipChangeReport>({ type: 'CHANGE_RELATIONSHIP', change, ...(project ? { project } : {}) });
    if (reply.ok) this.onChanged();
    if (this.session !== session) return;
    this.setBusy(session, false);
    if (!reply.ok) { this.showError(session, reply.error); return; }
    const sync = reply.data.sync;
    const syncError = reply.data.syncError ?? sync?.viewError ?? sync?.failed[0]?.error;
    const success = syncError ? `関係を GitHub に保存しました。標準フィールドの同期は未完了または未確認です。${errorText[syncError.code]}「標準フィールドに同期」で表示用データを更新してください。`
      : sync ? '関係を GitHub に保存し、標準フィールドの表示用データも更新しました。'
      : '関係を GitHub に保存しました。標準フィールドの表示用データは「標準フィールドに同期」で更新できます。';
    await this.loadRelationships(session, change.issue, success, !!syncError);
  }
  private async openSync(project: ProjectIdentity, trigger: HTMLElement): Promise<void> {
    const session = this.openDialog('Relationships を標準フィールドに同期', trigger);
    const reply = await send<ProjectIntegrationPreview>({ type: 'PROJECT_PREVIEW', project });
    if (this.session !== session) return;
    if (!reply.ok) { this.showError(session, reply.error); return; }
    const preview = reply.data;
    session.status.textContent = `${project.owner} / Project ${project.number} の ${preview.issueCount} Issue を同期します。`;
    session.body.append(node('p', 'Project 全体の依存関係を GitHub のカスタムフィールドへ保存します。Parent issue・Sub-issues progress は既存の標準フィールドを利用します。'));
    const fields = node('ul', '', 'fields');
    for (const name of preview.fieldsToCreate) fields.append(node('li', `作成するフィールド: ${name}`));
    for (const name of preview.fieldsToShow) fields.append(node('li', `表示するフィールド: ${name}`));
    session.body.append(fields, node('p', '依存の 3 列は表示用のコピーです。セルの文字列を直接編集しても Issue の関係は変わりません。関係は各項目の Relationships から編集し、再同期で表示を更新してください。', 'note'), node('p', '同期には Projects: Read and write と Issues: Read が必要です。別の画面で変更した関係も、再同期するまでコピーへ反映されません。', 'note'));
    if (preview.skipped) session.body.append(node('p', `Draft・Pull Request など ${preview.skipped} 項目は同期対象外です。`, 'note'));
    const execute = button('同期を実行', () => { void this.syncProject(session, project); }, 'primary');
    session.body.append(node('div', '', 'actions')); session.body.lastElementChild!.append(execute);
  }
  private async syncProject(session: DialogSession, project: ProjectIdentity): Promise<void> {
    if (session.busy) return;
    this.setBusy(session, true); session.status.className = 'status'; session.status.textContent = 'Project 全体を同期しています…';
    const reply = await send<ProjectSyncReport>({ type: 'PROJECT_SYNC', project });
    if (reply.ok) this.onChanged();
    if (this.session !== session) return;
    this.setBusy(session, false);
    if (!reply.ok) { this.showError(session, reply.error); return; }
    const report = reply.data;
    session.status.className = report.failed.length || report.viewError ? 'status error' : 'status';
    session.status.textContent = `同期完了: ${report.changed} Issue を更新、${report.createdFields.length} フィールドを作成、失敗 ${report.failed.length} Issue。${report.viewError ? ' View の表示設定は更新できませんでした。' : ''}`;
    session.body.replaceChildren(node('p', 'GitHub の標準 Fields・フィルターバー・並び替えで利用できます。新しいフィールドの反映には、このページを再読み込みしてください。'), node('p', '依存の 3 列は表示用です。セルを直接編集しても Issue の関係は変わりません。Roadmap の列表示は GitHub 標準が対応する項目に限られます。', 'note'));
    if (report.viewError) session.body.append(node('p', `表示設定のエラー: ${errorText[report.viewError.code]} 再読み込み後、標準の Fields から列を選択できます。`, 'error'));
    if (report.failed.length) {
      const failures = node('ul');
      for (const failure of report.failed) failures.append(node('li', `${issueKey(failure.issue)}: ${errorText[failure.error.code]}`));
      session.body.append(failures);
    }
    session.body.append(button('ページを再読み込み', () => location.reload()));
  }
  destroy(): void {
    this.closeDialog(); this.toolbar?.remove(); this.toolbar = undefined; this.issuePicker = undefined;
    for (const control of this.items.values()) { control.host.remove(); control.restoreLayout(); }
    this.items.clear();
  }
}
