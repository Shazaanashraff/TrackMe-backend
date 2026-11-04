// OSRM `/match` adapter: fits a GPS trace to the OpenStreetMap road network.
//
// Public demo server: https://router.project-osrm.org (development only - its terms
// forbid heavy use, it has no uptime guarantee, and it accepts at most 10 trace
// coordinates per request, far below the 100 a self-hosted OSRM allows by default).
// Point MAP_MATCH_URL at a self-hosted OSRM before real use.

const { haversineKm } = require('../geo');

const DEFAULT_MAX_POINTS = 90;     // a self-hosted OSRM allows 100 by default
const MIN_MAX_POINTS = 4;          // below this a chunk cannot say which road it is on
const OVERLAP = 10;                // trace points shared by neighbouring chunks, for context
const RETRIES = 2;

class MatchUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatchUnavailable';
  }
}

// The server refused the request for being too large. Not an outage and not retried
// as-is: the caller sends smaller pieces.
class TooBigError extends Error {
  // `kind` is 'points' (too many trace coordinates) or 'radius' (a search radius above the
  // server's cap). The two need different fixes, so they are told apart by the server's message.
  constructor(kind = 'points') {
    super(`OSRM TooBig (${kind})`);
    this.name = 'TooBigError';
    this.kind = kind;
  }
}

const baseUrl = () => String(process.env.MAP_MATCH_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const timeoutMs = () => Number(process.env.MAP_MATCH_TIMEOUT_MS) || 15_000;

// The largest request this server has accepted, learned from TooBig answers and kept for the
// life of the process so later rides do not rediscover it. MAP_MATCH_MAX_POINTS sets the start.
let learnedMaxPoints = null;
const startingMaxPoints = () => {
  const configured = parseInt(process.env.MAP_MATCH_MAX_POINTS, 10);
  return Number.isFinite(configured) && configured >= MIN_MAX_POINTS ? configured : DEFAULT_MAX_POINTS;
};
const currentMaxPoints = () => (learnedMaxPoints === null ? startingMaxPoints() : learnedMaxPoints);

// How far from a GPS fix the matcher may look for a road. A vague fix (poor accuracy) asks for a
// wider search. The public demo server refuses radii above ~40 m, so the cap is learned the same
// way as the window size; MAP_MATCH_MAX_RADIUS sets the start.
const MIN_RADIUS = 15;
const DEFAULT_MAX_RADIUS = 50;
let learnedMaxRadius = null;
const startingMaxRadius = () => {
  const configured = parseInt(process.env.MAP_MATCH_MAX_RADIUS, 10);
  return Number.isFinite(configured) && configured >= MIN_RADIUS ? configured : DEFAULT_MAX_RADIUS;
};
const currentMaxRadius = () => (learnedMaxRadius === null ? startingMaxRadius() : learnedMaxRadius);

const radiusFor = (p) => {
  const acc = Number.isFinite(p.acc) ? p.acc : 15;
  return Math.max(MIN_RADIUS, Math.min(currentMaxRadius(), Math.round(acc * 2)));
};

const meters = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

/**
 * Split a trace into windows of at most `size` points. Each window after the first starts
 * `overlap` points before the previous one ended, so the matcher has context at the joins.
 * Returns [{ points, skip }] where `skip` is how many leading points are that shared context.
 */
function planChunks(points, size = DEFAULT_MAX_POINTS, overlap = OVERLAP) {
  if (points.length <= size) return [{ points, skip: 0 }];
  const shared = Math.max(1, Math.min(overlap, Math.floor(size / 3)));
  const step = size - shared;
  const chunks = [];
  for (let start = 0; ; start += step) {
    const slice = points.slice(start, start + size);
    chunks.push({ points: slice, skip: start === 0 ? 0 : shared });
    if (start + size >= points.length) break;
  }
  return chunks;
}

// Array-of-points view of planChunks (kept for callers and tests that only need the windows).
function chunkWithOverlap(points, size = DEFAULT_MAX_POINTS, overlap = OVERLAP) {
  return planChunks(points, size, overlap).map((c) => c.points);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestMatch(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const radiuses = points.map(radiusFor).join(';');
  const url = `${baseUrl()}/match/v1/driving/${coords}`
    + `?geometries=geojson&overview=full&gaps=split&tidy=true&radiuses=${radiuses}`;

  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs());
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const body = await res.json().catch(() => ({}));
      if (body.code === 'TooBig') throw new TooBigError(/radius/i.test(String(body.message || '')) ? 'radius' : 'points');
      // NoMatch is a real answer (this stretch is not on any road), not an outage.
      if (body.code === 'NoMatch' || body.code === 'NoSegment') return [];
      if (!res.ok || body.code !== 'Ok') {
        throw new Error(`OSRM ${res.status} ${body.code || ''}`.trim());
      }
      return (body.matchings || []).map((m) => ({
        coords: (m.geometry?.coordinates || []).map(([lng, lat]) => ({ lat, lng })),
        confidence: Number.isFinite(m.confidence) ? m.confidence : 0
      }));
    } catch (error) {
      if (error instanceof TooBigError) throw error;
      lastError = error;
      if (attempt < RETRIES) await sleep(250 * 2 ** attempt);
    }
  }
  throw new MatchUnavailable(`Map matcher unavailable: ${lastError?.message || 'unknown error'}`);
}

