export type ErrorCode = 'AUTH_MISSING' | 'AUTH_INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK' | 'SCHEMA' | 'API' | 'MESSAGE' | 'STALE';
export interface PublicError { code: ErrorCode; retryAt?: number }
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryAt?: number) { super(code); }
}
export function safeError(error: unknown): PublicError {
  return error instanceof AppError ? { code: error.code, ...(error.retryAt ? { retryAt: error.retryAt } : {}) } : { code: 'API' };
}
export const errorText: Record<ErrorCode, string> = {
  AUTH_MISSING: 'PAT 未設定です。期限を設定した Fine-grained PAT を入力してください。',
  AUTH_INVALID: 'PAT が無効または期限切れです。新しい PAT を設定してください。',
  FORBIDDEN: 'アクセスできません。Issues: Read、対象 Repository、組織の承認を確認してください。',
  NOT_FOUND: 'Issue を取得できません。削除・移動、PAT の Repository 選択や組織の承認を確認してください。',
  RATE_LIMIT: 'API の利用制限です。表示された時刻以降に Refresh してください。',
  TIMEOUT: 'API がタイムアウトしました。接続を確認して Refresh してください。',
  NETWORK: 'GitHub API に接続できません。接続を確認して Refresh してください。',
  SCHEMA: 'API の応答形式を確認できません。API 仕様を確認してください。',
  API: '依存関係を取得できません。接続や権限を確認して Refresh してください。',
  MESSAGE: '拡張機能と通信できません。GitHub のタブを再読み込みしてください。',
  STALE: '認証や設定が変更されました。Refresh してください。'
};
