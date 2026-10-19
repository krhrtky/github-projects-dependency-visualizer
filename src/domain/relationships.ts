import type { IssueIdentity } from './issue';

export interface IssueRelationships {
  blockedBy: IssueIdentity[];
  blocking: IssueIdentity[];
  parent: IssueIdentity | null;
  children: IssueIdentity[];
}

export type RelationshipKind = 'blockedBy' | 'blocking' | 'parent' | 'child';
export interface ChangeRelationship {
  issue: IssueIdentity;
  related: IssueIdentity;
  kind: RelationshipKind;
  action: 'add' | 'remove';
}
