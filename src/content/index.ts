import { Controller } from './controller';
import type { Settings } from '../shared/messages';
const controller = new Controller();
controller.start();
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  const popup = sender.url === chrome.runtime.getURL('src/popup/index.html');
  const background = !sender.tab && (!sender.url || sender.url === chrome.runtime.getURL('background.js'));
  if (m.type === 'SETTINGS_CHANGED' && background) {
    const settings = m.settings as Partial<Settings> | undefined;
    if (settings && typeof settings.enabled === 'boolean' && typeof settings.authenticated === 'boolean') controller.configure(settings as Settings);
    respond({ ok: true });
  } else if (m.type === 'RELATIONSHIPS_CHANGED' && background) {
    controller.refreshRelationships(); respond({ ok: true });
  } else if (m.type === 'PAGE_STATUS' && popup) respond(controller.status);
  return false;
});
// A BFCache restore needs a fresh lifecycle after pagehide released all observers.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