// Drop the part of a chunk's matched line that comes before `anchor` (the last trace point
// the previous chunk already covered), so joining chunks never doubles back over the overlap.
function trimBefore(coords, anchor) {
  if (!anchor || coords.length < 2) return coords;
  let best = 0;
  let bestDist = Infinity;
  coords.forEach((c, i) => {
    const d = meters(c, anchor);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return coords.slice(best);
}

// Join consecutive matched coordinate lists, dropping a leading point that repeats the
// previous list's last point (to within a metre).
function stitch(lists) {
  const out = [];
  lists.forEach((list) => {
    list.forEach((pt) => {
      const prev = out[out.length - 1];
      if (prev && meters(prev, pt) < 1) return;
      out.push(pt);
    });
  });
  return out;
}

async function matchWithSize(points, size) {
  const results = [];
  for (const chunk of planChunks(points, size)) {
    if (chunk.points.length < 2) continue;
    // Sequential, not parallel: gentle on a shared server.
    // eslint-disable-next-line no-await-in-loop
    const matchings = (await requestMatch(chunk.points)).filter((m) => m.coords.length >= 2);
    if (matchings.length === 0) continue;
    let coords = matchings.flatMap((m) => m.coords);
    if (chunk.skip > 0) coords = trimBefore(coords, chunk.points[chunk.skip - 1]);
    results.push({
      coords,
      confidence: matchings.reduce((sum, m) => sum + m.confidence, 0) / matchings.length
    });
  }
  return results;
}

/**
 * Match `points` ({lat,lng,acc?}) to roads.
 * Returns { coords: [{lat,lng}], confidence: 0..1, provider: 'osrm' }.
 * Throws MatchUnavailable when the service cannot be reached.
 */
async function matchTrace(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { coords: [], confidence: 0, provider: 'osrm' };
  }

  let results;
  // A server that refuses the request as too large is asked again with smaller pieces,
  // and the size that worked is remembered.
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results = await matchWithSize(points, currentMaxPoints());
      break;
    } catch (error) {
      if (!(error instanceof TooBigError)) throw error;
      if (error.kind === 'radius') {
        // Same trace, narrower search: 50 -> 40 -> 32 -> 25 -> 20 -> 16 -> 15.
        const narrower = Math.max(MIN_RADIUS, Math.floor(currentMaxRadius() * 0.8));
        if (narrower >= currentMaxRadius()) {
          throw new MatchUnavailable('Map matcher unavailable: it refuses even the narrowest search radius');
        }
        learnedMaxRadius = narrower;
        continue;
      }
      const next = Math.floor(currentMaxPoints() / 2);
      if (next < MIN_MAX_POINTS) {
        throw new MatchUnavailable('Map matcher unavailable: it refuses even very small requests');
      }
      learnedMaxPoints = next;
    }
  }

  if (results.length === 0) return { coords: [], confidence: 0, provider: 'osrm' };
  const confidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
  return { coords: stitch(results.map((r) => r.coords)), confidence, provider: 'osrm' };
}

/** Test helper: forget the request size learned from the server. */
function resetLearnedLimit() {
  learnedMaxPoints = null;
  learnedMaxRadius = null;
}

module.exports = {
  matchTrace,
  MatchUnavailable,
  chunkWithOverlap,
  planChunks,
  trimBefore,
  stitch,
  resetLearnedLimit
};
