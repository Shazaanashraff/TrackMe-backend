// REST reads of live vehicle position.
//
// The socket is the live path; these endpoints exist for everything that is not
// holding one — a list screen showing a "Live now" badge, a manager map's
// polling fallback when the socket is down, and a late joiner that wants the
// current position before it subscribes. They are pure reads and never emit.
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const VehicleLiveLocation = require('../models/VehicleLiveLocation');

function locationPayload(doc) {
  if (!doc || doc.lat === null || doc.lng === null) return null;
  return {
    lat: doc.lat,
    lng: doc.lng,
    accuracy: doc.accuracy ?? null,
    speed: doc.speed ?? null,
    heading: doc.heading ?? null,
    recordedAt: doc.recordedAt || doc.receivedAt,
    receivedAt: doc.receivedAt
  };
}

function vehicleSummary(vehicle) {
  return {
    vehicleId: vehicle.vehicleId,
    vehicleName: vehicle.vehicleName || '',
    numberPlate: vehicle.numberPlate || '',
    routeId: vehicle.routeId || '',
    serviceType: vehicle.serviceType || null
  };
}

// @desc    Current position of one vehicle, for a caller allowed to see it.
// @route   GET /api/vehicle/:vehicleId/live?riderId=
// Mirrors the vehicle:subscribe authorization exactly — a rider must own the
// rider profile and be actively enrolled with the vehicle's driver; a manager
// must own the vehicle.
exports.getVehicleLive = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findOne({ vehicleId: req.params.vehicleId, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    const role = req.user.role;

    if (role === 'user') {
      const riderId = req.query.riderId || req.query.studentId;
      if (!riderId) {
        return res.status(400).json({ success: false, message: 'A rider is required' });
      }
      const owned = await RiderProfile.exists({
        _id: riderId,
        accountId: req.user._id,
        isActive: { $ne: false }
      });
      if (!owned) {
        return res.status(404).json({ success: false, message: 'Rider not found' });
      }
      const enrolled = vehicle.driverId && await DriverEnrollment.exists({
        studentId: riderId,
        driverId: vehicle.driverId,
        status: 'ACTIVE'
      });
      if (!enrolled) {
        return res.status(403).json({ success: false, message: 'This rider is not enrolled with this shuttle' });
      }
    } else if (role === 'admin') {
      if (String(vehicle.managerId || '') !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'This vehicle belongs to another manager' });
      }
    } else if (role === 'driver') {
      if (String(vehicle.driverId || '') !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'This is not your vehicle' });
      }
    } else if (role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const [current, driver] = await Promise.all([
      VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean(),
      vehicle.driverId ? Driver.findById(vehicle.driverId).select('name').lean() : null
    ]);

    return res.status(200).json({
      success: true,
      data: {
        vehicleId: vehicle.vehicleId,
        live: Boolean(current?.live),
        location: locationPayload(current),
        vehicle: vehicleSummary(vehicle),
        driver: driver ? { _id: String(driver._id), name: driver.name } : null
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Every vehicle in the caller's fleet with its current position.
// @route   GET /api/manager/vehicles/live
// Scoped to the manager's own vehicles — the fleet is the authorization
// boundary, so there is no id to validate and nothing to leak.
exports.getManagerFleetLive = async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === 'super-admin';
    const filter = isSuperAdmin ? { isDeleted: false } : { managerId: req.user._id, isDeleted: false };

    const vehicles = await Vehicle.find(filter)
      .select('vehicleId vehicleName numberPlate routeId serviceType driverId')
      .lean();

    if (!vehicles.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [locations, drivers] = await Promise.all([
      VehicleLiveLocation.find({ vehicleId: { $in: vehicles.map((v) => v.vehicleId) } }).lean(),
      Driver.find({ _id: { $in: vehicles.map((v) => v.driverId).filter(Boolean) } })
        .select('name')
        .lean()
    ]);

    const locationByVehicle = new Map(locations.map((l) => [l.vehicleId, l]));
    const driverById = new Map(drivers.map((d) => [String(d._id), d]));

    const data = vehicles.map((vehicle) => {
      const current = locationByVehicle.get(vehicle.vehicleId);
      const driver = vehicle.driverId ? driverById.get(String(vehicle.driverId)) : null;
      return {
        vehicleId: vehicle.vehicleId,
        live: Boolean(current?.live),
        location: locationPayload(current),
        vehicle: vehicleSummary(vehicle),
        driver: driver ? { _id: String(driver._id), name: driver.name } : null
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
