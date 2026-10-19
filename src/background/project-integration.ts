import { isIssue, issueKey, parseIssueUrl, type IssueIdentity } from '../domain/issue';
import { isProject, projectKey, type OwnedProjectFields, type ProjectFieldStore, type ProjectIdentity, type ProjectIntegrationPreview, type ProjectSyncFailure, type ProjectSyncReport } from '../domain/project';
import { AppError, safeError } from '../shared/errors';
import type { GitHubApi } from './github-api';

type FieldKey = keyof OwnedProjectFields;
interface ProjectField { id: string; name: string; dataType: string; options: { id: string; name: string }[] }
interface ProjectItem { id: string; issue: IssueIdentity; values: Partial<Record<FieldKey, string>> }
interface ProjectView { id: string; layout: string; visible: string[] }
interface Snapshot {
  project: ProjectIdentity; id: string; fields: ProjectField[]; items: ProjectItem[]; skipped: number;
  owned: OwnedProjectFields; view: ProjectView | null;
}
interface Projection { blockers: string; blocking: string; status: 'Blocked' | 'Blocking' | 'Both' | 'None' }
type IntegrationApi = Pick<GitHubApi, 'graphql' | 'relationships'> & Partial<Pick<GitHubApi, 'dependencySummary'>>;
const MAX_PROJECT_ISSUES = 1000;
const FIELD_DEFINITIONS = [
  { key: 'blockers', name: 'Dependency blockers', dataType: 'TEXT' },
  { key: 'blocking', name: 'Dependency blocking', dataType: 'TEXT' },
  { key: 'status', name: 'Dependency status', dataType: 'SINGLE_SELECT' }
] as const;
const STATUS_OPTIONS = [
  { name: 'Blocked', color: 'RED', description: 'Blocked by another issue.' },
  { name: 'Blocking', color: 'ORANGE', description: 'Blocks another issue.' },
  { name: 'Both', color: 'PURPLE', description: 'Blocked by and blocks other issues.' },
  { name: 'None', color: 'GRAY', description: 'No issue dependencies.' }
] as const;
const FIELD_FRAGMENT = `... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name } }`;
const FIELDS_QUERY = `query IntegrationFields($projectId: ID!, $after: String) {
  node(id: $projectId) { ... on ProjectV2 { fields(first: 100, after: $after) {
    nodes { ${FIELD_FRAGMENT} } pageInfo { hasNextPage endCursor }
  } } }
}`;
const ITEMS_QUERY = `query IntegrationItems($projectId: ID!, $after: String) {
  node(id: $projectId) { ... on ProjectV2 { items(first: 100, after: $after, archivedStates: [NOT_ARCHIVED]) {
    nodes { id isArchived content { __typename ... on Issue { url number } }
      blockers: fieldValueByName(name: "Dependency blockers") { ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } } }
      blocking: fieldValueByName(name: "Dependency blocking") { ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } } }
      status: fieldValueByName(name: "Dependency status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } } }
    } pageInfo { hasNextPage endCursor }
  } } }
}`;
const VIEW_QUERY = `query IntegrationView($projectId: ID!, $view: Int!, $after: String) {
  node(id: $projectId) { ... on ProjectV2 { view(number: $view) {
    id number layout configuration { visibleFields(first: 100, after: $after) {
      nodes { ... on ProjectV2FieldCommon { id } } pageInfo { hasNextPage endCursor }
    } }
  } } }
}`;
const CREATE_FIELD = `mutation IntegrationCreateField($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) { projectV2Field { ${FIELD_FRAGMENT} } }
}`;
const UPDATE_VIEW = `mutation IntegrationShowFields($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) { projectV2View { id } }
}`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('SCHEMA');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new AppError('SCHEMA');
  return value;
}
function connection(value: unknown, seen: Set<string>): { nodes: unknown[]; next: string | null } {
  const data = object(value);
  const info = object(data.pageInfo);
  if (!Array.isArray(data.nodes) || data.nodes.length > 100 || typeof info.hasNextPage !== 'boolean') throw new AppError('SCHEMA');
  if (!info.hasNextPage) return { nodes: data.nodes, next: null };
  const cursor = identifier(info.endCursor);
  if (!data.nodes.length || seen.has(cursor)) throw new AppError('SCHEMA');
  seen.add(cursor);
  return { nodes: data.nodes, next: cursor };
}
function parseField(value: unknown): ProjectField {
  const field = object(value);
  const id = identifier(field.id);
  if (typeof field.name !== 'string' || !field.name || typeof field.dataType !== 'string' || !field.dataType) throw new AppError('SCHEMA');
  const options = field.dataType === 'SINGLE_SELECT' ? field.options : [];
  if (!Array.isArray(options)) throw new AppError('SCHEMA');
  const parsed = options.map(value => {
    const option = object(value);
    if (typeof option.name !== 'string') throw new AppError('SCHEMA');
    return { id: identifier(option.id), name: option.name };
  });
  if (new Set(parsed.map(option => option.id)).size !== parsed.length || new Set(parsed.map(option => option.name)).size !== parsed.length) throw new AppError('SCHEMA');
  return { id, name: field.name, dataType: field.dataType, options: parsed };
}
function ownedField(snapshot: Pick<Snapshot, 'owned' | 'fields'>, key: FieldKey): ProjectField | undefined {
  return snapshot.fields.find(field => field.id === snapshot.owned[key]);
}
function validateOwnership(fields: ProjectField[], owned: OwnedProjectFields): void {
  const ids = Object.values(owned);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new AppError('CONFLICT');
  for (const definition of FIELD_DEFINITIONS) {
    const namesakes = fields.filter(field => field.name.toLowerCase() === definition.name.toLowerCase());
    const field = fields.find(candidate => candidate.id === owned[definition.key]);
    if (namesakes.some(candidate => candidate.id !== field?.id)
      || (field && (field.name !== definition.name || field.dataType !== definition.dataType))) throw new AppError('CONFLICT');
    if (field && definition.key === 'status' && STATUS_OPTIONS.some(option => !field.options.some(candidate => candidate.name === option.name))) throw new AppError('CONFLICT');
  }
}
function fieldNamesToShow(snapshot: Snapshot): string[] {
  if (!snapshot.view || snapshot.view.layout === 'ROADMAP_LAYOUT') return [];
  return [
    ...FIELD_DEFINITIONS.filter(definition => !snapshot.view!.visible.includes(snapshot.owned[definition.key] ?? '')).map(definition => definition.name),
    ...snapshot.fields.filter(field => ['PARENT_ISSUE', 'SUB_ISSUES_PROGRESS'].includes(field.dataType) && !snapshot.view!.visible.includes(field.id)).map(field => field.name)
  ];
}
function previewOf(snapshot: Snapshot): ProjectIntegrationPreview {
  return {
    project: snapshot.project, projectId: snapshot.id, issueCount: snapshot.items.length, skipped: snapshot.skipped,
    fieldsToCreate: FIELD_DEFINITIONS.filter(definition => !ownedField(snapshot, definition.key)).map(definition => definition.name),
    fieldsToShow: fieldNamesToShow(snapshot)
  };
}
function projection(blockedBy: IssueIdentity[], blocking: IssueIdentity[]): Projection {
  const format = (issues: IssueIdentity[]) => [...new Set(issues.map(issueKey))].sort().join(', ');
  return {
    blockers: format(blockedBy), blocking: format(blocking),
    status: blockedBy.length ? (blocking.length ? 'Both' : 'Blocked') : (blocking.length ? 'Blocking' : 'None')
  };
}
async function mapConcurrent<T, U>(values: T[], operation: (value: T) => Promise<U>): Promise<U[]> {
  const groups = Array.from({ length: Math.ceil(values.length / 4) }, (_, index) => values.slice(index * 4, index * 4 + 4));
  const results: U[] = [];
  for (const group of groups) results.push(...await Promise.all(group.map(operation)));
  return results;
}

