import { describe, expect, it } from 'vitest';
import { issueKey, parseIssueUrl, isIssue } from '../src/domain/issue';
import { analyzeGraph, edgeKey, normalize, visibleGraph, type Dependency } from '../src/domain/graph';
const a = { owner: 'acme', repo: 'app', number: 1 };
const b = { owner: 'acme', repo: 'api', number: 1 };
const c = { ...b, number: 2 };
const d = { ...a, number: 2 };
const e = { ...a, number: 3 };
const f = { ...a, number: 4 };
const dependency = (blocker: typeof a, blocked: typeof a): Dependency => ({ blocker, blocked });
describe('Issue identity and graph', () => {
  it('parses issue URLs and rejects PRs, foreign hosts and path traversal', () => {
    expect(parseIssueUrl('https://github.com/acme/app/issues/1?x=1')).toEqual(a);
    for (const url of ['https://evil.test/acme/app/issues/1', '/acme/app/pull/1', '/acme/app/issues/0', '/acme/app/issues/1/extra', 'https://u:p@github.com/acme/app/issues/1', '/acme/%2E%2E/issues/1']) expect(parseIssueUrl(url)).toBeNull();
    expect(isIssue({ ...a, repo: '..' })).toBe(false);
    expect(isIssue({ ...a, number: 1.1 })).toBe(false);
  });
  it('keeps blocker -> blocked and distinguishes repositories', () => {
    const edge = { blocker: a, blocked: b };
    expect(issueKey(a)).not.toBe(issueKey(b));
    expect(normalize([edge, edge, { blocker: a, blocked: a }])).toEqual([edge]);
    expect(normalize([edge, { blocker: { ...a, owner: 'ACME' }, blocked: b }])).toHaveLength(1);
    expect(visibleGraph([edge, { blocker: a, blocked: c }], [a, b])).toEqual([edge]);
    expect(visibleGraph([edge], [a])).toEqual([]);
    expect(normalize([])).toEqual([]);
  });
});
describe('Visible dependency analysis', () => {
  it('measures dependency steps, branching, merging and unique downstream impact', () => {
    const dependencies = [dependency(a, b), dependency(b, c), dependency(c, d), dependency(a, e), dependency(e, d)];
    const analysis = analyzeGraph(dependencies, [a, b, c, d, e, f]);
    expect(analysis.maxDepth).toBe(3);
    expect(analysis.hasCycle).toBe(false);
    expect(analysis.branchCount).toBe(1);
    expect(analysis.mergeCount).toBe(1);
    expect(analysis.nodes.get(issueKey(a))).toEqual({ inDegree: 0, outDegree: 2, depth: 0, downstreamCount: 4, critical: true, cyclic: false });
    expect(analysis.nodes.get(issueKey(d))).toEqual({ inDegree: 2, outDegree: 0, depth: 3, downstreamCount: 0, critical: true, cyclic: false });
    expect(analysis.nodes.get(issueKey(e))).toEqual({ inDegree: 1, outDegree: 1, depth: 1, downstreamCount: 1, critical: false, cyclic: false });
    expect(analysis.nodes.get(issueKey(f))).toEqual({ inDegree: 0, outDegree: 0, depth: 0, downstreamCount: 0, critical: false, cyclic: false });
    expect(analysis.criticalNodeKeys).toEqual(new Set([a, b, c, d].map(issueKey)));
    expect(analysis.criticalEdgeKeys).toEqual(new Set(dependencies.slice(0, 3).map(edgeKey)));
  });
  it('includes every equal-length longest path through a split and join', () => {
    const dependencies = [dependency(a, b), dependency(a, c), dependency(b, d), dependency(c, d)];
    const analysis = analyzeGraph(dependencies, [a, b, c, d]);
    expect(analysis.maxDepth).toBe(2);
    expect(analysis.nodes.get(issueKey(a))?.downstreamCount).toBe(3);
    expect(analysis.criticalNodeKeys).toEqual(new Set([a, b, c, d].map(issueKey)));
    expect(analysis.criticalEdgeKeys).toEqual(new Set(dependencies.map(edgeKey)));
  });
  it('compares paths across disconnected components and distinct repositories', () => {
    const dependencies = [dependency(a, b), dependency(b, c), dependency(d, e)];
    const analysis = analyzeGraph(dependencies, [a, b, c, d, e]);
    expect(analysis.nodes.size).toBe(5);
    expect(analysis.maxDepth).toBe(2);
    expect(analysis.criticalNodeKeys).toEqual(new Set([a, b, c].map(issueKey)));
    expect(analysis.criticalEdgeKeys).toEqual(new Set(dependencies.slice(0, 2).map(edgeKey)));
    expect(analysis.nodes.get(issueKey(e))?.depth).toBe(1);
  });
  it('identifies only the nodes and edges in a cycle and disables longest-path metrics', () => {
    const cycle = [dependency(a, b), dependency(b, c), dependency(c, a)];
    const analysis = analyzeGraph([...cycle, dependency(c, d), dependency(e, a), dependency(e, f)], [a, b, c, d, e, f]);
    expect(analysis.hasCycle).toBe(true);
    expect(analysis.cycleNodeKeys).toEqual(new Set([a, b, c].map(issueKey)));
    expect(analysis.cycleEdgeKeys).toEqual(new Set(cycle.map(edgeKey)));
    expect(analysis.maxDepth).toBeNull();
    expect([...analysis.nodes.values()].every(node => node.depth === null && !node.critical)).toBe(true);
    expect(analysis.criticalNodeKeys.size).toBe(0);
    expect(analysis.criticalEdgeKeys.size).toBe(0);
    expect(analysis.nodes.get(issueKey(a))?.downstreamCount).toBe(3);
    expect(analysis.nodes.get(issueKey(d))?.cyclic).toBe(false);
    expect(analysis.nodes.get(issueKey(e))?.downstreamCount).toBe(5);
  });
  it('limits metrics to normalized relationships between visible cards', () => {
    const ab = dependency(a, b);
    const analysis = analyzeGraph([ab, ab, dependency({ ...a, owner: 'ACME' }, b), dependency(a, a), dependency(b, c)], [a, b, { ...a, owner: 'ACME' }]);
    expect(analysis.edges).toHaveLength(1);
    expect(analysis.nodes.size).toBe(2);
    expect(analysis.maxDepth).toBe(1);
    expect(analysis.hasCycle).toBe(false);
    expect(analysis.nodes.get(issueKey(a))?.outDegree).toBe(1);
    expect(analysis.criticalEdgeKeys).toEqual(new Set([edgeKey(ab)]));
    expect(edgeKey(ab)).toBe(edgeKey(dependency({ ...a, owner: 'ACME' }, b)));
  });
  it('reports zero steps and no critical relationships for empty and isolated graphs', () => {
    for (const issues of [[], [a, b]]) {
      const analysis = analyzeGraph([], issues);
      expect(analysis.nodes.size).toBe(issues.length);
      expect(analysis.maxDepth).toBe(0);
      expect(analysis.branchCount).toBe(0);
      expect(analysis.mergeCount).toBe(0);
      expect(analysis.hasCycle).toBe(false);
      expect(analysis.criticalNodeKeys.size).toBe(0);
      expect(analysis.criticalEdgeKeys.size).toBe(0);
    }
  });
  it('handles a chain of 200 visible cards without recursive traversal', () => {
    const issues = Array.from({ length: 200 }, (_, index) => ({ ...a, number: index + 1 }));
    const dependencies = issues.slice(1).map((issue, index) => dependency(issues[index]!, issue));
    const analysis = analyzeGraph(dependencies, issues);
    expect(analysis.maxDepth).toBe(199);
    expect(analysis.criticalEdgeKeys.size).toBe(199);
    expect(analysis.nodes.get(issueKey(issues[0]!))?.downstreamCount).toBe(199);
    expect(analysis.nodes.get(issueKey(issues[199]!))?.depth).toBe(199);
  });
});
