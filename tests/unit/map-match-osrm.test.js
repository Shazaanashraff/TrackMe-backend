const {
  matchTrace, MatchUnavailable, chunkWithOverlap, planChunks, trimBefore, stitch, resetLearnedLimit
} = require('../../src/utils/mapMatch/osrm');
const { polylineLengthMeters } = require('../../src/utils/geo');

// The matcher talks to an OSRM server over HTTP. fetch is mocked so the suite
// never reaches the network.

const points = (n) => Array.from({ length: n }, (_, i) => ({ lat: 6.9 + i * 0.0002, lng: 79.85 }));

const okResponse = (coords, confidence = 0.9) => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: 'Ok',
    matchings: [{ confidence, geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) } }]
  })
});

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  process.env.MAP_MATCH_URL = 'http://osrm.test';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.MAP_MATCH_URL;
  delete process.env.MAP_MATCH_MAX_POINTS;
  resetLearnedLimit();
});

describe('chunkWithOverlap', () => {
  test('returns one chunk when the trace fits in a request', () => {
    expect(chunkWithOverlap(points(50))).toHaveLength(1);
  });

  test('splits a long trace into overlapping chunks that cover every point', () => {
    const pts = points(250);
    const chunks = chunkWithOverlap(pts, 90, 10);
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(90));
    expect(chunks[0][chunks[0].length - 10]).toBe(chunks[1][0]);
    expect(chunks[chunks.length - 1][chunks[chunks.length - 1].length - 1]).toBe(pts[pts.length - 1]);
  });
});

describe('planChunks', () => {
  it('marks how many leading points of each window are shared context', () => {
    const chunks = planChunks(points(250), 90, 10);
    expect(chunks[0].skip).toBe(0);
    chunks.slice(1).forEach((c) => expect(c.skip).toBe(10));
  });

  it('shrinks the shared context for very small windows', () => {
    const chunks = planChunks(points(40), 10, 10);
    chunks.slice(1).forEach((c) => expect(c.skip).toBeLessThanOrEqual(3));
    chunks.forEach((c) => expect(c.points.length).toBeLessThanOrEqual(10));
    // Every trace point is in some window, and the last window ends at the last point.
    expect(chunks[chunks.length - 1].points.slice(-1)[0]).toEqual(points(40)[39]);
  });
});

describe('trimBefore', () => {
  it('drops the part of the line before the anchor', () => {
    const line = [{ lat: 1, lng: 0 }, { lat: 2, lng: 0 }, { lat: 3, lng: 0 }, { lat: 4, lng: 0 }];
    expect(trimBefore(line, { lat: 2.9, lng: 0 })).toEqual(line.slice(2));
  });

  it('leaves a short line or a missing anchor alone', () => {
    expect(trimBefore([{ lat: 1, lng: 0 }], { lat: 1, lng: 0 })).toEqual([{ lat: 1, lng: 0 }]);
    expect(trimBefore([{ lat: 1, lng: 0 }, { lat: 2, lng: 0 }], null)).toHaveLength(2);
  });
});

describe('stitch', () => {
  test('drops a leading point that repeats the previous list end', () => {
    const out = stitch([
      [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }],
      [{ lat: 2, lng: 2 }, { lat: 3, lng: 3 }]
    ]);
    expect(out).toEqual([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }]);
  });
});

