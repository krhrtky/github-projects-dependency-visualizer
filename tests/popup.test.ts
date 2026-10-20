import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageStatus, Reply, Request, Settings } from '../src/shared/messages';

let sendMessage: ReturnType<typeof vi.fn>;
let pageStatus: ReturnType<typeof vi.fn>;
const initialSettings: Settings = { enabled: false, authenticated: true, relationshipsVisible: true };
const ready: PageStatus = {
  state: 'ready', cards: 4, edges: 2, failed: 0, errors: [], truncated: false, view: 'table',
  analysis: { maxDepth: 3, branches: 1, merges: 0, cycleNodes: 0 },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  document.documentElement.innerHTML = readFileSync('src/popup/index.html', 'utf8');
  sendMessage = vi.fn(async () => ({ ok: true, data: initialSettings }));
  pageStatus = vi.fn(async () => ready);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage: pageStatus },
  });
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('popup refresh ordering', () => {
  it.each([
    ['#enabled', 'SET_ENABLED', 'enabled', true],
    ['#relationships-visible', 'SET_RELATIONSHIPS_VISIBLE', 'relationshipsVisible', false],
  ] as const)('keeps the change to %s when an older settings read finishes during the save', async (selector, type, key, checked) => {
    const older = deferred<Reply<Settings>>();
    const saved = deferred<Reply<Settings>>();
    let settings = initialSettings;
    let reads = 0;
    sendMessage.mockImplementation((request: Request) => {
      if (request.type === 'GET_STATE') {
        reads++;
        return reads === 2 ? older.promise : Promise.resolve({ ok: true, data: settings });
      }
      if (request.type === type) return saved.promise;
      throw new Error(`Unexpected popup request: ${request.type}`);
    });
    await import('../src/popup/index');
    await vi.advanceTimersByTimeAsync(0);
    const toggle = document.querySelector<HTMLInputElement>(selector)!;
    expect(toggle.checked).toBe(!checked);
    expect(toggle.disabled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    toggle.checked = checked;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sendMessage).toHaveBeenCalledWith(type === 'SET_ENABLED' ? { type, enabled: checked } : { type, visible: checked });
    expect(toggle.disabled).toBe(true);

    older.resolve({ ok: true, data: initialSettings });
    await vi.advanceTimersByTimeAsync(0);
    expect(toggle.checked).toBe(checked);
    expect(toggle.disabled).toBe(true);

    settings = { ...settings, [key]: checked };
    saved.resolve({ ok: true, data: settings });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(3);
    expect(toggle.checked).toBe(checked);
    expect(toggle.disabled).toBe(false);
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => !button.disabled)).toBe(true);
  });

  it('keeps the newest page status, analysis and errors when an older page status finishes later', async () => {
    const older = deferred<PageStatus>();
    pageStatus.mockImplementationOnce(() => older.promise);
    await import('../src/popup/index');
    await vi.advanceTimersByTimeAsync(0);
    expect(pageStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pageStatus).toHaveBeenCalledTimes(2);
    const board = document.querySelector('#board')!;
    const analysis = document.querySelector('#analysis')!;
    const errors = document.querySelector('#errors')!;
    expect(board.textContent).toContain('Table / 取得完了 項目 4 / 関係 2 / 失敗 0');
    expect(analysis.textContent).toContain('依存の最大深さ 3 / 分岐 1 / 合流 0');
    expect(errors.children).toHaveLength(0);
    const latestBoard = board.textContent;
    const latestAnalysis = analysis.textContent;

    older.resolve({ state: 'error', cards: 1, edges: 0, failed: 1, errors: [{ code: 'FORBIDDEN' }], truncated: false, view: 'board' });
    await vi.advanceTimersByTimeAsync(0);
    expect(board.textContent).toBe(latestBoard);
    expect(analysis.textContent).toBe(latestAnalysis);
    expect(errors.children).toHaveLength(0);
  });
});
