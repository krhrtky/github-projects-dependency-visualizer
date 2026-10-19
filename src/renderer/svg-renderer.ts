import { analyzeGraph, edgeKey, type Dependency, type GraphAnalysis } from '../domain/graph';
import { issueKey } from '../domain/issue';
import type { BoardCard } from '../content/card-extractor';
import { routeEdges, type Point, type Rect, type RoutedEdge } from './geometry';
import { AnalysisPanel, type AnalysisContext, type ViewFilter } from './analysis-panel';
import { dependencyDepth, dependencyPair, issueLabels } from './labels';
export const OVERLAY_ID = 'github-dependency-visualizer-overlay';
const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--dep-blue,#0969da)', 'var(--dep-purple,#8250df)', 'var(--dep-teal,#1a7f78)', 'var(--dep-pink,#bf3989)', 'var(--dep-muted,#57606a)'];
const CRITICAL = 'var(--dep-critical,#bc4c00)';
const CYCLE = 'var(--dep-cycle,#cf222e)';
const LABEL_CHARACTER_WIDTH = 5.5;
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
function compactReference(reference: string, limit: number): string | undefined {
  if (reference.length <= limit) return reference;
  const number = reference.slice(reference.lastIndexOf('#'));
  if (reference === number || number.length + 2 > limit) return undefined;
  return `${reference.slice(0, limit - number.length - 1)}…${number}`;
}
function compactLabels(references: ReadonlyMap<string, string>, limit: number): ReadonlyMap<string, string | undefined> {
  const candidates = [...references].map(([key, reference]) => [key, compactReference(reference, limit)] as const);
  const counts = new Map<string, number>();
  for (const [, label] of candidates) {
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return new Map(candidates.map(([key, label]) => [key, label && counts.get(label) === 1 ? label : undefined]));
}
function labelCandidates(route: RoutedEdge): readonly Point[] {
  if (route.side !== 'direct') {
    const top = Math.min(route.points[0]!.y, route.points[route.points.length - 1]!.y);
    const bottom = Math.max(route.points[0]!.y, route.points[route.points.length - 1]!.y);
    const inset = Math.min(6, (bottom - top) / 2);
    return [0, -18, 18, -36, 36, -54, 54, -72, 72].map(offset => ({ x: route.label.x, y: Math.max(top + inset, Math.min(route.label.y + offset, bottom - inset)) }));
  }
  const [start, first, second, end] = route.points;
  return [.5, .45, .55, .4, .6, .35, .65, .3, .7].map(t => ({
    x: (1 - t) ** 3 * start!.x + 3 * (1 - t) ** 2 * t * first!.x + 3 * (1 - t) * t ** 2 * second!.x + t ** 3 * end!.x,
    y: (1 - t) ** 3 * start!.y + 3 * (1 - t) ** 2 * t * first!.y + 3 * (1 - t) * t ** 2 * second!.y + t ** 3 * end!.y,
  })).sort((a, b) => Math.hypot(a.x - route.label.x, a.y - route.label.y) - Math.hypot(b.x - route.label.x, b.y - route.label.y));
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
    const layout = context.layout ?? 'board';
    const graphSignature = JSON.stringify([cards.map(c => issueKey(c.issue)), dependencies.map(edgeKey)]);
    if (graphSignature !== this.graphSignature) {
      this.graphSignature = graphSignature; this.analysis = analyzeGraph(dependencies, cards.map(c => c.issue));
    }
    const analysis = this.analysis!;
    if (this.filter.issue && !analysis.nodes.has(this.filter.issue)) this.filter = { ...this.filter, issue: '' };
    if (this.filter.edge && !analysis.edges.some(edge => edgeKey(edge) === this.filter.edge)) this.filter = { ...this.filter, edge: '' };
    if (analysis.hasCycle || !analysis.edges.length) this.filter = { ...this.filter, criticalOnly: false };
    const signature = JSON.stringify([cards.map(c => [issueKey(c.issue), c.rect.left, c.rect.top, c.rect.width, c.rect.height, c.anchor]), graphSignature, [bounds.left, bounds.top, bounds.width, bounds.height], this.filter, context]);
    if (signature === this.signature) return this.edgeCount;
    this.signature = signature;
    for (const [key, value] of Object.entries({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })) this.clip!.setAttribute(key, String(value));
    const byIssue = new Map<string, BoardCard[]>();
    for (const card of cards) byIssue.set(issueKey(card.issue), [...(byIssue.get(issueKey(card.issue)) ?? []), card]);
    const fragment = document.createDocumentFragment();
    const graph = [...analysis.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    const routeSignature = JSON.stringify([cards.map(c => [issueKey(c.issue), c.rect.left, c.rect.top, c.rect.width, c.rect.height, c.anchor]), graphSignature, [bounds.left, bounds.top, bounds.width, bounds.height], layout]);
    if (routeSignature !== this.routeSignature) {
      const pairs = graph.map(edge => {
        const fromCards = byIssue.get(issueKey(edge.blocker))!;
        const toCards = byIssue.get(issueKey(edge.blocked))!;
        const candidates = fromCards.flatMap(from => toCards.map(to => ({ from, to, distance: Math.hypot(from.rect.left - to.rect.left, from.rect.top - to.rect.top) })));
        const pair = candidates.sort((a, b) => a.distance - b.distance)[0]!;
        return { key: edgeKey(edge), from: pair.from.rect, to: pair.to.rect, fromAnchor: pair.from.anchor, toAnchor: pair.to.anchor };
      });
      this.routes = new Map(routeEdges(pairs, { bounds, cards: cards.map(card => card.rect), layout }).map(route => [route.key, route]));
      this.routeSignature = routeSignature;
    }
    const routes = this.routes;
    const traced = this.filter.issue ? tracedEdges(analysis, this.filter.issue) : undefined;
    const references = issueLabels(analysis.nodes.keys());
    const compactByLimit = new Map<number, ReadonlyMap<string, string | undefined>>();
    const compactFor = (limit: number): ReadonlyMap<string, string | undefined> => {
      const cached = compactByLimit.get(limit);
      if (cached) return cached;
      const compact = compactLabels(references, limit);
      compactByLimit.set(limit, compact);
      return compact;
    };
    const labels = document.createDocumentFragment();
    const placedLabels: Rect[] = [];
    for (const edge of graph) {
      const key = edgeKey(edge); const routed = routes.get(key)!;
      const critical = analysis.criticalEdgeKeys.has(key); const cyclic = analysis.cycleEdgeKeys.has(key);
      if (this.filter.criticalOnly && !critical) continue;
      const focused = !this.filter.edge || this.filter.edge === key;
      const opacity = focused && (!traced || traced.has(key)) ? '1' : '.12';
      const palette = colorIndex(issueKey(edge.blocker));
      const color = cyclic ? CYCLE : critical ? CRITICAL : COLORS[palette]!;
      const from = issueKey(edge.blocker); const to = issueKey(edge.blocked);
      const depth = dependencyDepth(edge, analysis.nodes);
      const description = `${from} → ${to} · ${depth}`;
      const group = svg('g', { opacity, 'data-edge-key': key, 'data-critical': String(critical), 'data-cycle': String(cyclic) });
      const path = svg('path', { d: routed.path, fill: 'none', stroke: color, 'stroke-width': this.filter.edge === key ? '4' : critical || cyclic ? '3' : '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'marker-end': `url(#dependency-arrow${cyclic ? '-cycle' : critical ? '' : `-${palette}`})` });
      if (cyclic) path.setAttribute('stroke-dasharray', '6 4');
      const title = svg('title'); title.textContent = description;
      path.append(title); group.append(path); fragment.append(group);
      if (bounds.height < 36) continue;
      const depthWidth = [...depth].reduce((size, char) => size + (char === ' ' ? 2.5 : char.charCodeAt(0) > 127 ? 9 : LABEL_CHARACTER_WIDTH), 12);
      const placement = labelCandidates(routed).map(point => {
        const { y } = point;
        if (y < bounds.top + 18 || y > bounds.bottom - 18) return undefined;
        const obstacles = cards.map(card => card.rect).filter(rect => rect.top < y + 18 && rect.bottom > y - 18);
        if (obstacles.some(rect => rect.left - 2 <= point.x && rect.right + 2 >= point.x)) return undefined;
        const left = Math.max(bounds.left + 2, ...obstacles.filter(rect => rect.right < point.x).map(rect => rect.right + 2));
        const right = Math.min(bounds.right - 2, ...obstacles.filter(rect => rect.left > point.x).map(rect => rect.left - 2));
        if (point.x < left || point.x > right) return undefined;
        const maxLabelWidth = Math.min(280, right - left);
        if (depthWidth > maxLabelWidth) return undefined;
        const budget = Math.floor((maxLabelWidth - 12) / LABEL_CHARACTER_WIDTH) - 3;
        if (budget < 2) return undefined;
        const fromLimit = Math.min(references.get(from)!.length, Math.max(Math.floor(budget / 2), budget - references.get(to)!.length));
        const fromLabel = compactFor(fromLimit).get(from);
        const toLabel = compactFor(budget - fromLimit).get(to);
        if (!fromLabel || !toLabel) return undefined;
        const pair = dependencyPair(edge, new Map([[from, fromLabel], [to, toLabel]]));
        const width = Math.max(12 + [...pair].length * LABEL_CHARACTER_WIDTH, depthWidth);
        const x = Math.max(left + width / 2, Math.min(point.x, right - width / 2));
        const rect = { left: x - width / 2, right: x + width / 2, top: y - 16, bottom: y + 16, width, height: 32 };
        if (placedLabels.some(other => rect.left < other.right + 2 && rect.right > other.left - 2 && rect.top < other.bottom + 2 && rect.bottom > other.top - 2)) return undefined;
        return { x, y, pair, width, rect };
      }).find(candidate => candidate !== undefined);
      if (!placement) continue;
      const { x, y, pair, width, rect } = placement;
      placedLabels.push(rect);
      const label = svg('g', { opacity, transform: `translate(${x},${y})`, 'data-dependency-label': key });
      const labelTitle = svg('title'); labelTitle.textContent = description;
      label.append(labelTitle);
      label.append(svg('rect', { x: String(-width / 2), y: '-16', width: String(width), height: '32', rx: '5', fill: 'var(--bgColor-default,#fff)', stroke: color, 'stroke-width': '1' }));
      const text = svg('text', { x: '0', y: '-4', 'text-anchor': 'middle', fill: color, 'font-family': 'ui-monospace,SFMono-Regular,Consolas,monospace', 'font-size': '9', 'font-weight': '700', 'data-dependency-pair': '' });
      text.textContent = pair;
      const depthText = svg('text', { x: '0', y: '10', 'text-anchor': 'middle', fill: color, 'font-family': 'system-ui,sans-serif', 'font-size': '9', 'font-weight': '600', 'data-dependency-depth': '' });
      depthText.textContent = depth;
      label.append(text, depthText); labels.append(label);
    }
    this.paths!.replaceChildren(fragment, labels);
    const badges = document.createDocumentFragment();
    const badgeCards = layout === 'board' ? cards : [];
    const selectedEdge = analysis.edges.find(edge => edgeKey(edge) === this.filter.edge);
    const selectedIssues = selectedEdge ? new Set([issueKey(selectedEdge.blocker), issueKey(selectedEdge.blocked)]) : undefined;
    for (const card of badgeCards) {
      const key = issueKey(card.issue); const node = analysis.nodes.get(key)!;
      if (!node.inDegree && !node.outDegree) continue;
      if (this.filter.criticalOnly && !node.critical) continue;
      const color = node.cyclic ? CYCLE : node.critical ? CRITICAL : COLORS[colorIndex(key)]!;
      const label = `${node.cyclic ? '循環' : `依存の深さ ${node.depth ?? '未算出'}`} · 前提 ${node.inDegree} · 後続 ${node.outDegree}`;
      const width = [...label].reduce((size, char) => size + (char.charCodeAt(0) > 127 ? 10 : 6.5), 12);
      const x = Math.max(bounds.left + 2, Math.min(card.rect.right - width - 2, bounds.right - width - 4));
      const y = Math.max(bounds.top + 2, card.rect.top - 9);
      const badge = svg('g', { transform: `translate(${x},${y})`, opacity: !selectedIssues || selectedIssues.has(key) ? '1' : '.12' });
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
