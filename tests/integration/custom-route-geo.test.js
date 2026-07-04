const {
  pointToSegmentMeters,
  minDistanceToPolylineMeters,
  deviationStats
} = require('../../src/utils/geo');

// Pure functions, no DB needed. Colombo-area coordinates for realistic scale.
const A = { lat: 6.9271, lng: 79.8612 };
const B = { lat: 6.9371, lng: 79.8612 }; // ~1.11km due north of A

describe('pointToSegmentMeters', () => {
  it('is ~0 for a point on the segment', () => {
    const mid = { lat: 6.9321, lng: 79.8612 };
    expect(pointToSegmentMeters(mid, A, B)).toBeLessThan(1);
  });

  it('clamps to the endpoint distance when off the segment span', () => {
    const beyondB = { lat: 6.95, lng: 79.8612 };
    const distToB = pointToSegmentMeters(beyondB, A, B);
    const directToB = pointToSegmentMeters(beyondB, B, B);
    expect(Math.abs(distToB - directToB)).toBeLessThan(1);
  });

  it('measures perpendicular offset in metres', () => {
    // ~0.001 deg lng at this latitude is roughly 111m
    const offset = { lat: 6.9321, lng: 79.8622 };
    const d = pointToSegmentMeters(offset, A, B);
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(130);
  });
});

describe('minDistanceToPolylineMeters', () => {
  const polyline = [A, B, { lat: 6.9371, lng: 79.8712 }];

  it('returns Infinity for a degenerate polyline', () => {
    expect(minDistanceToPolylineMeters(A, [])).toBe(Infinity);
    expect(minDistanceToPolylineMeters(A, [A])).toBe(Infinity);
  });

  it('finds the closest segment across multiple segments', () => {
    const nearSecondSegment = { lat: 6.9371, lng: 79.87 };
    const d = minDistanceToPolylineMeters(nearSecondSegment, polyline);
    expect(d).toBeLessThan(120);
  });
});

describe('deviationStats', () => {
  const polyline = [A, B];

  it('returns zeros for an empty breadcrumb or degenerate polyline', () => {
    expect(deviationStats([], polyline)).toEqual({ maxMeters: 0, fractionOff: 0, sampleCount: 0 });
    expect(deviationStats([A], [])).toEqual({ maxMeters: 0, fractionOff: 0, sampleCount: 0 });
  });

  it('reports zero deviation when the breadcrumb tracks the route', () => {
    const breadcrumb = [A, { lat: 6.9321, lng: 79.8612 }, B];
    const stats = deviationStats(breadcrumb, polyline);
    expect(stats.maxMeters).toBeLessThan(1);
    expect(stats.fractionOff).toBe(0);
    expect(stats.sampleCount).toBe(3);
  });

  it('flags points that stray beyond the off-route threshold', () => {
    const strayed = { lat: 6.9321, lng: 79.865 }; // several hundred metres east
    const breadcrumb = [A, strayed, B];
    const stats = deviationStats(breadcrumb, polyline, 150);
    expect(stats.maxMeters).toBeGreaterThan(150);
    expect(stats.fractionOff).toBeCloseTo(1 / 3);
    expect(stats.sampleCount).toBe(3);
  });
});
