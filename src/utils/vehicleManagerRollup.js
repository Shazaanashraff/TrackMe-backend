/**
 * Pure helpers for rolling up per-vehicle Booking/VehicleReview aggregation
 * results into per-manager totals — see issue #83.
 *
 * Booking and VehicleReview don't carry a `managerId` field (only `vehicleId`),
 * so getting per-manager stats used to mean `$lookup`-ing every Booking/
 * VehicleReview document against `vehicles` and `$match`-ing the joined
 * `managerId` *after* the join. That forces a full collection scan of
 * Booking/VehicleReview on every super-admin dashboard load, ignoring the
 * compound `{ vehicleId, journeyDate, status }` / `{ vehicleId, createdAt }`
 * indexes those collections already have.
 *
 * The fix: fetch the (small, managerId-indexed) list of relevant vehicles
 * first, aggregate Booking/VehicleReview with a `$match` on `vehicleId`
 * (an index seek) grouped by vehicleId — no `$lookup` needed at all — then
 * use these pure functions to roll the per-vehicle numbers up to
 * per-manager numbers in application code.
 */

const emptyBookingStats = () => ({
  totalBookings: 0,
  confirmedBookings: 0,
  cancelledBookings: 0,
  totalRevenue: 0
});

const emptyReviewStats = () => ({
  averageRating: 0,
  reviewCount: 0
});

/**
 * @param {Array<{_id: any, managerId: any}>} vehicles - lean Vehicle docs (or projections) with managerId
 * @returns {Map<string, string>} vehicleId (string) -> managerId (string)
 */
function buildVehicleManagerMap(vehicles) {
  const map = new Map();
  for (const vehicle of vehicles || []) {
    if (vehicle && vehicle._id != null && vehicle.managerId != null) {
      map.set(String(vehicle._id), String(vehicle.managerId));
    }
  }
  return map;
}

/**
 * Sums per-vehicle booking stats (as produced by a Booking.aggregate
 * `$group` on `$vehicleId`) into per-manager totals.
 *
 * @param {Array<{_id: any, totalBookings?: number, confirmedBookings?: number, cancelledBookings?: number, totalRevenue?: number}>} perVehicleStats
 * @param {Map<string,string>} vehicleManagerMap
 * @returns {Map<string, {totalBookings: number, confirmedBookings: number, cancelledBookings: number, totalRevenue: number}>}
 */
function rollUpBookingStatsByManager(perVehicleStats, vehicleManagerMap) {
  const result = new Map();
  for (const stat of perVehicleStats || []) {
    const managerId = vehicleManagerMap.get(String(stat._id));
    // A vehicle deleted/reassigned between the two queries has no map entry
    // — drop it rather than misattribute its bookings to the wrong manager.
    if (!managerId) continue;
    const current = result.get(managerId) || emptyBookingStats();
    result.set(managerId, {
      totalBookings: current.totalBookings + (stat.totalBookings || 0),
      confirmedBookings: current.confirmedBookings + (stat.confirmedBookings || 0),
      cancelledBookings: current.cancelledBookings + (stat.cancelledBookings || 0),
      totalRevenue: current.totalRevenue + (stat.totalRevenue || 0)
    });
  }
  return result;
}

/**
 * Weighted-average rollup of per-vehicle `{ averageRating, reviewCount }`
 * into per-manager `{ averageRating, reviewCount }`. Mathematically equal
 * to averaging every review document for that manager directly
 * (sum(rating) / count), computed here as sum(avg * count) / sum(count)
 * since only the per-vehicle average + count are available.
 *
 * @param {Array<{_id: any, averageRating?: number, reviewCount?: number}>} perVehicleStats
 * @param {Map<string,string>} vehicleManagerMap
 * @returns {Map<string, {averageRating: number, reviewCount: number}>}
 */
function rollUpReviewStatsByManager(perVehicleStats, vehicleManagerMap) {
  const sums = new Map(); // managerId -> { ratingSum, reviewCount }
  for (const stat of perVehicleStats || []) {
    const managerId = vehicleManagerMap.get(String(stat._id));
    if (!managerId) continue;
    const current = sums.get(managerId) || { ratingSum: 0, reviewCount: 0 };
    const count = stat.reviewCount || 0;
    sums.set(managerId, {
      ratingSum: current.ratingSum + (stat.averageRating || 0) * count,
      reviewCount: current.reviewCount + count
    });
  }
  const result = new Map();
  for (const [managerId, { ratingSum, reviewCount }] of sums) {
    result.set(managerId, {
      averageRating: reviewCount > 0 ? ratingSum / reviewCount : 0,
      reviewCount
    });
  }
  return result;
}

module.exports = {
  emptyBookingStats,
  emptyReviewStats,
  buildVehicleManagerMap,
  rollUpBookingStatsByManager,
  rollUpReviewStatsByManager
};
