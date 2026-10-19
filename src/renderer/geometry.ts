export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface RouteEdge { key: string; from: Rect; to: Rect }
export interface RoutingOptions { bounds?: Rect; cards?: readonly Rect[] }
export interface RoutedEdge {
  key: string;
  path: string;
  label: Point;
  lane: number;
  side: 'left' | 'right' | 'direct';
  points: readonly Point[];
  constrained: boolean;
}
type Side = 'left' | 'right';
interface PlannedEdge {
  edge: RouteEdge;
  side: RoutedEdge['side'];
  startSide: Side;
  endSide: Side;
  lane: number;
  x?: number;
  constrained: boolean;
}
interface Port { edge: RouteEdge; end: 'from' | 'to'; rect: Rect; y: number }
const center = (rect: Rect): Point => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
const rectKey = (rect: Rect): string => [rect.left, rect.top, rect.right, rect.bottom].join(':');
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sameColumn = (a: Rect, b: Rect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) >= Math.min(a.width, b.width) * 0.6;
const intersects = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] <= b[1] && b[0] <= a[1];
const verticalInterval = (edge: RouteEdge): readonly [number, number] => [Math.min(center(edge.from).y, center(edge.to).y) - 4, Math.max(center(edge.from).y, center(edge.to).y) + 4];
const coordinate = (value: number): string => String(Math.round(value * 1000) / 1000);
const point = (value: Point): string => `${coordinate(value.x)} ${coordinate(value.y)}`;

function roundedPath(points: readonly Point[]): string {
  return points.slice(1, -1).reduce((path, corner, index) => {
    const before = points[index]!;
    const after = points[index + 2]!;
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2);
    if (!radius) return `${path} L ${point(corner)}`;
    const enter = { x: corner.x + (before.x - corner.x) * radius / incoming, y: corner.y + (before.y - corner.y) * radius / incoming };
    const leave = { x: corner.x + (after.x - corner.x) * radius / outgoing, y: corner.y + (after.y - corner.y) * radius / outgoing };
    return `${path} L ${point(enter)} Q ${point(corner)} ${point(leave)}`;
  }, `M ${point(points[0]!)}`) + ` L ${point(points[points.length - 1]!)}`;
}

function columnPlans(edges: readonly RouteEdge[], column: readonly Rect[], cards: readonly Rect[], bounds?: Rect): PlannedEdge[] {
  const left = Math.min(...column.map(card => card.left));
  const right = Math.max(...column.map(card => card.right));
  const top = Math.min(...edges.flatMap(edge => [edge.from.top, edge.to.top]));
  const bottom = Math.max(...edges.flatMap(edge => [edge.from.bottom, edge.to.bottom]));
  const outside = cards.filter(card => card.right <= left || card.left >= right);
  const relevant = outside.filter(card => card.top <= bottom && card.bottom >= top);
  const unboundedGutter = 12 + (edges.length - 1) * 14;
  const leftLimit = Math.max(bounds ? bounds.left + 4 : left - unboundedGutter, ...relevant.filter(card => card.right <= left).map(card => card.right + 4));
  const rightLimit = Math.min(bounds ? bounds.right - 4 : right + unboundedGutter, ...relevant.filter(card => card.left >= right).map(card => card.left - 4));
  const room: Record<Side, number> = { left: Math.max(0, left - leftLimit), right: Math.max(0, rightLimit - right) };
  const ordered = edges.map(edge => ({ edge, interval: verticalInterval(edge) })).sort((a, b) => b.interval[1] - b.interval[0] - (a.interval[1] - a.interval[0]) || compare(a.edge.key, b.edge.key));
  const lanes: Record<Side, (readonly [number, number])[][]> = { left: [], right: [] };
  const assigned: PlannedEdge[] = [];
  for (const { edge, interval } of ordered) {
    const choices = (['left', 'right'] as const).map(side => {
      const available = lanes[side].findIndex(intervals => intervals.every(other => !intersects(other, interval)));
      const lane = available < 0 ? lanes[side].length : available;
      return { side, lane, score: Math.max(0, 12 + lane * 14 - room[side]) * 1000 + lane * 3 - Math.min(room[side], 26) / 100 };
    });
    const choice = choices.sort((a, b) => a.score - b.score || compare(a.side, b.side))[0]!;
    const intervals = lanes[choice.side][choice.lane];
    if (intervals) intervals.push(interval);
    else lanes[choice.side].push([interval]);
    assigned.push({ edge, side: choice.side, startSide: choice.side, endSide: choice.side, lane: choice.lane, constrained: false });
  }
  const scales: Record<Side, number> = {
    left: Math.min(1, room.left / (12 + Math.max(0, lanes.left.length - 1) * 14)),
    right: Math.min(1, room.right / (12 + Math.max(0, lanes.right.length - 1) * 14)),
  };
  return assigned.map(plan => {
    const side = plan.side as Side;
    const scale = scales[side];
    return { ...plan, x: (side === 'left' ? left : right) + (side === 'left' ? -1 : 1) * (12 + plan.lane * 14) * scale, constrained: scale < 1 };
  });
}

