// One entry point for map matching, so the provider can change (public OSRM for
// development, a self-hosted OSRM/Valhalla for production) without touching
// callers. Selected by MAP_MATCH_PROVIDER; only 'osrm' exists today.

const { cleanTrace } = require('./clean');
const osrm = require('./osrm');

const providers = { osrm };

function provider() {
  const name = String(process.env.MAP_MATCH_PROVIDER || 'osrm').toLowerCase();
  return providers[name] || osrm;
}

/**
 * Clean a raw GPS trace and fit it to the road network.
 * Returns { coords, confidence, provider, cleanedCount }.
 * Throws MatchUnavailable when the matcher cannot be reached.
 */
async function matchRawTrace(rawPoints, options) {
  const cleaned = cleanTrace(rawPoints, options);
  const result = await provider().matchTrace(cleaned);
  return { ...result, cleanedCount: cleaned.length };
}

module.exports = { matchRawTrace, cleanTrace, MatchUnavailable: osrm.MatchUnavailable };