export class ProjectIntegration {
  private readonly running = new Set<string>();
  constructor(private readonly api: IntegrationApi, private readonly store: ProjectFieldStore) {}

  async preview(project: ProjectIdentity): Promise<ProjectIntegrationPreview> { return previewOf(await this.snapshot(project)); }

  async sync(project: ProjectIdentity): Promise<ProjectSyncReport> {
    if (!isProject(project)) throw new AppError('MESSAGE');
    const key = projectKey(project);
    if (this.running.has(key)) throw new AppError('CONFLICT');
    this.running.add(key);
    try { return await this.synchronize(await this.snapshot(project)); }
    finally { this.running.delete(key); }
  }

  async refresh(project: ProjectIdentity, issues: IssueIdentity[]): Promise<ProjectSyncReport | null> {
    if (!isProject(project) || !Array.isArray(issues) || issues.length > MAX_PROJECT_ISSUES || !issues.every(isIssue)) throw new AppError('MESSAGE');
    const key = projectKey(project);
    const owned = await this.store.get(key);
    if (!owned || !Object.keys(owned).length) return null;
    if (this.running.has(key)) throw new AppError('CONFLICT');
    this.running.add(key);
    try {
      const snapshot = await this.snapshot(project);
      const affected = new Set(issues.map(issueKey));
      return await this.synchronize({ ...snapshot, items: snapshot.items.filter(item => affected.has(issueKey(item.issue))), view: null }, false);
    } finally { this.running.delete(key); }
  }