function connectionPorts(plans: readonly PlannedEdge[]): ReadonlyMap<RouteEdge, Readonly<Record<'from' | 'to', number>>> {
  const groups = new Map<string, Port[]>();
  const positions = new Map<RouteEdge, Record<'from' | 'to', number>>();
  for (const plan of plans) {
    positions.set(plan.edge, { from: 0, to: 0 });
    for (const end of ['from', 'to'] as const) {
      const rect = plan.edge[end];
      const side = end === 'from' ? plan.startSide : plan.endSide;
      const key = `${rectKey(rect)}:${side}`;
      const port = { edge: plan.edge, end, rect, y: center(plan.edge[end === 'from' ? 'to' : 'from']).y };
      const ports = groups.get(key);
      if (ports) ports.push(port);
      else groups.set(key, [port]);
    }
  }
  for (const ports of groups.values()) {
    ports.sort((a, b) => a.y - b.y || compare(a.edge.key, b.edge.key) || compare(a.end, b.end));
    for (const [index, port] of ports.entries()) {
      const padding = Math.min(12, port.rect.height / 4);
      positions.get(port.edge)![port.end] = port.rect.top + padding + (port.rect.height - padding * 2) * (index + 1) / (ports.length + 1);
    }
  }
  return positions;
}

export function routeEdges(edges: readonly RouteEdge[], options: RoutingOptions = {}): RoutedEdge[] {
  if (!edges.length) return [];
  if (new Set(edges.map(edge => edge.key)).size !== edges.length) throw new Error('Route edge keys must be unique');
  const ordered = [...edges].sort((a, b) => compare(a.key, b.key));
  const cards = [...new Map([...(options.cards ?? []), ...ordered.flatMap(edge => [edge.from, edge.to])].map(card => [rectKey(card), card])).values()].sort((a, b) => compare(rectKey(a), rectKey(b)));
  const columns = cards.reduce<Rect[][]>((groups, card) => {
    const matches = groups.filter(group => group.some(other => sameColumn(card, other)));
    return [...groups.filter(group => !matches.includes(group)), [...matches.flat(), card]];
  }, []);
  const plans = columns.flatMap(column => {
    const keys = new Set(column.map(rectKey));
    const columnEdges = ordered.filter(edge => keys.has(rectKey(edge.from)) && keys.has(rectKey(edge.to)));
    if (!columnEdges.length) return [];
    return columnPlans(columnEdges, column, cards, options.bounds);
  });
  const plannedKeys = new Set(plans.map(plan => plan.edge.key));
  const direct: PlannedEdge[] = ordered.filter(edge => !plannedKeys.has(edge.key)).map(edge => {
    const rightward = center(edge.to).x >= center(edge.from).x;
    return { edge, side: 'direct', startSide: rightward ? 'right' : 'left', endSide: rightward ? 'left' : 'right', lane: 0, constrained: false };
  });
  const allPlans = [...plans, ...direct];
  const ports = connectionPorts(allPlans);
  return allPlans.map(plan => {
    const port = ports.get(plan.edge)!;
    const start = { x: plan.startSide === 'left' ? plan.edge.from.left : plan.edge.from.right, y: port.from };
    const targetX = plan.endSide === 'left' ? plan.edge.to.left - 3 : plan.edge.to.right + 3;
    const end = { x: options.bounds ? Math.max(options.bounds.left, Math.min(options.bounds.right, targetX)) : targetX, y: port.to };
    if (plan.side !== 'direct') {
      const points = [start, { x: plan.x!, y: start.y }, { x: plan.x!, y: end.y }, end];
      return { key: plan.edge.key, path: roundedPath(points), label: { x: plan.x!, y: (start.y + end.y) / 2 }, lane: plan.lane, side: plan.side, points, constrained: plan.constrained };
    }
    const sign = plan.startSide === 'right' ? 1 : -1;
    const bend = Math.max(32, Math.abs(end.x - start.x) / 2);
    const controls = [{ x: start.x + sign * bend, y: start.y }, { x: end.x - sign * bend, y: end.y }];
    return { key: plan.edge.key, path: `M ${point(start)} C ${point(controls[0]!)}, ${point(controls[1]!)}, ${point(end)}`, label: { x: (start.x + controls[0]!.x * 3 + controls[1]!.x * 3 + end.x) / 8, y: (start.y + end.y) / 2 }, lane: 0, side: plan.side, points: [start, ...controls, end], constrained: false };
  }).sort((a, b) => compare(a.key, b.key));
}

export function route(from: Rect, to: Rect): string {
  const a = { x: (from.left + from.right) / 2, y: (from.top + from.bottom) / 2 };
  const b = { x: (to.left + to.right) / 2, y: (to.top + to.bottom) / 2 };
  const horizontal = Math.abs(b.x - a.x) / Math.max(1, (from.width + to.width) / 2) >= Math.abs(b.y - a.y) / Math.max(1, (from.height + to.height) / 2);
  const sign = horizontal ? (b.x >= a.x ? 1 : -1) : (b.y >= a.y ? 1 : -1);
  const start: Point = horizontal ? { x: sign > 0 ? from.right : from.left, y: a.y } : { x: a.x, y: sign > 0 ? from.bottom : from.top };
  const end: Point = horizontal ? { x: sign > 0 ? to.left - 3 : to.right + 3, y: b.y } : { x: b.x, y: sign > 0 ? to.top - 3 : to.bottom + 3 };
  const bend = Math.max(32, (horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
  const c1 = horizontal ? { x: start.x + sign * bend, y: start.y } : { x: start.x, y: start.y + sign * bend };
  const c2 = horizontal ? { x: end.x - sign * bend, y: end.y } : { x: end.x, y: end.y - sign * bend };
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}
