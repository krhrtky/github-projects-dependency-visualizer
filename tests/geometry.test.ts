import { describe, expect, it } from 'vitest';
import { route, routeEdges, type Rect, type RouteEdge } from '../src/renderer/geometry';

const rect = (left: number, top: number, width = 200, height = 80): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
const a = rect(100, 20);
const b = rect(100, 140);
const c = rect(100, 260);
const bounds = rect(0, 0, 800, 500);
const stacked: RouteEdge[] = [{ key: 'a-b', from: a, to: b }, { key: 'a-c', from: a, to: c }, { key: 'b-c', from: b, to: c }, { key: 'c-a', from: c, to: a }];

describe('dependency lane routing', () => {
  it('keeps the legacy single-edge router compatible', () => {
    expect(route(rect(0, 0, 100, 100), rect(200, 0, 100, 100))).toBe('M 100 50 C 148.5 50, 148.5 50, 197 50');
  });

  it('separates nested and reverse dependencies into visible side lanes', () => {
    const routes = routeEdges(stacked, { bounds, cards: [a, b, c] });
    expect(new Set(routes.map(edge => edge.path)).size).toBe(4);
    expect(new Set(routes.map(edge => edge.label.x)).size).toBe(4);
    expect(routes.every(edge => edge.side !== 'direct' && !edge.constrained)).toBe(true);
    const forward = routes.find(edge => edge.key === 'a-c')!;
    const reverse = routes.find(edge => edge.key === 'c-a')!;
    expect(forward.side).not.toBe(reverse.side);
    for (const edge of routes) {
      expect(edge.points[1]!.x < a.left || edge.points[1]!.x > a.right).toBe(true);
      expect(edge.points[0]!.y).not.toBe(edge.points[edge.points.length - 1]!.y);
    }
  });

  it('uses distinct connection ports on shared card sides', () => {
    const edges = Array.from({ length: 6 }, (_, index) => ({ key: `edge-${index}`, from: a, to: rect(100, 140 + index * 120) }));
    const routes = routeEdges(edges, { bounds: rect(0, 0, 800, 1000) });
    expect(new Set(routes.map(edge => `${edge.points[0]!.x}:${edge.points[0]!.y}`)).size).toBe(edges.length);
    expect(routes.every(edge => edge.points[0]!.y > a.top && edge.points[0]!.y < a.bottom)).toBe(true);
  });

  it('avoids intermediate cards with wider edges in the same column', () => {
    const middle = rect(80, 140, 240);
    const [edge] = routeEdges([{ key: 'a-c', from: a, to: c }], { bounds, cards: [a, middle, c] });
    expect(edge!.side).not.toBe('direct');
    const laneX = edge!.points[1]!.x;
    expect(laneX < middle.left || laneX > middle.right).toBe(true);
  });

  it('fits lanes between adjacent columns and compresses them within narrow gutters', () => {
    const leftColumn = rect(0, 0, 180, 480);
    const rightColumn = rect(420, 0, 180, 480);
    const sameColumn = stacked.map(edge => ({ ...edge, from: rect(200, edge.from.top), to: rect(200, edge.to.top) }));
    const routes = routeEdges(sameColumn, { bounds: rect(0, 0, 600, 500), cards: [leftColumn, rightColumn] });
    expect(new Set(routes.map(edge => edge.label.x)).size).toBe(4);
    expect(routes.some(edge => edge.constrained)).toBe(true);
    expect(routes.every(edge => edge.label.x >= leftColumn.right + 4 && edge.label.x <= rightColumn.left - 4)).toBe(true);
  });

  it('uses the available side when the column touches a board boundary', () => {
    const source = rect(0, 20);
    const target = rect(0, 220);
    const [edge] = routeEdges([{ key: 'edge', from: source, to: target }], { bounds: rect(0, 0, 400, 400) });
    expect(edge!.side).toBe('right');
    expect(edge!.constrained).toBe(false);
    expect(edge!.points.every(point => point.x >= 0 && point.x <= 400)).toBe(true);
  });

  it('reports impossible external gutters without producing clipped or invalid coordinates', () => {
    const source = rect(0, 20);
    const target = rect(0, 220);
    const [edge] = routeEdges([{ key: 'edge', from: source, to: target }], { bounds: rect(0, 0, 200, 400) });
    expect(edge!.constrained).toBe(true);
    expect(edge!.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 200)).toBe(true);
  });

  it('is independent of edge and obstacle input order and leaves inputs unchanged', () => {
    const original = JSON.stringify(stacked);
    const cards = [a, b, c, rect(400, 20)];
    const routes = routeEdges(stacked, { bounds, cards });
    expect(routeEdges([...stacked].reverse(), { bounds, cards: [...cards].reverse() })).toEqual(routes);
    expect(JSON.stringify(stacked)).toBe(original);
    expect(routes.map(edge => edge.key)).toEqual([...stacked.map(edge => edge.key)].sort());
  });

  it('routes cross-column dependencies with separately distributed ports', () => {
    const routes = routeEdges([{ key: 'a-right', from: a, to: rect(500, 20) }, { key: 'a-bottom-right', from: a, to: rect(500, 200) }], { bounds });
    expect(routes.every(edge => edge.side === 'direct')).toBe(true);
    expect(routes[0]!.points[0]!.y).not.toBe(routes[1]!.points[0]!.y);
    expect(routes.every(edge => edge.path.includes(' C ') && Number.isFinite(edge.label.x))).toBe(true);
  });

  it('retains stable routes and unique ports for 1,000 dependencies across 200 cards', () => {
    const cards = Array.from({ length: 200 }, (_, index) => rect(100, 20 + index * 100));
    const edges = cards.flatMap((from, index) => cards.slice(index + 1).map((to, offset) => ({ key: `${index}-${index + offset + 1}`, from, to }))).slice(0, 1000);
    const options = { bounds: rect(0, 0, 800, 20100), cards };
    const routes = routeEdges(edges, options);
    expect(routes).toHaveLength(1000);
    expect(new Set(routes.map(edge => edge.path)).size).toBe(1000);
    expect(routes.every(edge => edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))).toBe(true);
    const fromFirst = new Set(edges.filter(edge => edge.from === cards[0]).map(edge => edge.key));
    expect(new Set(routes.filter(edge => fromFirst.has(edge.key)).map(edge => `${edge.points[0]!.x}:${edge.points[0]!.y}`)).size).toBe(fromFirst.size);
    expect(routeEdges([...edges].reverse(), { ...options, cards: [...cards].reverse() })).toEqual(routes);
  });

  it('accepts an empty graph and fails early for ambiguous edge keys', () => {
    expect(routeEdges([])).toEqual([]);
    expect(() => routeEdges([stacked[0]!, stacked[0]!])).toThrow('Route edge keys must be unique');
  });
});

