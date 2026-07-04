const { encodePolyline, decodePolyline, downsample, snapToRoads } = require('../../src/utils/roadSnap');

describe('encodePolyline / decodePolyline round trip', () => {
  it('round-trips a set of points to 5 decimal places', () => {
    const points = [
      { lat: 6.9271, lng: 79.8612 },
      { lat: 6.9321, lng: 79.865 },
      { lat: 6.9371, lng: 79.8612 }
    ];
    const encoded = encodePolyline(points);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(points.length);
    decoded.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(points[i].lat, 4);
      expect(p.lng).toBeCloseTo(points[i].lng, 4);
    });
  });

  it('handles a single point and an empty list', () => {
    expect(decodePolyline(encodePolyline([{ lat: 1, lng: 2 }]))).toEqual([{ lat: 1, lng: 2 }]);
    expect(encodePolyline([])).toBe('');
  });
});

describe('downsample', () => {
  it('drops points closer than minMeters but always keeps first and last', () => {
    const points = [
      { lat: 6.9271, lng: 79.8612 },
      { lat: 6.92711, lng: 79.86121 }, // ~1.5m away, should be dropped
      { lat: 6.94, lng: 79.8612 } // far away, kept
    ];
    const result = downsample(points, 8);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[2]);
    expect(result.length).toBe(2);
  });

  it('returns empty for empty input', () => {
    expect(downsample([])).toEqual([]);
  });
});

describe('snapToRoads', () => {
  const points = Array.from({ length: 3 }, (_, i) => ({ lat: 6.9 + i * 0.001, lng: 79.86 }));
  const originalEnv = process.env.GOOGLE_ROADS_KEY;
  let fetchSpy;

  afterEach(() => {
    process.env.GOOGLE_ROADS_KEY = originalEnv;
    if (fetchSpy) fetchSpy.mockRestore();
  });

  it('falls back to raw breadcrumb when no key is configured', async () => {
    delete process.env.GOOGLE_ROADS_KEY;
    delete process.env.GOOGLE_ROUTES_KEY;
    delete process.env.GOOGLE_PLACES_KEY;
    const result = await snapToRoads(points);
    expect(result.snapped).toBe(false);
    expect(decodePolyline(result.polyline)).toHaveLength(points.length);
  });

  it('returns snapped:true and stitches a single batch on success', async () => {
    process.env.GOOGLE_ROADS_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        snappedPoints: points.map((p) => ({ location: { latitude: p.lat, longitude: p.lng } }))
      })
    });
    const result = await snapToRoads(points);
    expect(result.snapped).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decodePolyline(result.polyline)).toHaveLength(points.length);
  });

  it('batches requests in chunks of <=100 points and stitches results', async () => {
    process.env.GOOGLE_ROADS_KEY = 'test-key';
    const manyPoints = Array.from({ length: 150 }, (_, i) => ({ lat: 6.9 + i * 0.0001, lng: 79.86 }));
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const path = decodeURIComponent(new URL(url).searchParams.get('path'));
      const count = path.split('|').length;
      const coords = path.split('|').map((pair) => {
        const [lat, lng] = pair.split(',').map(Number);
        return { location: { latitude: lat, longitude: lng } };
      });
      return { ok: true, json: async () => ({ snappedPoints: coords }) };
    });
    const result = await snapToRoads(manyPoints);
    expect(result.snapped).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // 100 + 50
    expect(decodePolyline(result.polyline)).toHaveLength(150);
  });

  it('falls back to raw breadcrumb on API error', async () => {
    process.env.GOOGLE_ROADS_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });
    const result = await snapToRoads(points);
    expect(result.snapped).toBe(false);
    expect(decodePolyline(result.polyline)).toHaveLength(points.length);
  });
});
