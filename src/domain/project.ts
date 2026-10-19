import type { IssueIdentity } from './issue';
import type { PublicError } from '../shared/errors';

export interface ProjectIdentity { kind: 'orgs' | 'users'; owner: string; number: number; view?: number }
export type OwnedProjectFields = Partial<Record<'blockers' | 'blocking' | 'status', string>>;
export interface ProjectFieldStore {
  get(projectKey: string): Promise<OwnedProjectFields | null>;
  set(projectKey: string, fields: OwnedProjectFields): Promise<void>;
}
export interface ProjectIntegrationPreview {
  project: ProjectIdentity;
  projectId: string;
  issueCount: number;
  skipped: number;
  fieldsToCreate: string[];
  fieldsToShow: string[];
}
export interface ProjectSyncFailure { issue: IssueIdentity; error: PublicError }
export interface ProjectSyncReport extends ProjectIntegrationPreview {
  createdFields: string[];
  changed: number;
  failed: ProjectSyncFailure[];
  viewError?: PublicError;
}
export function isProject(value: unknown): value is ProjectIdentity {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return (project.kind === 'orgs' || project.kind === 'users')
    && typeof project.owner === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(project.owner) && !/^\.+$/.test(project.owner)
    && Number.isSafeInteger(project.number) && Number(project.number) > 0
    && (project.view === undefined || (Number.isSafeInteger(project.view) && Number(project.view) > 0));
}
export function projectKey(project: ProjectIdentity): string { return `${project.kind}/${project.owner.toLowerCase()}/${project.number}`; }
export function parseProjectUrl(href: string): ProjectIdentity | null {
  try {
    const url = new URL(href);
    if (url.origin !== 'https://github.com' || url.username || url.password) return null;
    const match = /^\/(orgs|users)\/([^/]+)\/projects\/(\d+)(?:\/views\/(\d+))?\/?$/.exec(url.pathname);
    if (!match) return null;
    const project = { kind: match[1], owner: match[2], number: Number(match[3]), ...(match[4] ? { view: Number(match[4]) } : {}) };
    return isProject(project) ? project : null;
  } catch { return null; }
}
