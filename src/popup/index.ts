import './style.css';
import { isPersonalAccessToken, send, type Settings, type PageStatus } from '../shared/messages';
import { errorText, type PublicError } from '../shared/errors';
const input = document.querySelector<HTMLInputElement>('#token')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const relationshipsVisible = document.querySelector<HTMLInputElement>('#relationships-visible')!;
const auth = document.querySelector<HTMLElement>('#auth')!;
const board = document.querySelector<HTMLElement>('#board')!;
const analysis = document.querySelector<HTMLElement>('#analysis')!;
const errors = document.querySelector<HTMLUListElement>('#errors')!;
let actionError: PublicError | undefined;
let busy = false;
function showErrors(items: PublicError[]): void {
  errors.replaceChildren();
  for (const error of [...new Map(items.map(e => [`${e.code}:${e.retryAt}`, e])).values()]) {
    const li = document.createElement('li'); li.textContent = errorText[error.code] + (error.retryAt ? ` 再開目安: ${new Date(error.retryAt).toLocaleTimeString()}` : ''); errors.append(li);
  }
}
async function update(): Promise<void> {
  analysis.textContent = '';
  const reply = await send<Settings>({ type: 'GET_STATE' });
  if (!reply.ok) { showErrors([reply.error]); return; }
  const settings = reply.data;
  auth.textContent = settings.authenticated ? 'PAT 設定済み（API 検証は取得時）' : 'PAT 未設定';
  enabled.checked = settings.enabled && settings.authenticated; enabled.disabled = !settings.authenticated || busy;
  relationshipsVisible.checked = settings.relationshipsVisible; relationshipsVisible.disabled = busy;
  const problems: PublicError[] = actionError ? [actionError] : [];
  if (!settings.authenticated) problems.push({ code: 'AUTH_MISSING' });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error();
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_STATUS' }) as PageStatus;
    const states = { off: '表示は OFF です。', 'no-view': '対応する Project View を検出できません。Board・Table・Roadmap を開いてください。', 'no-cards': '表示中の Issue を識別できません。フィルタや DOM Adapter を確認してください。', loading: '依存関係を取得しています…', ready: '取得完了', partial: '一部の Issue を取得できません。取得できた関係のみ表示しています。', error: '依存関係を取得できません。' };
    const view = status.view ? `${{ board: 'Board', table: 'Table', roadmap: 'Roadmap' }[status.view]} / ` : '';
    board.textContent = `${view}${states[status.state]} ${status.view && status.view !== 'board' ? '項目' : 'カード'} ${status.cards} / 関係 ${status.edges} / 失敗 ${status.failed}${status.truncated ? '（上限200 Issue）' : ''}`;
    if (status.analysis) {
      const data = status.analysis;
      analysis.textContent = `${data.maxDepth === null ? `循環 ${data.cycleNodes} 件・最長経路は未算出` : `依存の最大深さ ${data.maxDepth}`} / 分岐 ${data.branches} / 合流 ${data.merges}。${status.state === 'loading' ? '取得中の暫定値。' : status.failed || status.truncated ? '解析は不完全です。' : ''}画面右下のパネルで経路を絞り込めます。`;
    }
    problems.push(...status.errors);
  } catch { board.textContent = '対象の GitHub Projects タブを開いてください。拡張機能を読み込んだ直後はタブを再読み込みしてください。'; }
  showErrors(problems);
}
async function action(request: Parameters<typeof send>[0]): Promise<void> {
  busy = true; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = true; });
  enabled.disabled = true; relationshipsVisible.disabled = true;
  try { const reply = await send<Settings>(request); actionError = reply.ok ? undefined : reply.error; }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = false; }); await update(); }
}
document.querySelector('#token-form')!.addEventListener('submit', event => {
  event.preventDefault();
  const token = input.value.trim(); input.value = '';
  if (!isPersonalAccessToken(token)) { actionError = { code: 'AUTH_INVALID' }; void update(); return; }
  void action({ type: 'SET_TOKEN', token });
});
enabled.addEventListener('change', () => { void action({ type: 'SET_ENABLED', enabled: enabled.checked }); });
relationshipsVisible.addEventListener('change', () => { void action({ type: 'SET_RELATIONSHIPS_VISIBLE', visible: relationshipsVisible.checked }); });
document.querySelector('#refresh')!.addEventListener('click', () => { void action({ type: 'REFRESH' }); });
document.querySelector('#logout')!.addEventListener('click', () => { input.value = ''; void action({ type: 'LOGOUT' }); });
void update();
const timer = setInterval(() => { if (!busy) void update(); }, 1000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