  private async snapshot(project: ProjectIdentity): Promise<Snapshot> {
    if (!isProject(project)) throw new AppError('MESSAGE');
    const ownerType = project.kind === 'orgs' ? 'organization' : 'user';
    const result = object(await this.api.graphql<unknown>(`query IntegrationProject($owner: String!, $number: Int!) {
      owner: ${ownerType}(login: $owner) { projectV2(number: $number) { id } }
    }`, { owner: project.owner, number: project.number }));
    if (result.owner === null || object(result.owner).projectV2 === null) throw new AppError('NOT_FOUND');
    const id = identifier(object(object(result.owner).projectV2).id);
    const fields = await this.fields(id);
    const owned = await this.store.get(projectKey(project)) ?? {};
    validateOwnership(fields, owned);
    const { items, skipped } = await this.items(id, fields);
    const view = project.view === undefined ? null : await this.view(id, project.view);
    return { project, id, fields, owned, items, skipped, view };
  }

  private async fields(projectId: string): Promise<ProjectField[]> {
    const result: ProjectField[] = [];
    const seen = new Set<string>();
    for (let after: string | null = null; ;) {
      const data = object(await this.api.graphql<unknown>(FIELDS_QUERY, { projectId, after }));
      const page = connection(object(data.node).fields, seen);
      result.push(...page.nodes.map(parseField));
      if (new Set(result.map(field => field.id)).size !== result.length) throw new AppError('SCHEMA');
      if (!page.next) return result;
      if (result.length > 1000) throw new AppError('LIMIT');
      after = page.next;
    }
  }

  private async items(projectId: string, fields: ProjectField[]): Promise<{ items: ProjectItem[]; skipped: number }> {
    const items: ProjectItem[] = [];
    const seen = new Set<string>();
    const itemIds = new Set<string>();
    const issues = new Set<string>();
    const skippedItems: unknown[] = [];
    for (let after: string | null = null; ;) {
      const data = object(await this.api.graphql<unknown>(ITEMS_QUERY, { projectId, after }));
      const page = connection(object(data.node).items, seen);
      for (const value of page.nodes) {
        if (value === null) { skippedItems.push(value); continue; }
        const row = object(value);
        const id = identifier(row.id);
        if (itemIds.has(id) || typeof row.isArchived !== 'boolean') throw new AppError('SCHEMA');
        itemIds.add(id);
        if (row.isArchived || row.content === null) { skippedItems.push(value); continue; }
        const content = object(row.content);
        if (content.__typename !== 'Issue') { skippedItems.push(value); continue; }
        const issue = typeof content.url === 'string' ? parseIssueUrl(content.url) : null;
        if (!issue || issue.number !== content.number || issues.has(issueKey(issue))) throw new AppError('SCHEMA');
        issues.add(issueKey(issue));
        const values = Object.fromEntries(FIELD_DEFINITIONS.flatMap(definition => {
          const raw = row[definition.key];
          if (raw === null) return [];
          const current = object(raw);
          const field = fields.find(candidate => candidate.name === definition.name);
          if (!field || object(current.field).id !== field.id) throw new AppError('SCHEMA');
          const fieldValue = current[definition.key === 'status' ? 'optionId' : 'text'];
          if (typeof fieldValue !== 'string') throw new AppError('SCHEMA');
          return [[definition.key, fieldValue]];
        }));
        items.push({ id, issue, values });
        if (items.length > MAX_PROJECT_ISSUES) throw new AppError('LIMIT');
      }
      if (!page.next) return { items, skipped: skippedItems.length };
      if (seen.size >= 1000) throw new AppError('LIMIT');
      after = page.next;
    }
  }

  private async view(projectId: string, viewNumber: number): Promise<ProjectView> {
    const visible: string[] = [];
    const seen = new Set<string>();
    let first: ProjectView | null = null;
    for (let after: string | null = null; ;) {
      const data = object(await this.api.graphql<unknown>(VIEW_QUERY, { projectId, view: viewNumber, after }));
      const raw = object(data.node).view;
      if (raw === null) throw new AppError('NOT_FOUND');
      const view = object(raw);
      const id = identifier(view.id);
      if (view.number !== viewNumber || !['TABLE_LAYOUT', 'BOARD_LAYOUT', 'ROADMAP_LAYOUT'].includes(String(view.layout))) throw new AppError('SCHEMA');
      if (first && (first.id !== id || first.layout !== view.layout)) throw new AppError('SCHEMA');
      first ??= { id, layout: String(view.layout), visible };
      const page = connection(object(view.configuration).visibleFields, seen);
      visible.push(...page.nodes.map(value => identifier(object(value).id)));
      if (new Set(visible).size !== visible.length) throw new AppError('SCHEMA');
      if (!page.next) return first;
      if (visible.length > 1000) throw new AppError('LIMIT');
      after = page.next;
    }
  }

