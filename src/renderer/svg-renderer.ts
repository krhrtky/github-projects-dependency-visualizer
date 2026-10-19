import { analyzeGraph, edgeKey, type Dependency, type GraphAnalysis } from '../domain/graph';
import { issueKey } from '../domain/issue';
import type { BoardCard } from '../content/card-extractor';
import { routeEdges, type Rect, type RoutedEdge } from './geometry';
import { AnalysisPanel, type AnalysisContext, type ViewFilter } from './analysis-panel';
export const OVERLAY_ID = 'github-dependency-visualizer-overlay';
const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--dep-blue,#0969da)', 'var(--dep-purple,#8250df)', 'var(--dep-teal,#1a7f78)', 'var(--dep-pink,#bf3989)', 'var(--dep-muted,#57606a)'];
const CRITICAL = 'var(--dep-critical,#bc4c00)';
const CYCLE = 'var(--dep-cycle,#cf222e)';
function colorIndex(key: string): number {
  return [...key].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0) % COLORS.length;
}
function tracedEdges(analysis: GraphAnalysis, key: string): ReadonlySet<string> {
  const traced = new Set<string>();
  for (const direction of ['blocker', 'blocked'] as const) {
    const opposite = direction === 'blocker' ? 'blocked' : 'blocker';
    const pending = [key]; const visited = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of analysis.edges.filter(edge => issueKey(edge[direction]) === current)) {
        traced.add(edgeKey(edge)); pending.push(issueKey(edge[opposite]));
      }
    }
  }
  return traced;
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}
export class SvgRenderer {
  private host?: HTMLDivElement;
  private paths?: SVGGElement;
  private clip?: SVGRectElement;
  private badges?: SVGGElement;
  private panel?: AnalysisPanel;
  private signature = '';
  private graphSignature = '';
  private routeSignature = '';
  private routes = new Map<string, RoutedEdge>();
  private edgeCount = 0;
  private filter: ViewFilter = { criticalOnly: false, issue: '', edge: '' };
  private input?: { cards: BoardCard[]; dependencies: Dependency[]; bounds: Rect; context: AnalysisContext };
  analysis?: GraphAnalysis;
  mount(): void {
    if (this.host?.isConnected) return;
    this.signature = '';
    document.getElementById(OVERLAY_ID)?.remove();
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40;contain:strict;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const canvas = svg('svg', { width: '100%', height: '100%', 'aria-hidden': 'true', style: 'display:block;overflow:hidden;pointer-events:none' });
    const defs = svg('defs');
    for (const [id, color] of [['dependency-arrow', CRITICAL], ['dependency-arrow-cycle', CYCLE], ...COLORS.map((color, i) => [`dependency-arrow-${i}`, color])]) {
      const marker = svg('marker', { id: id!, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
      marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 Z', fill: color! })); defs.append(marker);
    }
    const clip = svg('clipPath', { id: 'dependency-clip' });
    this.clip = svg('rect'); clip.append(this.clip); defs.append(clip);
    this.paths = svg('g', { 'clip-path': 'url(#dependency-clip)' });
    this.badges = svg('g', { 'clip-path': 'url(#dependency-clip)' });
    canvas.append(defs, this.paths, this.badges); shadow.append(canvas);
    this.panel = new AnalysisPanel(shadow, change => {
      this.filter = { ...this.filter, ...change };
      if (this.input) this.render(this.input.cards, this.input.dependencies, this.input.bounds, this.input.context);
    });
    document.documentElement.append(host); this.host = host;
  }
  render(cards: BoardCard[], dependencies: Dependency[], bounds: Rect, context: AnalysisContext = {}): number {
    this.mount();
    this.input = { cards, dependencies, bounds, context };
    const graphSignature = JSON.stringify([cards.map(c => issueKey(c.issue)), dependencies.map(edgeKey)]);
    if (graphSignature !== this.graphSignature) {
      this.graphSignature = graphSignature; this.analysis = analyzeGraph(dependencies, cards.map(c => c.issue));
    }
    const analysis = this.analysis!;
    if (this.filter.issue && !analysis.nodes.has(this.filter.issue)) this.filter = { ...this.filter, issue: '' };
    if (this.filter.edge && !analysis.edges.some(edge => edgeKey(edge) === this.filter.edge)) this.filter = { ...this.filter, edge: '' };
    if (analysis.hasCycle || !analysis.edges.length) this.filter = { ...this.filter, criticalOnly: false };
    const signature = JSON.stringify([cards.map(c => [issueKey(c.issue), c.rect.left, c.rect.top, c.rect.width, c.rect.height]), graphSignature, [bounds.left, bounds.top, bounds.width, bounds.height], this.filter, context]);
    if (signature === this.signature) return this.edgeCount;
    this.signature = signature;
    for (const [key, value] of Object.entries({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })) this.clip!.setAttribute(key, String(value));
    const byIssue = new Map<string, BoardCard[]>();
    for (const card of cards) byIssue.set(issueKey(card.issue), [...(byIssue.get(issueKey(card.issue)) ?? []), card]);
    const fragment = document.createDocumentFragment();
    const graph = [...analysis.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    const routeSignature = JSON.stringify([cards.map(c => [issueKey(c.issue), c.rect.left, c.rect.top, c.rect.width, c.rect.height]), graphSignature, [bounds.left, bounds.top, bounds.width, bounds.height]]);
    if (routeSignature !== this.routeSignature) {
      const pairs = graph.map(edge => {
        const fromCards = byIssue.get(issueKey(edge.blocker))!;
        const toCards = byIssue.get(issueKey(edge.blocked))!;
        const candidates = fromCards.flatMap(from => toCards.map(to => ({ from, to, distance: Math.hypot(from.rect.left - to.rect.left, from.rect.top - to.rect.top) })));
        const pair = candidates.sort((a, b) => a.distance - b.distance)[0]!;
        return { key: edgeKey(edge), from: pair.from.rect, to: pair.to.rect };
      });
      this.routes = new Map(routeEdges(pairs, { bounds, cards: cards.map(card => card.rect) }).map(route => [route.key, route]));
      this.routeSignature = routeSignature;
    }
    const routes = this.routes;
    const traced = this.filter.issue ? tracedEdges(analysis, this.filter.issue) : undefined;
    const labels = document.createDocumentFragment();
    for (const [index, edge] of graph.entries()) {
      const key = edgeKey(edge); const routed = routes.get(key)!;
      const critical = analysis.criticalEdgeKeys.has(key); const cyclic = analysis.cycleEdgeKeys.has(key);
      if (this.filter.criticalOnly && !critical) continue;
      const focused = !this.filter.edge || this.filter.edge === key;
      const opacity = focused && (!traced || traced.has(key)) ? '1' : '.12';
      const palette = colorIndex(issueKey(edge.blocker));
      const color = cyclic ? CYCLE : critical ? CRITICAL : COLORS[palette]!;
      const group = svg('g', { opacity, 'data-edge-key': key, 'data-critical': String(critical), 'data-cycle': String(cyclic) });
      const path = svg('path', { d: routed.path, fill: 'none', stroke: color, 'stroke-width': this.filter.edge === key ? '4' : critical || cyclic ? '3' : '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'marker-end': `url(#dependency-arrow${cyclic ? '-cycle' : critical ? '' : `-${palette}`})` });
      if (cyclic) path.setAttribute('stroke-dasharray', '6 4');
      const title = svg('title'); title.textContent = `${issueKey(edge.blocker)} → ${issueKey(edge.blocked)}`;
      path.append(title); group.append(path); fragment.append(group);
      const label = svg('g', { opacity, transform: `translate(${routed.label.x},${routed.label.y})` });
      const number = String(index + 1).padStart(2, '0'); const width = Math.max(20, number.length * 6 + 8);
      label.append(svg('rect', { x: String(-width / 2), y: '-8', width: String(width), height: '16', rx: '5', fill: 'var(--bgColor-default,#fff)', stroke: color, 'stroke-width': '1' }));
      const text = svg('text', { x: '0', y: '3.5', 'text-anchor': 'middle', fill: color, 'font-family': 'system-ui,sans-serif', 'font-size': '9', 'font-weight': '700' });
      text.textContent = number; label.append(text); labels.append(label);
    }
    this.paths!.replaceChildren(fragment, labels);
    const badges = document.createDocumentFragment();
    for (const card of cards) {
      const key = issueKey(card.issue); const node = analysis.nodes.get(key)!;
      if (!node.inDegree && !node.outDegree) continue;
      if (this.filter.criticalOnly && !node.critical) continue;
      const color = node.cyclic ? CYCLE : node.critical ? CRITICAL : COLORS[colorIndex(key)]!;
      const label = `${node.cyclic ? '循環' : `深さ ${node.depth ?? '—'}`} · 入${node.inDegree} 出${node.outDegree}`;
      const width = Math.max(114, label.length * 6.5 + 12);
      const x = Math.max(bounds.left + 2, Math.min(card.rect.right - width - 2, bounds.right - width - 4));
      const y = Math.max(bounds.top + 2, card.rect.top - 9);
      const badge = svg('g', { transform: `translate(${x},${y})` });
      badge.append(svg('rect', { width: String(width), height: '18', rx: '5', fill: 'var(--bgColor-default,#fff)', stroke: color }));
      const text = svg('text', { x: '6', y: '12.5', fill: color, 'font-family': 'system-ui,sans-serif', 'font-size': '10', 'font-weight': '600' });
      text.textContent = label;
      badge.append(text); badges.append(badge);
    }
    this.badges!.replaceChildren(badges);
    this.panel!.update(analysis, this.filter, context, [...routes.values()].some(route => route.constrained));
    this.edgeCount = graph.length;
    return graph.length;
  }
  destroy(): void {
    this.host?.remove(); this.host = undefined; this.paths = undefined; this.clip = undefined; this.badges = undefined; this.panel = undefined;
    this.signature = ''; this.graphSignature = ''; this.analysis = undefined; this.input = undefined; this.edgeCount = 0;
    this.routeSignature = ''; this.routes.clear();
    this.filter = { criticalOnly: false, issue: '', edge: '' };
  }
}
