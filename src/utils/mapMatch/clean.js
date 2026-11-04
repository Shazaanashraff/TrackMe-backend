// Pre-processing for a driver's raw GPS trace, before it is sent to the map
// matcher. Pure (no I/O) so it is cheap to unit-test.
//
// A raw fix is { lat, lng, t (epoch ms), acc (metres, optional) }.

const { haversineKm } = require('../geo');

const DEFAULTS = {
  maxAccuracyMeters: 50,   // worse fixes are dropped
  maxSpeedMps: 35,         // ~126 km/h; faster implied movement is a teleport
  spacingMeters: 15        // fixes closer than this to the last kept one are dropped
};

const isFix = (p) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

const meters = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

/**
 * Returns a cleaned copy of `points`, in time order.
 */
function cleanTrace(points, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!Array.isArray(points)) return [];

  // 1. Drop malformed and low-accuracy fixes, then put the rest in time order
  //    (a missing timestamp keeps the arrival order).
  const usable = points
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => isFix(p) && !(Number.isFinite(p.acc) && p.acc > o.maxAccuracyMeters))
    .sort((a, b) => {
      const ta = Number.isFinite(a.p.t) ? a.p.t : null;
      const tb = Number.isFinite(b.p.t) ? b.p.t : null;
      if (ta !== null && tb !== null && ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(({ p }) => p);

  // 2. Drop teleports: a fix that implies an impossible speed from the last kept one.
  const noTeleports = [];
  usable.forEach((p) => {
    const prev = noTeleports[noTeleports.length - 1];
    if (!prev) { noTeleports.push(p); return; }
    if (Number.isFinite(p.t) && Number.isFinite(prev.t) && p.t > prev.t) {
      const speed = meters(prev, p) / ((p.t - prev.t) / 1000);
      if (speed > o.maxSpeedMps) return;
    }
    noTeleports.push(p);
  });

  // 3. Thin the trace: a fix within spacingMeters of the last kept one is dropped.
  //    That collapses the wandering GPS cloud a stationary vehicle produces (stops,
  //    lights, queues) into one point, and removes jitter while crawling. The final
  //    fix is always kept so the trace still ends where the ride ended.
  const spaced = [];
  noTeleports.forEach((p) => {
    const prev = spaced[spaced.length - 1];
    if (!prev || meters(prev, p) >= o.spacingMeters) spaced.push(p);
  });
  const last = noTeleports[noTeleports.length - 1];
  if (last && spaced[spaced.length - 1] !== last) spaced.push(last);

  return spaced;
}

module.exports = { cleanTrace, DEFAULTS };