  private async synchronize(snapshot: Snapshot, createFields = true): Promise<ProjectSyncReport> {
    const preview = { ...previewOf(snapshot), ...(!createFields ? { fieldsToCreate: [], fieldsToShow: [] } : {}) };
    const readings = await mapConcurrent(snapshot.items, async item => {
      try {
        const relations = this.api.dependencySummary ? await this.api.dependencySummary(item.issue) : await this.api.relationships(item.issue);
        return { item, projection: projection(relations.blockedBy, relations.blocking) };
      } catch (error) { return { item, error: safeError(error) }; }
    });
    const createdFields: string[] = [];
    for (const definition of FIELD_DEFINITIONS) {
      if (!createFields) break;
      if (ownedField(snapshot, definition.key)) continue;
      const input = { projectId: snapshot.id, name: definition.name, dataType: definition.dataType,
        ...(definition.key === 'status' ? { singleSelectOptions: STATUS_OPTIONS } : {}) };
      const response = object(await this.api.graphql<unknown>(CREATE_FIELD, { input }));
      const field = parseField(object(response.createProjectV2Field).projectV2Field);
      const candidate = { fields: [...snapshot.fields, field], owned: { ...snapshot.owned, [definition.key]: field.id } };
      validateOwnership(candidate.fields, candidate.owned);
      snapshot.fields = candidate.fields;
      snapshot.owned = candidate.owned;
      await this.store.set(projectKey(snapshot.project), snapshot.owned);
      createdFields.push(field.name);
    }
    const outcomes = await mapConcurrent(readings, async reading => {
      if (reading.error) return { changed: false, failure: { issue: reading.item.issue, error: reading.error } };
      try {
        const changed = await this.updateItem(snapshot, reading.item, reading.projection!);
        return { changed };
      } catch (error) { return { changed: false, failure: { issue: reading.item.issue, error: safeError(error) } }; }
    });
    const failed: ProjectSyncFailure[] = outcomes.flatMap(outcome => outcome.failure ? [outcome.failure] : []);
    const report: ProjectSyncReport = { ...preview, createdFields, changed: outcomes.filter(outcome => outcome.changed).length, failed };
    if (!snapshot.view || snapshot.view.layout === 'ROADMAP_LAYOUT') return report;
    try {
      const view = await this.view(snapshot.id, snapshot.project.view!);
      if (view.layout === 'ROADMAP_LAYOUT') return report;
      const additions = [
        ...FIELD_DEFINITIONS.map(definition => identifier(snapshot.owned[definition.key])),
        ...snapshot.fields.filter(field => ['PARENT_ISSUE', 'SUB_ISSUES_PROGRESS'].includes(field.dataType)).map(field => field.id)
      ];
      const visibleFieldIds = [...new Set([...view.visible, ...additions])];
      if (visibleFieldIds.length === view.visible.length) return report;
      const result = object(await this.api.graphql<unknown>(UPDATE_VIEW, { input: { viewId: view.id, configuration: { visibleFieldIds } } }));
      if (object(object(result.updateProjectV2View).projectV2View).id !== view.id) throw new AppError('SCHEMA');
      return report;
    } catch (error) { return { ...report, viewError: safeError(error) }; }
  }

  private async updateItem(snapshot: Snapshot, item: ProjectItem, desired: Projection): Promise<boolean> {
    const statusField = ownedField(snapshot, 'status');
    const statusId = statusField?.options.find(option => option.name === desired.status)?.id;
    if (statusField && !statusId) throw new AppError('CONFLICT');
    const values = { blockers: desired.blockers, blocking: desired.blocking, status: statusId ?? '' };
    const changes = FIELD_DEFINITIONS.filter(definition => ownedField(snapshot, definition.key) && (item.values[definition.key] ?? '') !== values[definition.key]);
    if (!changes.length) return false;
    const declarations = changes.map((definition, index) => `$input${index}: ${values[definition.key] ? 'UpdateProjectV2ItemFieldValueInput' : 'ClearProjectV2ItemFieldValueInput'}!`);
    const mutations = changes.map((definition, index) => `value${index}: ${values[definition.key] ? 'updateProjectV2ItemFieldValue' : 'clearProjectV2ItemFieldValue'}(input: $input${index}) { projectV2Item { id } }`);
    const variables = Object.fromEntries(changes.map((definition, index) => [`input${index}`, {
      projectId: snapshot.id, itemId: item.id, fieldId: identifier(snapshot.owned[definition.key]),
      ...(values[definition.key] ? { value: definition.key === 'status' ? { singleSelectOptionId: statusId } : { text: values[definition.key] } } : {})
    }]));
    const response = object(await this.api.graphql<unknown>(`mutation IntegrationUpdateItem(${declarations.join(', ')}) { ${mutations.join('\n')} }`, variables));
    for (const [index] of changes.entries()) if (object(object(response[`value${index}`]).projectV2Item).id !== item.id) throw new AppError('SCHEMA');
    return true;
  }
}
