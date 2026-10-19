import { describe, expect, it, vi } from 'vitest';
import { ProjectIntegration } from '../src/background/project-integration';
import type { GitHubApi } from '../src/background/github-api';
import { parseProjectUrl, type OwnedProjectFields, type ProjectIdentity } from '../src/domain/project';
import type { IssueIdentity } from '../src/domain/issue';
import { AppError } from '../src/shared/errors';

const project: ProjectIdentity = { kind: 'orgs', owner: 'acme', number: 1, view: 2 };
const issue = (number: number): IssueIdentity => ({ owner: 'acme', repo: 'app', number });
const textField = (id: string, name: string, dataType = 'TEXT') => ({ id, name, dataType });
const statusField = () => ({ id: 'status', name: 'Dependency status', dataType: 'SINGLE_SELECT', options: ['Blocked', 'Blocking', 'Both', 'None'].map(name => ({ id: `option-${name}`, name })) });
const integrationFields = () => [textField('blockers', 'Dependency blockers'), textField('blocking', 'Dependency blocking'), statusField()];
const nativeFields = () => [textField('title', 'Title', 'TITLE'), textField('parent', 'Parent issue', 'PARENT_ISSUE'), textField('progress', 'Sub-issue progress', 'SUB_ISSUES_PROGRESS')];
const stored: OwnedProjectFields = { blockers: 'blockers', blocking: 'blocking', status: 'status' };
const item = (number: number, values: { blockers?: string; blocking?: string; status?: string } = {}) => ({
  id: `item-${number}`, isArchived: false, content: { __typename: 'Issue', url: `https://github.com/acme/app/issues/${number}`, number },
  blockers: values.blockers === undefined ? null : { text: values.blockers, field: { id: 'blockers' } },
  blocking: values.blocking === undefined ? null : { text: values.blocking, field: { id: 'blocking' } },
  status: values.status === undefined ? null : { optionId: `option-${values.status}`, field: { id: 'status' } }
});
function page(nodes: unknown[], next: string | null = null) { return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } }; }
function fixture(options: { owned?: OwnedProjectFields | null; fields?: ReturnType<typeof nativeFields>; pages?: unknown[][]; layout?: string; visible?: string[] } = {}) {
  const fields: Record<string, unknown>[] = [...(options.fields ?? nativeFields())];
  const pages = options.pages ?? [[item(1), item(2)]];
  const events: string[] = [];
  const ownership = { value: options.owned ?? null as OwnedProjectFields | null };
  const store = {
    get: vi.fn(async () => ownership.value),
    set: vi.fn(async (_key: string, value: OwnedProjectFields) => { ownership.value = { ...value }; })
  };
  const graphql = vi.fn(async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    if (query.includes('query IntegrationProject')) return { owner: { projectV2: { id: 'project-1' } } };
    if (query.includes('query IntegrationFields')) return { node: { fields: page(fields) } };
    if (query.includes('query IntegrationItems')) {
      const index = variables.after === null ? 0 : Number(variables.after);
      return { node: { items: page(pages[index]!, index + 1 < pages.length ? String(index + 1) : null) } };
    }
    if (query.includes('query IntegrationView')) return { node: { view: { id: 'view-2', number: 2, layout: options.layout ?? 'TABLE_LAYOUT', configuration: { visibleFields: page((options.visible ?? ['title']).map(id => ({ id }))) } } } };
    events.push('write');
    const input = variables.input as Record<string, unknown>;
    if (query.includes('mutation IntegrationCreateField')) {
      const key = input.name === 'Dependency blockers' ? 'blockers' : input.name === 'Dependency blocking' ? 'blocking' : 'status';
      const field = key === 'status' ? statusField() : textField(key, String(input.name));
      fields.push(field);
      return { createProjectV2Field: { projectV2Field: field } };
    }
    if (query.includes('mutation IntegrationShowFields')) return { updateProjectV2View: { projectV2View: { id: 'view-2' } } };
    if (query.includes('mutation IntegrationUpdateItem')) return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key.replace('input', 'value'), { projectV2Item: { id: (value as { itemId: string }).itemId } }]));
    throw new Error(`Unexpected operation ${query}`);
  });
  const dependencySummary = vi.fn(async (identity: IssueIdentity) => { events.push(`read-${identity.number}`); return { blockedBy: [] as IssueIdentity[], blocking: [] as IssueIdentity[] }; });
  const relationships = vi.fn();
  const api = { graphql, dependencySummary, relationships } as unknown as Pick<GitHubApi, 'graphql' | 'dependencySummary' | 'relationships'>;
  const integration = new ProjectIntegration(api, store);
  const writes = () => graphql.mock.calls.filter(([query]) => query.startsWith('mutation'));
  const updates = () => graphql.mock.calls.filter(([query]) => query.includes('mutation IntegrationUpdateItem'));
  return { integration, api, store, graphql, dependencySummary, relationships, ownership, events, fields, writes, updates };
}

