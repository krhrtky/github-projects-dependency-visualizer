export interface IssueIdentity { owner: string; repo: string; number: number }
const segment = /^[A-Za-z0-9_.-]{1,100}$/;
export function isIssue(value: unknown): value is IssueIdentity {
  if (!value || typeof value !== 'object') return false;
  const i = value as Record<string, unknown>;
  return typeof i.owner === 'string' && segment.test(i.owner) && !/^\.+$/.test(i.owner)
    && typeof i.repo === 'string' && segment.test(i.repo) && !/^\.+$/.test(i.repo)
    && typeof i.number === 'number' && Number.isSafeInteger(i.number) && i.number > 0;
}
export function issueKey(i: IssueIdentity): string { return `${i.owner.toLowerCase()}/${i.repo.toLowerCase()}#${i.number}`; }
export function parseIssueUrl(href: string): IssueIdentity | null {
  try {
    const url = new URL(href, 'https://github.com');
    if (url.origin !== 'https://github.com' || url.username || url.password) return null;
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const issue = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
    return isIssue(issue) ? issue : null;
  } catch { return null; }
}
