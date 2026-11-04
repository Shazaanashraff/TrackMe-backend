// Builds one route from several map-matched recording rides.
//
// Pure functions (no DB / no I/O). The approach is "medoid selection", not
// averaging: every ride is already a real road path, so the ride that agrees most
// with the others IS the route. A detour day or a bad-GPS day simply loses the vote
// and the result is never a blurred line between roads.

const {
  haversineKm,
  resamplePolyline,
  coverageFraction,
  projectOntoPolyline,
  polylineLengthMeters
} = require('./geo');

const RESAMPLE_METERS = 10;
const COVER_RADIUS_METERS = 25;
const ENDPOINT_TOLERANCE_METERS = 150;
const AGREE_THRESHOLD = 0.8;
const STOP_CLUSTER_METERS = 40;

const meters = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Pick the consensus line.
 * @param {Array<{id:any, coords:Array<{lat,lng}>}>} runs matched rides
 * @returns {{winnerIndex:number, confidence:number, agreeing:number, scores:number[]}|null}
 */
function pickConsensusRun(runs) {
  const usable = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => Array.isArray(run.coords) && run.coords.length >= 2);
  if (usable.length === 0) return null;

  const sampled = usable.map(({ run }) => resamplePolyline(run.coords, RESAMPLE_METERS));

  // Completeness: a ride must start and end near where most rides start and end,
  // so a half-ride (or one that wandered off) can never win.
  const medStart = {
    lat: median(usable.map(({ run }) => run.coords[0].lat)),
    lng: median(usable.map(({ run }) => run.coords[0].lng))
  };
  const medEnd = {
    lat: median(usable.map(({ run }) => run.coords[run.coords.length - 1].lat)),
    lng: median(usable.map(({ run }) => run.coords[run.coords.length - 1].lng))
  };
  const eligible = usable.map(({ run }) =>
    meters(run.coords[0], medStart) <= ENDPOINT_TOLERANCE_METERS
    && meters(run.coords[run.coords.length - 1], medEnd) <= ENDPOINT_TOLERANCE_METERS);

  // pairwise[i][j] = how much of ride i lies on ride j.
  const pairwise = sampled.map((a, i) => sampled.map((_, j) =>
    (i === j ? 1 : coverageFraction(a, usable[j].run.coords, COVER_RADIUS_METERS))));

  const agreement = (i, j) => Math.min(pairwise[i][j], pairwise[j][i]);
  const scores = sampled.map((_, i) => {
    if (sampled.length === 1) return 1;
    let sum = 0;
    for (let j = 0; j < sampled.length; j += 1) if (j !== i) sum += agreement(i, j);
    return sum / (sampled.length - 1);
  });

  let winner = -1;
  usable.forEach((_, i) => {
    if (!eligible[i]) return;
    if (winner === -1 || scores[i] > scores[winner]) winner = i;
  });
  if (winner === -1) {
    // Nobody is eligible (rides disagree about where they start/end): fall back to
    // the best-scoring ride; the caller sees the low confidence and warns.
    winner = scores.indexOf(Math.max(...scores));
  }

  let agreeing = 1;
  for (let j = 0; j < sampled.length; j += 1) {
    if (j !== winner && agreement(winner, j) >= AGREE_THRESHOLD) agreeing += 1;
  }

  return {
    winnerIndex: usable[winner].index,
    confidence: scores[winner],
    agreeing,
    scores
  };
}

/**
 * Cluster the drivers' "Add stop" taps from all rides and return the stops that
 * enough rides agree on, projected onto `line` and ordered along it.
 * @param {Array<Array<{lat,lng,name?}>>} stopsPerRun
 * @param {Array<{lat,lng}>} line the consensus line
 */
function buildStops(stopsPerRun, line) {
  const taps = [];
  stopsPerRun.forEach((stops, runIndex) => {
    (stops || []).forEach((s) => {
      if (Number.isFinite(s?.lat) && Number.isFinite(s?.lng)) taps.push({ ...s, runIndex });
    });
  });
  const runCount = stopsPerRun.length;
  if (taps.length === 0 || runCount === 0) return [];

  // Greedy clustering: each tap joins the first cluster whose centre is close.
  const clusters = [];
  taps.forEach((tap) => {
    const cluster = clusters.find((c) => meters(c.centre, tap) <= STOP_CLUSTER_METERS);
    if (cluster) {
      cluster.taps.push(tap);
      cluster.centre = {
        lat: median(cluster.taps.map((t) => t.lat)),
        lng: median(cluster.taps.map((t) => t.lng))
      };
    } else {
      clusters.push({ centre: { lat: tap.lat, lng: tap.lng }, taps: [tap] });
    }
  });

  const needed = Math.ceil(runCount / 2);
  const stops = clusters
    .filter((c) => new Set(c.taps.map((t) => t.runIndex)).size >= needed)
    .map((c) => {
      const projected = projectOntoPolyline(c.centre, line);
      const names = c.taps.map((t) => String(t.name || '').trim()).filter(Boolean);
      const counts = {};
      names.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
      const name = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
      return {
        lat: projected ? projected.point.lat : c.centre.lat,
        lng: projected ? projected.point.lng : c.centre.lng,
        name,
        along: projected ? projected.alongMeters : 0
      };
    })
    .sort((a, b) => a.along - b.along);

  return stops.map((s, i) => ({
    stopName: s.name || `Stop ${i + 1}`,
    order: i + 1,
    lat: s.lat,
    lng: s.lng
  }));
}

/**
 * Build the route from matched rides.
 * @param {Array<{id:any, coords:Array<{lat,lng}>, stops?:Array, durationSec?:number}>} runs
 * @returns {null | {coords, confidence, agreeing, warning, stops, distanceKm, estimatedTimeMin, winnerRunId}}
 */
function buildConsensus(runs) {
  const pick = pickConsensusRun(runs);
  if (!pick) return null;

  const winner = runs[pick.winnerIndex];
  const coords = winner.coords;
  const stops = buildStops(runs.map((r) => r.stops || []), coords);

  const needAgree = Math.min(3, runs.length);
  const warning = pick.confidence < AGREE_THRESHOLD || pick.agreeing < needAgree
    ? 'RUNS_DISAGREE'
    : '';

  const durations = runs.map((r) => r.durationSec).filter((d) => Number.isFinite(d) && d > 0);

  return {
    coords,
    confidence: Math.round(pick.confidence * 1000) / 1000,
    agreeing: pick.agreeing,
    warning,
    stops,
    distanceKm: Math.round((polylineLengthMeters(coords) / 1000) * 10) / 10,
    estimatedTimeMin: durations.length ? Math.round(median(durations) / 60) : 0,
    winnerRunId: winner.id
  };
}

module.exports = {
  pickConsensusRun,
  buildStops,
  buildConsensus,
  AGREE_THRESHOLD
};