describe('project identity', () => {
  it('preserves an explicit view and rejects other origins and unsupported paths', () => {
    expect(parseProjectUrl('https://github.com/orgs/acme/projects/1/views/2?pane=issue')).toEqual(project);
    expect(parseProjectUrl('https://github.com/users/octocat/projects/3')).toEqual({ kind: 'users', owner: 'octocat', number: 3 });
    for (const url of ['https://evil.test/orgs/acme/projects/1', 'https://github.com/orgs/acme/projects/0', 'https://github.com/orgs/acme/projects/1/settings', 'https://user@github.com/orgs/acme/projects/1']) expect(parseProjectUrl(url)).toBeNull();
  });
});

describe('project integration', () => {
  it('previews every project page without reading relationships or writing fields', async () => {
    const f = fixture({ pages: [[item(1), { id: 'draft', isArchived: false, content: { __typename: 'DraftIssue' } }], [item(2), null, { id: 'pr', isArchived: false, content: { __typename: 'PullRequest' } }]] });
    expect(await f.integration.preview(project)).toEqual({
      project, projectId: 'project-1', issueCount: 2, skipped: 3,
      fieldsToCreate: ['Dependency blockers', 'Dependency blocking', 'Dependency status'],
      fieldsToShow: ['Dependency blockers', 'Dependency blocking', 'Dependency status', 'Parent issue', 'Sub-issue progress']
    });
    expect(f.dependencySummary).not.toHaveBeenCalled();
    expect(f.writes()).toEqual([]);
    expect(f.store.set).not.toHaveBeenCalled();
  });

  it('reads all issues before creating its three fields and writes sorted relationships project-wide', async () => {
    const f = fixture({ pages: [[item(1)], [item(2)]] });
    f.dependencySummary.mockImplementation(async identity => {
      f.events.push(`read-${identity.number}`);
      return { blockedBy: identity.number === 1 ? [issue(4), issue(3), issue(3)] : [], blocking: identity.number === 2 ? [issue(1)] : [] };
    });
    const report = await f.integration.sync(project);
    expect(report).toMatchObject({ issueCount: 2, changed: 2, failed: [], createdFields: ['Dependency blockers', 'Dependency blocking', 'Dependency status'] });
    expect(f.events.slice(0, 2)).toEqual(['read-1', 'read-2']);
    expect(f.ownership.value).toEqual(stored);
    expect(f.store.set).toHaveBeenCalledTimes(3);
    expect(f.relationships).not.toHaveBeenCalled();
    expect(f.updates()[0]![1]).toEqual({
      input0: { projectId: 'project-1', itemId: 'item-1', fieldId: 'blockers', value: { text: 'acme/app#3, acme/app#4' } },
      input1: { projectId: 'project-1', itemId: 'item-1', fieldId: 'status', value: { singleSelectOptionId: 'option-Blocked' } }
    });
    const show = f.writes().find(([query]) => query.includes('IntegrationShowFields'))!;
    expect(show[1]).toEqual({ input: { viewId: 'view-2', configuration: { visibleFieldIds: ['title', 'blockers', 'blocking', 'status', 'parent', 'progress'] } } });
    expect(show[0]).not.toMatch(/\bfilter\s*:/);
    expect(f.fields.filter(field => field.name === 'Parent issue')).toHaveLength(1);
  });

  it('keeps failed relationship rows untouched and reports only safe errors', async () => {
    const f = fixture({ owned: stored, fields: [...nativeFields(), ...integrationFields()], pages: [[item(1, { blockers: 'acme/app#9', status: 'Blocked' }), item(2)]] });
    f.dependencySummary.mockImplementation(async identity => {
      if (identity.number === 1) throw new AppError('FORBIDDEN');
      return { blockedBy: [], blocking: [] };
    });
    const report = await f.integration.sync({ ...project, view: undefined });
    expect(report.failed).toEqual([{ issue: issue(1), error: { code: 'FORBIDDEN' } }]);
    expect(report.changed).toBe(1);
    expect(f.updates().every(([, variables]) => Object.values(variables).every(value => (value as { itemId: string }).itemId === 'item-2'))).toBe(true);
  });

  it('skips unchanged values and clears removed dependency text', async () => {
    const f = fixture({ owned: stored, fields: [...nativeFields(), ...integrationFields()], pages: [[item(1, { status: 'None' }), item(2, { blockers: 'acme/app#1', blocking: 'acme/app#3', status: 'Both' })]], visible: ['title', 'blockers', 'blocking', 'status', 'parent', 'progress'] });
    const report = await f.integration.sync(project);
    expect(report.changed).toBe(1);
    expect(report.createdFields).toEqual([]);
    expect(f.writes()).toHaveLength(1);
    const [query, variables] = f.updates()[0]!;
    expect(query.match(/clearProjectV2ItemFieldValue/g)).toHaveLength(2);
    expect(variables).toEqual({
      input0: { projectId: 'project-1', itemId: 'item-2', fieldId: 'blockers' },
      input1: { projectId: 'project-1', itemId: 'item-2', fieldId: 'blocking' },
      input2: { projectId: 'project-1', itemId: 'item-2', fieldId: 'status', value: { singleSelectOptionId: 'option-None' } }
    });
  });

  it.each(['TEXT', 'NUMBER'])('does not adopt a same-name %s field without recorded ownership', async dataType => {
    const f = fixture({ fields: [...nativeFields(), textField('someone-else', 'Dependency blockers', dataType)] });
    await expect(f.integration.sync(project)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.writes()).toEqual([]);
    expect(f.dependencySummary).not.toHaveBeenCalled();
  });

  it('rejects changed types and missing status options on fields it owns', async () => {
    const wrongType = fixture({ owned: stored, fields: [...nativeFields(), textField('blockers', 'Dependency blockers', 'NUMBER')] });
    await expect(wrongType.integration.preview(project)).rejects.toMatchObject({ code: 'CONFLICT' });
    const missingOptions = fixture({ owned: stored, fields: [...nativeFields(), { ...statusField(), options: [] }] as ReturnType<typeof nativeFields> });
    await expect(missingOptions.integration.sync(project)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(missingOptions.writes()).toEqual([]);
  });

  it('rejects a cursor cycle before reading relationships or writing anything', async () => {
    const f = fixture();
    const original = f.graphql.getMockImplementation()!;
    f.graphql.mockImplementation(async (query, variables) => query.includes('IntegrationItems') ? { node: { items: page([item(variables.after === null ? 1 : 2)], 'same-cursor') } } : original(query, variables));
    await expect(f.integration.sync(project)).rejects.toMatchObject({ code: 'SCHEMA' });
    expect(f.writes()).toEqual([]);
    expect(f.dependencySummary).not.toHaveBeenCalled();
  });

  it('stops at 1000 active issues before any relationship read or mutation', async () => {
    const pages = Array.from({ length: 11 }, (_, index) => Array.from({ length: 100 }, (_, offset) => item(index * 100 + offset + 1)));
    const f = fixture({ pages });
    await expect(f.integration.sync(project)).rejects.toMatchObject({ code: 'LIMIT' });
    expect(f.writes()).toEqual([]);
    expect(f.dependencySummary).not.toHaveBeenCalled();
  });

  it('retains ownership of fields created before an interrupted setup', async () => {
    const f = fixture();
    const original = f.graphql.getMockImplementation()!;
    f.graphql.mockImplementation(async (query, variables) => {
      if (query.includes('IntegrationCreateField') && (variables.input as { name: string }).name === 'Dependency blocking') throw new AppError('NETWORK');
      return original(query, variables);
    });
    await expect(f.integration.sync(project)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(f.ownership.value).toEqual({ blockers: 'blockers' });
    f.graphql.mockImplementation(original);
    expect((await f.integration.sync(project)).createdFields).toEqual(['Dependency blocking', 'Dependency status']);
    expect(f.fields.filter(field => field.id === 'blockers')).toHaveLength(1);
  });

  it('does not change Roadmap display configuration', async () => {
    const f = fixture({ layout: 'ROADMAP_LAYOUT' });
    expect((await f.integration.preview(project)).fieldsToShow).toEqual([]);
    expect((await f.integration.sync(project)).fieldsToShow).toEqual([]);
    expect(f.writes().some(([query]) => query.includes('IntegrationShowFields'))).toBe(false);
  });

  it('preserves fields saved to the view while dependencies were being read', async () => {
    const visible = ['title'];
    const f = fixture({ visible, fields: [...nativeFields(), textField('priority', 'Priority')] });
    f.dependencySummary.mockImplementation(async () => {
      if (!visible.includes('priority')) visible.push('priority');
      return { blockedBy: [], blocking: [] };
    });
    await f.integration.sync(project);
    const show = f.writes().find(([query]) => query.includes('IntegrationShowFields'))!;
    expect(show[1]).toEqual({ input: { viewId: 'view-2', configuration: { visibleFieldIds: ['title', 'priority', 'blockers', 'blocking', 'status', 'parent', 'progress'] } } });
  });

  it('returns completed issue updates when displaying fields fails', async () => {
    const f = fixture();
    const original = f.graphql.getMockImplementation()!;
    f.graphql.mockImplementation(async (query, variables) => {
      if (query.includes('IntegrationShowFields')) throw new AppError('FORBIDDEN');
      return original(query, variables);
    });
    expect(await f.integration.sync(project)).toMatchObject({ changed: 2, failed: [], viewError: { code: 'FORBIDDEN' } });
  });

  it('does not refresh a project before integration fields are owned', async () => {
    const f = fixture();
    expect(await f.integration.refresh(project, [issue(1)])).toBeNull();
    expect(f.graphql).not.toHaveBeenCalled();
  });

  it('refreshes only affected issues and never creates fields or changes views', async () => {
    const f = fixture({ owned: stored, fields: [...nativeFields(), ...integrationFields()], pages: [[item(1), item(2), item(3)]] });
    const result = await f.integration.refresh(project, [issue(2)]);
    expect(result).toMatchObject({ issueCount: 1, changed: 1, createdFields: [], fieldsToCreate: [], fieldsToShow: [] });
    expect(f.dependencySummary.mock.calls.map(([identity]) => identity.number)).toEqual([2]);
    expect(f.writes()).toHaveLength(1);
    expect(f.updates()).toHaveLength(1);
  });

  it('refreshes partial ownership without creating the missing fields', async () => {
    const f = fixture({ owned: { blockers: 'blockers' }, fields: [...nativeFields(), textField('blockers', 'Dependency blockers')], pages: [[item(1, { blockers: 'acme/app#2' })]] });
    const report = await f.integration.refresh(project, [issue(1)]);
    expect(report).toMatchObject({ changed: 1, createdFields: [], failed: [] });
    expect(f.writes()).toHaveLength(1);
    expect(f.updates()[0]![1]).toEqual({ input0: { projectId: 'project-1', itemId: 'item-1', fieldId: 'blockers' } });
  });
});
