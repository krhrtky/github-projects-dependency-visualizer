import { issueKey, type IssueIdentity } from './issue';
export interface Dependency { blocker: IssueIdentity; blocked: IssueIdentity }
export interface NodeAnalysis {
  inDegree: number;
  outDegree: number;
  depth: number | null;
  downstreamCount: number;
  critical: boolean;
  cyclic: boolean;
}
export interface GraphAnalysis {
  edges: readonly Dependency[];
  nodes: ReadonlyMap<string, NodeAnalysis>;
  maxDepth: number | null;
  branchCount: number;
  mergeCount: number;
  hasCycle: boolean;
  criticalNodeKeys: ReadonlySet<string>;
  criticalEdgeKeys: ReadonlySet<string>;
  cycleNodeKeys: ReadonlySet<string>;
  cycleEdgeKeys: ReadonlySet<string>;
}
export function edgeKey(edge: Dependency): string {
  return `${issueKey(edge.blocker)}->${issueKey(edge.blocked)}`;
}
export function normalize(dependencies: readonly Dependency[]): Dependency[] {
  const edges = new Map<string, Dependency>();
  for (const edge of dependencies) {
    const from = issueKey(edge.blocker);
    const to = issueKey(edge.blocked);
    if (from !== to) edges.set(edgeKey(edge), edge);
  }
  return [...edges.values()];
}
export function visibleGraph(dependencies: readonly Dependency[], issues: readonly IssueIdentity[]): Dependency[] {
  const visible = new Set(issues.map(issueKey));
  return normalize(dependencies).filter(e => visible.has(issueKey(e.blocker)) && visible.has(issueKey(e.blocked)));
}
function reachableFrom(start: string, outgoing: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...outgoing.get(start)!];
  for (let index = 0; index < pending.length; index += 1) {
    const key = pending[index]!;
    if (reached.has(key)) continue;
    reached.add(key);
    pending.push(...outgoing.get(key)!);
  }
  return reached;
}
export function analyzeGraph(dependencies: readonly Dependency[], issues: readonly IssueIdentity[]): GraphAnalysis {
  const keys = [...new Set(issues.map(issueKey))];
  const edges = visibleGraph(dependencies, issues);
  const outgoing = new Map(keys.map(key => [key, edges.filter(edge => issueKey(edge.blocker) === key).map(edge => issueKey(edge.blocked))]));
  const incoming = new Map(keys.map(key => [key, edges.filter(edge => issueKey(edge.blocked) === key).map(edge => issueKey(edge.blocker))]));
  const reachable = new Map(keys.map(key => [key, reachableFrom(key, outgoing)]));
  const cycleNodeKeys = new Set(keys.filter(key => reachable.get(key)!.has(key)));
  const cycleEdgeKeys = new Set(edges.filter(edge => reachable.get(issueKey(edge.blocked))!.has(issueKey(edge.blocker))).map(edgeKey));
  const hasCycle = cycleNodeKeys.size > 0;
  const depth = new Map(keys.map(key => [key, 0]));
  const remaining = new Map(keys.map(key => [key, incoming.get(key)!.length]));
  const order = keys.filter(key => remaining.get(key) === 0);
  for (let index = 0; index < order.length; index += 1) {
    const key = order[index]!;
    for (const next of outgoing.get(key)!) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(key)! + 1));
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) order.push(next);
    }
  }
  const maxDepth = hasCycle ? null : Math.max(0, ...depth.values());
  const tailDepth = new Map(keys.map(key => [key, 0]));
  for (const key of [...order].reverse()) {
    tailDepth.set(key, Math.max(0, ...outgoing.get(key)!.map(next => tailDepth.get(next)! + 1)));
  }
  const criticalNodeKeys = new Set(keys.filter(key => maxDepth !== null && maxDepth > 0 && depth.get(key)! + tailDepth.get(key)! === maxDepth));
  const criticalEdgeKeys = new Set(edges.filter(edge => maxDepth !== null && depth.get(issueKey(edge.blocker))! + 1 + tailDepth.get(issueKey(edge.blocked))! === maxDepth).map(edgeKey));
  const nodes = new Map(keys.map(key => [key, {
    inDegree: incoming.get(key)!.length,
    outDegree: outgoing.get(key)!.length,
    depth: hasCycle ? null : depth.get(key)!,
    downstreamCount: [...reachable.get(key)!].filter(descendant => descendant !== key).length,
    critical: criticalNodeKeys.has(key),
    cyclic: cycleNodeKeys.has(key),
  }]));
  return {
    edges,
    nodes,
    maxDepth,
    branchCount: [...nodes.values()].filter(node => node.outDegree > 1).length,
    mergeCount: [...nodes.values()].filter(node => node.inDegree > 1).length,
    hasCycle,
    criticalNodeKeys,
    criticalEdgeKeys,
    cycleNodeKeys,
    cycleEdgeKeys,
  };
}
