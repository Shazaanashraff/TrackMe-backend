const crypto = require('crypto');
const Route = require('../models/Route');

// Auto-provisions a private, unnamed Route for a custom-route driver so
// Bus.routeId (required) has somewhere to point before the driver has
// recorded anything. The manager names it later via PATCH .../name, which
// flips status to ACTIVE. Race-safe: retries on routeId collision since
// Route.routeId is uniquely indexed.
async function createProvisionalCustomRoute({ managerId, serviceType = 'PUBLIC' }) {
  const mgrShort = String(managerId).slice(-6).toUpperCase();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const routeId = `CUST-${mgrShort}-${suffix}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await Route.create({
        routeId,
        routeName: 'Custom Route (Pending)',
        source: 'Custom Route',
        destination: 'Custom Route',
        distance: 0,
        fare: 0,
        serviceType,
        stopsCount: 0,
        stops: [],
        pathPolyline: '',
        visibility: 'PRIVATE',
        managerId,
        origin: 'RECORDED',
        status: 'PENDING_NAMING'
      });
    } catch (err) {
      if (err?.code === 11000) continue; // routeId collision, retry with a new suffix
      throw err;
    }
  }
  throw new Error('Failed to generate a unique custom route ID after multiple attempts');
}

module.exports = { createProvisionalCustomRoute };
