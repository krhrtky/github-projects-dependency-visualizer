import { AppError } from '../shared/errors';
import type { Settings } from '../shared/messages';
export interface AuthProvider { getToken(): Promise<string> }
export class SessionAuth implements AuthProvider {
  private readonly ready = Promise.all([
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  ]);
  async getToken(): Promise<string> {
    await this.ready;
    const { token } = await chrome.storage.session.get('token');
    if (typeof token !== 'string' || !token) throw new AppError('AUTH_MISSING');
    return token;
  }
  async setToken(token: string): Promise<void> { await this.ready; await chrome.storage.session.set({ token }); }
  async logout(): Promise<void> { await this.ready; await chrome.storage.session.remove('token'); }
  async settings(): Promise<Settings> {
    await this.ready;
    const [{ enabled }, { token }] = await Promise.all([chrome.storage.local.get('enabled'), chrome.storage.session.get('token')]);
    return { enabled: enabled === true, authenticated: typeof token === 'string' && token.length > 0 };
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.getToken();
    await this.ready;
    await chrome.storage.local.set({ enabled });
  }
}
