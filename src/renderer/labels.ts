import type { Dependency, NodeAnalysis } from '../domain/graph';
import { issueKey } from '../domain/issue';

export function issueLabels(keys: Iterable<string>): ReadonlyMap<string, string> {
  const issues = [...new Set(keys)].map(key => {
    const separator = key.lastIndexOf('#');
    const repository = key.slice(0, separator);
    return { key, repository, repo: repository.slice(repository.lastIndexOf('/') + 1), number: key.slice(separator) };
  });
  const repositories = new Set(issues.map(issue => issue.repository));
  return new Map(issues.map(issue => {
    if (repositories.size === 1) return [issue.key, issue.number];
    const owners = new Set(issues.filter(other => other.repo === issue.repo).map(other => other.repository));
    return [issue.key, `${owners.size > 1 ? issue.repository : issue.repo}${issue.number}`];
  }));
}

export function dependencyPair(edge: Dependency, labels: ReadonlyMap<string, string>): string {
  return `${labels.get(issueKey(edge.blocker)) ?? issueKey(edge.blocker)} → ${labels.get(issueKey(edge.blocked)) ?? issueKey(edge.blocked)}`;
}

export function dependencySentence(edge: Dependency, labels: ReadonlyMap<string, string>): string {
  return `${labels.get(issueKey(edge.blocked)) ?? issueKey(edge.blocked)} は ${labels.get(issueKey(edge.blocker)) ?? issueKey(edge.blocker)} に依存`;
}

export function dependencyDepth(edge: Dependency, nodes: ReadonlyMap<string, NodeAnalysis>): string {
  const from = nodes.get(issueKey(edge.blocker))!.depth;
  const to = nodes.get(issueKey(edge.blocked))!.depth;
  return from === null || to === null ? '深さ 未算出' : `深さ ${from} → ${to}`;
}
