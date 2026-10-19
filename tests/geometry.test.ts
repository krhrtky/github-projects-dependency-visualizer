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
