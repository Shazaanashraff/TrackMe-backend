// A vehicle's trip identity for a given day, e.g. "VH-001#2026-08-14".
//
// Shared so live location and QR attendance describe the same trip: a boarding
// scan and the positions recorded around it must agree on what they belong to,
// and two independent copies of this string would drift the first time either
// side changed how a day is bucketed.
//
// It is a UTC-day bucket, not a document. That is coarse — a shift crossing
// midnight UTC splits in two — but it needs no start/stop bookkeeping and is
// stable across restarts, which a session document would not be.
function dayTripId(vehicleId, at = new Date()) {
  return `${vehicleId}#${at.toISOString().slice(0, 10)}`;
}

module.exports = { dayTripId };
