const {
  haversineKm,
  nearestStop,
  segmentDistanceKm,
  pointToSegmentMeters,
  minDistanceToPolylineMeters
} = require('../../src/utils/geo');

// Pure geometry used by journey planning and by the custom-route builder. The route
// builder's own helpers (resample, coverage, projection) are covered in
// route-consensus.test.js.

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(6.9, 79.85, 6.9, 79.85)).toBe(0);
  });

  it('measures about 111 km per degree of latitude', () => {
    expect(haversineKm(6, 79, 7, 79)).toBeGreaterThan(110.5);
    expect(haversineKm(6, 79, 7, 79)).toBeLessThan(111.8);
  });
});

describe('nearestStop', () => {
  const stops = [
    { stopName: 'A', lat: 6.9, lng: 79.85 },
    { stopName: 'B', lat: 6.95, lng: 79.85 },
    { stopName: 'bad', lat: null, lng: 79.85 }
  ];

  it('finds the closest usable stop and ignores a malformed one', () => {
    const hit = nearestStop(stops, 6.949, 79.85);
    expect(hit.stop.stopName).toBe('B');
    expect(hit.index).toBe(1);
  });

  it('returns null with nothing to search', () => {
    expect(nearestStop([], 6.9, 79.85)).toBeNull();
    expect(nearestStop(null, 6.9, 79.85)).toBeNull();
  });
});

describe('segmentDistanceKm', () => {
  it('sums the legs between two stop indices', () => {
    const stops = [
      { lat: 6.9, lng: 79.85 },
      { lat: 6.91, lng: 79.85 },
      { lat: 6.92, lng: 79.85 }
    ];
    expect(segmentDistanceKm(stops, 0, 2)).toBeCloseTo(2.22, 1);
    expect(segmentDistanceKm(stops, 1, 1)).toBe(0);
  });
});

describe('pointToSegmentMeters', () => {
  const a = { lat: 6.9, lng: 79.85 };
  const b = { lat: 6.91, lng: 79.85 };

  it('is the sideways distance for a point beside the segment', () => {
    // 0.0001 degree of longitude ~ 11 m at this latitude.
    const d = pointToSegmentMeters({ lat: 6.905, lng: 79.8501 }, a, b);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(12);
  });

  it('is zero on the segment', () => {
    expect(pointToSegmentMeters({ lat: 6.905, lng: 79.85 }, a, b)).toBeLessThan(0.01);
  });

  it('measures to the nearer end for a point beyond the segment', () => {
    const d = pointToSegmentMeters({ lat: 6.92, lng: 79.85 }, a, b);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  it('treats a zero-length segment as a point', () => {
    const d = pointToSegmentMeters({ lat: 6.9001, lng: 79.85 }, a, a);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(12);
  });
});

describe('minDistanceToPolylineMeters', () => {
  const line = [
    { lat: 6.9, lng: 79.85 },
    { lat: 6.91, lng: 79.85 },
    { lat: 6.91, lng: 79.86 }
  ];

  it('takes the nearest segment of the polyline', () => {
    const d = minDistanceToPolylineMeters({ lat: 6.9105, lng: 79.855 }, line);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
  });

  it('is Infinity for fewer than two points', () => {
    expect(minDistanceToPolylineMeters({ lat: 6.9, lng: 79.85 }, [line[0]])).toBe(Infinity);
    expect(minDistanceToPolylineMeters({ lat: 6.9, lng: 79.85 }, null)).toBe(Infinity);
  });
});
