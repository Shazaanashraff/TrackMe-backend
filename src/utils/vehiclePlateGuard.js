// One place that answers "is this plate already taken?", so every write path
// tells the manager the same thing.
//
// The unique index on Vehicle.plateKey is what actually makes a duplicate
// impossible; this exists to turn that into a sentence a person can act on
// before the index has to. Deleted vehicles are included on purpose: a
// soft-deleted bus still holds its registration, and the index still enforces
// it, so pretending the plate is free would only produce a confusing failure
// on save.
const Vehicle = require('../models/Vehicle');
const { plateKey } = require('./numberPlate');

const findVehicleByPlate = async (plate, { excludeId } = {}) => {
  const key = plateKey(plate);
  if (!key) return null;

  const filter = { plateKey: key };
  if (excludeId) filter._id = { $ne: excludeId };

  return Vehicle.findOne(filter).select('vehicleId numberPlate managerId isDeleted').lean();
};

// Returns null when the plate is free, or { status, message } describing who
// holds it, in terms of what this manager can see.
const plateConflict = async (plate, { managerId, excludeId } = {}) => {
  const taken = await findVehicleByPlate(plate, { excludeId });
  if (!taken) return null;

  if (taken.isDeleted) {
    return {
      status: 409,
      message: `Number plate ${taken.numberPlate} belonged to a deleted vehicle `
        + 'and cannot be reused'
    };
  }

  const mine = managerId && String(taken.managerId || '') === String(managerId);
  return {
    status: 409,
    message: mine
      ? `Number plate ${taken.numberPlate} is already on vehicle ${taken.vehicleId}`
      : `Number plate ${taken.numberPlate} already belongs to another vehicle`
  };
};

module.exports = { findVehicleByPlate, plateConflict };