describe('table and roadmap routing', () => {
  it('keeps explicit board routing equal to the default layout', () => {
    expect(routeEdges(stacked, { bounds, layout: 'board' })).toEqual(routeEdges(stacked, { bounds }));
  });

  it('routes table dependencies in a limited gutter to the left of title cells', () => {
    const rows = stacked.map(edge => ({ ...edge, from: rect(200, edge.from.top, 400, 28), to: rect(200, edge.to.top, 400, 28) }));
    const routes = routeEdges(rows, { bounds, layout: 'table' });
    expect(routes.every(edge => edge.side === 'left' && !edge.constrained)).toBe(true);
    expect(new Set(routes.map(edge => edge.label.x)).size).toBe(rows.length);
    expect(routes.every(edge => edge.label.x >= 136 && edge.label.x < 200 && edge.points[0]!.x === 200)).toBe(true);
  });

  it('separates full-width table rows inside their leading strip when no external gutter exists', () => {
    const rows = stacked.map(edge => ({ ...edge, from: rect(0, edge.from.top, 800, 24), to: rect(0, edge.to.top, 800, 24) }));
    const routes = routeEdges(rows, { bounds, layout: 'table' });
    expect(routes.every(edge => edge.side === 'left' && edge.constrained)).toBe(true);
    expect(new Set(routes.map(edge => edge.label.x)).size).toBe(rows.length);
    expect(new Set(routes.map(edge => edge.path)).size).toBe(rows.length);
    expect(routes.every(edge => edge.points.every(point => point.x >= 4 && point.x <= 32 && point.y >= bounds.top && point.y <= bounds.bottom))).toBe(true);
    expect(routes.every(edge => edge.points[0]!.x > edge.label.x && edge.points.at(-1)!.x > edge.label.x)).toBe(true);
  });

  it('keeps indented table titles in a single left-side routing group', () => {
    const edges = [{ key: 'indent', from: rect(40, 20, 80, 24), to: rect(180, 70, 70, 24) }];
    const [edge] = routeEdges(edges, { bounds, layout: 'table' });
    expect(edge!.side).toBe('left');
    expect(edge!.label.x).toBeLessThan(40);
    expect(edge!.points[0]!.x).toBe(40);
    expect(edge!.points.at(-1)!.x).toBe(177);
  });

  it('keeps narrow and horizontally clipped table rows inside the visible bounds', () => {
    for (const width of [16, 40, 320]) {
      const source = rect(width === 320 ? -120 : 0, 20, width, 16);
      const target = rect(width === 320 ? -100 : 0, 60, width, 16);
      const [edge] = routeEdges([{ key: 'narrow', from: source, to: target }], { bounds, layout: 'table' });
      expect(edge!.constrained).toBe(true);
      expect(edge!.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom)).toBe(true);
    }
  });

  it('connects roadmap bars horizontally even when their scheduled dates overlap', () => {
    const source = rect(100, 20, 200, 18);
    const target = rect(120, 80, 220, 18);
    const [edge] = routeEdges([{ key: 'overlapping-dates', from: source, to: target }], { bounds, layout: 'roadmap' });
    expect(edge!.side).toBe('direct');
    expect(edge!.points[0]!.x).toBe(source.right);
    expect(edge!.points.at(-1)!.x).toBe(target.left - 3);
    expect(edge!.path).toContain(' C ');
  });

  it('uses the facing bar endpoints for backwards roadmap dependencies', () => {
    const source = rect(500, 20, 80, 18);
    const target = rect(100, 80, 80, 18);
    const [edge] = routeEdges([{ key: 'backwards', from: source, to: target }], { bounds, layout: 'roadmap' });
    expect(edge!.side).toBe('direct');
    expect(edge!.points[0]!.x).toBe(source.left);
    expect(edge!.points.at(-1)!.x).toBe(target.right + 3);
  });

  it('contains roadmap control points at timeline boundaries and reports the constraint', () => {
    const source = rect(0, 20, 800, 18);
    const target = rect(0, 80, 800, 18);
    const [edge] = routeEdges([{ key: 'timeline-boundary', from: source, to: target }], { bounds, layout: 'roadmap' });
    expect(edge!.constrained).toBe(true);
    expect(edge!.points.every(point => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom)).toBe(true);
  });

  it('routes roadmap title fallbacks beside the title column without crossing its text', () => {
    const source = rect(27, 337, 439, 76);
    const target = rect(27, 413, 439, 76);
    const before = rect(522, 281, 160, 34);
    const after = rect(827, 510, 170, 32);
    const edges: RouteEdge[] = [
      { key: 'bar-title', from: before, to: source, fromAnchor: 'bar', toAnchor: 'title' },
      { key: 'title-title', from: source, to: target, fromAnchor: 'title', toAnchor: 'title' },
      { key: 'title-bar', from: target, to: after, fromAnchor: 'title', toAnchor: 'bar' },
    ];
    const routes = routeEdges(edges, { bounds: rect(27, 260, 1387, 526), cards: [before, source, target, after], layout: 'roadmap' });
    const title = routes.find(edge => edge.key === 'title-title')!;
    expect(title.side).toBe('right');
    expect(title.label.x).toBe(source.right + 12);
    expect(title.points[0]!.x).toBe(source.right);
    expect(title.points.at(-1)!.x).toBe(target.right + 3);
    expect(title.points.every(point => point.x >= source.right)).toBe(true);
    expect(routes.filter(edge => edge.key !== title.key).every(edge => edge.side === 'direct')).toBe(true);
  });

  it('requires explicit title anchors instead of inferring them from rectangle sizes', () => {
    const source = rect(0, 20, 400, 24);
    const target = rect(0, 80, 400, 24);
    const edges: RouteEdge[] = [
      { key: 'titles', from: source, to: target, fromAnchor: 'title', toAnchor: 'title' },
      { key: 'bars', from: source, to: target, fromAnchor: 'bar', toAnchor: 'bar' },
      { key: 'mixed', from: source, to: target, fromAnchor: 'title', toAnchor: 'bar' },
      { key: 'unspecified', from: source, to: target },
    ];
    const routes = routeEdges(edges, { bounds, layout: 'roadmap' });
    expect(routes.filter(edge => edge.side !== 'direct').map(edge => edge.key)).toEqual(['titles']);
    expect(routeEdges([...edges].reverse(), { bounds, layout: 'roadmap' })).toEqual(routes);
  });

  it('distributes shared roadmap title ports across gutter and direct connections together', () => {
    const source = rect(0, 20, 200, 24);
    const target = rect(0, 80, 200, 24);
    const bar = rect(400, 140, 160, 18);
    const edges: RouteEdge[] = [
      { key: 'title-title', from: source, to: target, fromAnchor: 'title', toAnchor: 'title' },
      { key: 'title-bar', from: target, to: bar, fromAnchor: 'title', toAnchor: 'bar' },
    ];
    const routes = routeEdges(edges, { bounds, layout: 'roadmap' });
    const gutter = routes.find(edge => edge.key === 'title-title')!;
    const direct = routes.find(edge => edge.key === 'title-bar')!;
    expect(gutter.side).toBe('right'); expect(direct.side).toBe('direct');
    expect(gutter.points.at(-1)!.y).not.toBe(direct.points[0]!.y);
    expect(routeEdges([...edges].reverse(), { bounds, layout: 'roadmap' })).toEqual(routes);
  });
});