describe('matchTrace', () => {
  test('returns the matched road geometry and confidence', async () => {
    const road = [{ lat: 6.9, lng: 79.85 }, { lat: 6.901, lng: 79.851 }];
    global.fetch = jest.fn().mockResolvedValue(okResponse(road, 0.8));
    const out = await matchTrace(points(10));
    expect(out.coords).toEqual(road);
    expect(out.confidence).toBeCloseTo(0.8);
    expect(out.provider).toBe('osrm');
    expect(global.fetch.mock.calls[0][0]).toContain('http://osrm.test/match/v1/driving/');
  });

  test('sends one request per chunk for a long trace and stitches the results', async () => {
    global.fetch = jest.fn().mockImplementation(async () => okResponse(
      [{ lat: 6.9, lng: 79.85 }, { lat: 6.95, lng: 79.9 }]
    ));
    const out = await matchTrace(points(250));
    expect(global.fetch.mock.calls.length).toBeGreaterThan(2);
    expect(out.coords.length).toBeGreaterThan(1);
  });

  test('treats NoMatch as an empty result, not an outage', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 'NoMatch' }) });
    const out = await matchTrace(points(10));
    expect(out.coords).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('retries a failing server, then throws MatchUnavailable', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(matchTrace(points(10))).rejects.toBeInstanceOf(MatchUnavailable);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('recovers when a retry succeeds', async () => {
    const road = [{ lat: 6.9, lng: 79.85 }, { lat: 6.901, lng: 79.851 }];
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(okResponse(road));
    const out = await matchTrace(points(10));
    expect(out.coords).toEqual(road);
  });

  test('returns an empty result for a trace with fewer than two points', async () => {
    global.fetch = jest.fn();
    const out = await matchTrace(points(1));
    expect(out.coords).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});


// A stand-in for a real OSRM server: echoes the trace it was sent as the matched road, and
// refuses requests with more than `limit` coordinates the way the public demo server does.
function fakeOsrm(limit) {
  const sizes = [];
  const fn = jest.fn().mockImplementation(async (url) => {
    const raw = decodeURIComponent(String(url).split('/driving/')[1].split('?')[0]);
    const coords = raw.split(';').map((pair) => pair.split(',').map(Number));
    sizes.push(coords.length);
    if (coords.length > limit) {
      return { ok: false, status: 400, json: async () => ({ code: 'TooBig', message: 'Too many trace coordinates' }) };
    }
    return okResponse(coords.map(([lng, lat]) => ({ lat, lng })), 0.9);
  });
  fn.sizes = sizes;
  return fn;
}

describe('a server that limits the request size (the public demo server accepts 10)', () => {
  it('asks again with smaller pieces and still matches the whole trace', async () => {
    global.fetch = fakeOsrm(10);
    const out = await matchTrace(points(70));
    expect(out.coords.length).toBeGreaterThan(60);
    const accepted = global.fetch.sizes.filter((n) => n <= 10);
    expect(accepted.length).toBeGreaterThan(5);
  });

  it('remembers the size that worked, so the next ride does not rediscover it', async () => {
    global.fetch = fakeOsrm(10);
    await matchTrace(points(70));
    global.fetch.sizes.length = 0;
    await matchTrace(points(70));
    expect(Math.max(...global.fetch.sizes)).toBeLessThanOrEqual(10);
  });

  it('does not double back over the overlap between pieces', async () => {
    global.fetch = fakeOsrm(10);
    const trace = points(70);
    const out = await matchTrace(trace);
    // The echoed line follows the trace, so its length should be the trace's length, not more.
    const traceLength = polylineLengthMeters(trace);
    expect(polylineLengthMeters(out.coords)).toBeLessThan(traceLength * 1.02);
    // ...and it only ever moves forward.
    for (let i = 1; i < out.coords.length; i += 1) {
      expect(out.coords[i].lat).toBeGreaterThan(out.coords[i - 1].lat);
    }
  });

  it('starts from MAP_MATCH_MAX_POINTS when it is set', async () => {
    process.env.MAP_MATCH_MAX_POINTS = '10';
    global.fetch = fakeOsrm(10);
    await matchTrace(points(40));
    // Never sent anything the server would refuse, so there was nothing to relearn.
    expect(Math.max(...global.fetch.sizes)).toBeLessThanOrEqual(10);
  });

  it('gives up with MatchUnavailable when even tiny requests are refused', async () => {
    global.fetch = fakeOsrm(2);
    await expect(matchTrace(points(40))).rejects.toBeInstanceOf(MatchUnavailable);
  });
});

// The public demo server also refuses a search radius above ~40 m (a vague GPS fix asks for 50),
// answering with the same TooBig code but a different message. Halving the window cannot fix that.
function fakeOsrmRadius(maxRadius, limit = 100) {
  const radii = [];
  const sizes = [];
  const fn = jest.fn().mockImplementation(async (url) => {
    const [path, query] = String(url).split('?');
    const coords = decodeURIComponent(path.split('/driving/')[1]).split(';').map((pair) => pair.split(',').map(Number));
    const radiuses = new URLSearchParams(query).get('radiuses').split(';').map(Number);
    sizes.push(coords.length);
    radii.push(Math.max(...radiuses));
    if (coords.length > limit) {
      return { ok: false, status: 400, json: async () => ({ code: 'TooBig', message: 'Too many trace coordinates' }) };
    }
    if (Math.max(...radiuses) > maxRadius) {
      return { ok: false, status: 400, json: async () => ({ code: 'TooBig', message: 'Radius search size is too large for map matching.' }) };
    }
    return okResponse(coords.map(([lng, lat]) => ({ lat, lng })), 0.9);
  });
  fn.radii = radii;
  fn.sizes = sizes;
  return fn;
}

describe('a server that caps the search radius', () => {
  const vague = (n) => points(n).map((p) => ({ ...p, acc: 30 })); // asks for the 50 m maximum

  it('narrows the search radius instead of shrinking the window, and still matches', async () => {
    global.fetch = fakeOsrmRadius(40);
    const out = await matchTrace(vague(30));
    expect(out.coords.length).toBeGreaterThan(20);
    // The whole trace went in one piece: only the radius was reduced.
    expect(Math.max(...global.fetch.sizes)).toBe(30);
    expect(Math.max(...global.fetch.radii.slice(-1))).toBeLessThanOrEqual(40);
  });

  it('remembers the radius that worked for the next ride', async () => {
    global.fetch = fakeOsrmRadius(40);
    await matchTrace(vague(30));
    global.fetch.radii.length = 0;
    await matchTrace(vague(30));
    expect(Math.max(...global.fetch.radii)).toBeLessThanOrEqual(40);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('copes with both limits at once: 10 points and a 40 m radius', async () => {
    global.fetch = fakeOsrmRadius(40, 10);
    const out = await matchTrace(vague(60));
    expect(out.coords.length).toBeGreaterThan(50);
  });

  it('MAP_MATCH_MAX_RADIUS sets the starting cap', async () => {
    process.env.MAP_MATCH_MAX_RADIUS = '30';
    global.fetch = fakeOsrmRadius(30);
    await matchTrace(vague(20));
    expect(Math.max(...global.fetch.radii)).toBeLessThanOrEqual(30);
    delete process.env.MAP_MATCH_MAX_RADIUS;
  });

  it('gives up with MatchUnavailable when even the narrowest radius is refused', async () => {
    global.fetch = fakeOsrmRadius(5);
    await expect(matchTrace(vague(20))).rejects.toBeInstanceOf(MatchUnavailable);
  });
});
