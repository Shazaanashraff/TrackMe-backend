// Manager-facing driver directory. A driver belongs to exactly one manager
// (Driver.managerId), so every handler here scopes by req.user._id — a manager
// can never read or edit another manager's drivers.
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const DriverEnrollmentKey = require('../models/DriverEnrollmentKey');
const { isEmailRegistered } = require('../utils/accountRegistry');
const {
  ensureDriverEnrollmentKey,
  rotateDriverEnrollmentKey
} = require('../utils/enrollmentKey');

const sanitizeDriver = (driver, vehicle) => ({
  _id: driver._id,
  name: driver.name,
  email: driver.email,
  phoneNumber: driver.phoneNumber || '',
  nicNumber: driver.nicNumber || '',
  licenseCardNumber: driver.licenseCardNumber || '',
  isActive: driver.isActive !== false,
  // Denormalised for the directory table — the driver's currently assigned
  // vehicle, or null when they have not been given one yet.
  vehicle: vehicle
    ? { _id: vehicle._id, vehicleId: vehicle.vehicleId, numberPlate: vehicle.numberPlate }
    : null,
  createdAt: driver.createdAt,
  updatedAt: driver.updatedAt
});

// A driver is only fully usable once they have contact details and a vehicle;
// the directory surfaces that as "setup required" rather than "active".
const isSetupComplete = (driver, vehicle) => Boolean(driver.phoneNumber && vehicle);

const findOwnedDriver = (managerId, driverId) =>
  Driver.findOne({ _id: driverId, managerId });

exports.getManagerDrivers = async (req, res, next) => {
  try {
    const drivers = await Driver.find({ managerId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    const vehicles = await Vehicle.find({
      managerId: req.user._id,
      isDeleted: false,
      driverId: { $ne: null }
    })
      .select('vehicleId numberPlate driverId')
      .lean();

    const vehicleByDriver = new Map(vehicles.map((v) => [String(v.driverId), v]));

    const data = drivers.map((driver) => {
      const vehicle = vehicleByDriver.get(String(driver._id)) || null;
      return {
        ...sanitizeDriver(driver, vehicle),
        setupComplete: isSetupComplete(driver, vehicle)
      };
    });

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

exports.createManagerDriver = async (req, res, next) => {
  try {
    const { name, email, password, phoneNumber, nicNumber, licenseCardNumber } = req.body || {};

    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!String(name || '').trim() || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'name, email and password are required'
      });
    }

    if (await isEmailRegistered(normalizedEmail)) {
      return res.status(409).json({
        success: false,
        message: 'This email is already registered to a different account type.'
      });
    }

    const driver = await Driver.create({
      name: String(name).trim(),
      email: normalizedEmail,
      password,
      phoneNumber: String(phoneNumber || '').trim(),
      nicNumber: String(nicNumber || '').trim(),
      licenseCardNumber: String(licenseCardNumber || '').trim(),
      isActive: true,
      isEmailVerified: true,
      managerId: req.user._id
    });

    // Handed to the manager once, here, so they can pass it to the driver.
    // If key creation fails the driver is rolled back rather than left
    // half-provisioned with no way to enrol passengers.
    let enrollmentKey;
    try {
      enrollmentKey = await ensureDriverEnrollmentKey(driver._id);
    } catch (error) {
      await Driver.deleteOne({ _id: driver._id });
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: 'Driver created successfully',
      data: sanitizeDriver(driver, null),
      enrollmentKey
    });
  } catch (error) {
    next(error);
  }
};

exports.updateManagerDriver = async (req, res, next) => {
  try {
    const driver = await findOwnedDriver(req.user._id, req.params.driverId);
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found for this manager' });
    }

    const { name, email, phoneNumber, nicNumber, licenseCardNumber, isActive } = req.body || {};

    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (normalizedEmail !== driver.email) {
        const taken = await isEmailRegistered(normalizedEmail, {
          excludeId: driver._id,
          excludeRole: 'driver'
        });
        if (taken) {
          return res.status(409).json({
            success: false,
            message: 'Email already in use by another account'
          });
        }
        driver.email = normalizedEmail;
      }
    }

    if (name !== undefined) driver.name = String(name).trim();
    if (phoneNumber !== undefined) driver.phoneNumber = String(phoneNumber).trim();
    if (nicNumber !== undefined) driver.nicNumber = String(nicNumber).trim();
    if (licenseCardNumber !== undefined) driver.licenseCardNumber = String(licenseCardNumber).trim();
    if (isActive !== undefined) driver.isActive = Boolean(isActive);

    await driver.save();

    const vehicle = await Vehicle.findOne({
      driverId: driver._id,
      managerId: req.user._id,
      isDeleted: false
    })
      .select('vehicleId numberPlate')
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Driver updated successfully',
      data: sanitizeDriver(driver, vehicle)
    });
  } catch (error) {
    next(error);
  }
};

exports.resetManagerDriverPassword = async (req, res, next) => {
  try {
    const { password } = req.body || {};

    const driver = await findOwnedDriver(req.user._id, req.params.driverId);
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found for this manager' });
    }

    driver.password = password;
    await driver.save();

    return res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

exports.getDriverEnrollmentKey = async (req, res, next) => {
  try {
    const driver = await findOwnedDriver(req.user._id, req.params.driverId);
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found for this manager' });
    }

    const enrollmentKey = await ensureDriverEnrollmentKey(driver._id);
    return res.status(200).json({ success: true, data: { enrollmentKey } });
  } catch (error) {
    next(error);
  }
};

exports.rotateDriverEnrollmentKey = async (req, res, next) => {
  try {
    const driver = await findOwnedDriver(req.user._id, req.params.driverId);
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found for this manager' });
    }

    const enrollmentKey = await rotateDriverEnrollmentKey(driver._id);
    return res.status(200).json({
      success: true,
      message: 'Enrollment key rotated. The previous key no longer works.',
      data: { enrollmentKey }
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteManagerDriver = async (req, res, next) => {
  try {
    const driver = await findOwnedDriver(req.user._id, req.params.driverId);
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found for this manager' });
    }

    // A driver still behind the wheel would leave a vehicle driverless, so the
    // assignment has to be cleared before the account can go.
    const assignedVehicle = await Vehicle.findOne({
      driverId: driver._id,
      isDeleted: false
    }).select('vehicleId');

    if (assignedVehicle) {
      return res.status(409).json({
        success: false,
        message: `Unassign this driver from vehicle ${assignedVehicle.vehicleId} before deleting`
      });
    }

    await DriverEnrollmentKey.deleteOne({ driverId: driver._id });
    await driver.deleteOne();

    return res.status(200).json({ success: true, message: 'Driver deleted successfully' });
  } catch (error) {
    next(error);
  }
};
