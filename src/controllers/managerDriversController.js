// Manager-facing driver directory. A driver belongs to exactly one manager
// (Driver.managerId), so every handler here scopes by req.user._id. A manager
// can never read or edit another manager's drivers.
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Organization = require('../models/Organization');
const DriverEnrollmentKey = require('../models/DriverEnrollmentKey');
const { isEmailRegistered } = require('../utils/accountRegistry');
const {
  ensureDriverEnrollmentKey,
  rotateDriverEnrollmentKey
} = require('../utils/enrollmentKey');
const { generateUniqueDriverCode } = require('../utils/driverCode');
const { plateMatches } = require('../utils/numberPlate');
const {
  createOrganization,
  isOrgServiceType,
  listOrganizations,
  publicOrganization
} = require('../utils/organizations');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sanitizeDriver = (driver, vehicle, organization) => ({
  _id: driver._id,
  // The permanent sign-in ID. Drivers created before it existed have none
  // until the backfill runs, so it can be null.
  driverCode: driver.driverCode || null,
  name: driver.name,
  email: driver.email || '',
  organization: publicOrganization(organization),
  phoneNumber: driver.phoneNumber || '',
  nicNumber: driver.nicNumber || '',
  licenseCardNumber: driver.licenseCardNumber || '',
  isActive: driver.isActive !== false,
  // Denormalised for the directory table: the driver's currently assigned
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

// The form offers "choose existing" or "create new" in one step, so the request
// may carry either an id or a name + category. Resolves to { organizationId }
// or { error: { status, message } }.
async function resolveOrganization(body, actorId) {
  const { organizationId, organizationName, organizationCategory } = body || {};

  if (organizationId) {
    const organization = await Organization.findOne({
      _id: organizationId,
      isDeleted: false
    }).lean();
    if (!organization) {
      return { error: { status: 400, message: 'Organization not found' } };
    }
    return { organizationId: organization._id };
  }

  const name = String(organizationName || '').trim();
  if (!name) return { organizationId: null };

  if (!isOrgServiceType(organizationCategory)) {
    return {
      error: {
        status: 400,
        message: 'Choose a category (school, university, or office) for the new organization'
      }
    };
  }

  const result = await createOrganization({
    name,
    serviceType: organizationCategory,
    createdBy: actorId
  });
  if (result.error) return { error: result.error };
  return { organizationId: result.organization._id };
}

// "Vehicle number" on the form is whatever the manager calls the bus: its
// vehicle ID or its number plate. Vehicles are created on the Vehicles page,
// so this only ever assigns an existing one; it never creates a vehicle.
async function findManagerVehicleByNumber(managerId, vehicleNumber) {
  const value = String(vehicleNumber || '').trim();
  if (!value) return null;

  const byId = await Vehicle.findOne({ managerId, isDeleted: false, vehicleId: value });
  if (byId) return byId;

  // Plates are compared canonically, so "PF- 2327", "pf2327" and "PF-2327" all
  // find the same bus. Legacy rows were stored before plates were normalised,
  // hence the comparison in memory rather than a query on an exact string.
  // A manager's fleet is small enough that reading it is cheaper than keeping a
  // second normalised field in step.
  // Full documents, not a projection: the match gets its driver reassigned and
  // saved, and saving a partially selected vehicle is asking for trouble.
  const fleet = await Vehicle.find({ managerId, isDeleted: false });
  return fleet.find((vehicle) => plateMatches(vehicle.numberPlate, value)) || null;
}

// Managers pick (or add) the school/university/office a driver serves while
// creating them, so they get the same organization list the super admin has.
exports.getOrganizationsForManager = async (req, res, next) => {
  try {
    const organizations = await listOrganizations(req.query.serviceType);
    return res.status(200).json({ success: true, count: organizations.length, data: organizations });
  } catch (error) {
    next(error);
  }
};

exports.createOrganizationForManager = async (req, res, next) => {
  try {
    const result = await createOrganization({
      name: req.body?.name,
      serviceType: req.body?.serviceType,
      createdBy: req.user?._id || null
    });

    if (result.error) {
      return res.status(result.error.status).json({ success: false, message: result.error.message });
    }

    return res.status(201).json({
      success: true,
      message: 'Organization created successfully',
      data: publicOrganization(result.organization)
    });
  } catch (error) {
    next(error);
  }
};

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

    // One lookup for the whole page rather than a populate per driver.
    const organizationIds = [...new Set(
      drivers.map((d) => d.organization).filter(Boolean).map(String)
    )];
    const organizations = organizationIds.length
      ? await Organization.find({ _id: { $in: organizationIds } })
        .select('name serviceType')
        .lean()
      : [];
    const organizationById = new Map(organizations.map((o) => [String(o._id), o]));

    const data = drivers.map((driver) => {
      const vehicle = vehicleByDriver.get(String(driver._id)) || null;
      const organization = driver.organization
        ? organizationById.get(String(driver.organization)) || null
        : null;
      return {
        ...sanitizeDriver(driver, vehicle, organization),
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
    const {
      name, email, password, phoneNumber, nicNumber, licenseCardNumber, vehicleNumber
    } = req.body || {};

    // Email is optional, because the driver always gets a driver code to sign
    // in with, and many drivers have no work email at all.
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!String(name || '').trim() || !password) {
      return res.status(400).json({
        success: false,
        message: 'name and password are required'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    if (normalizedEmail && !emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }

    if (normalizedEmail && await isEmailRegistered(normalizedEmail)) {
      return res.status(409).json({
        success: false,
        message: 'This email is already registered to a different account type.'
      });
    }

    const org = await resolveOrganization(req.body, req.user._id);
    if (org.error) {
      return res.status(org.error.status).json({ success: false, message: org.error.message });
    }

    // Resolved before the driver exists, so a bad vehicle number fails without
    // leaving a half-provisioned account behind.
    const requestedVehicleNumber = String(vehicleNumber || '').trim();
    let vehicle = null;
    if (requestedVehicleNumber) {
      vehicle = await findManagerVehicleByNumber(req.user._id, requestedVehicleNumber);
      if (!vehicle) {
        return res.status(400).json({
          success: false,
          message: `No vehicle numbered ${requestedVehicleNumber} in your fleet`
        });
      }
    }

    const driver = await Driver.create({
      name: String(name).trim(),
      // Left off entirely rather than stored blank, so the sparse unique index
      // does not treat two email-less drivers as duplicates.
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      driverCode: await generateUniqueDriverCode(Driver),
      password,
      organization: org.organizationId,
      phoneNumber: String(phoneNumber || '').trim(),
      nicNumber: String(nicNumber || '').trim(),
      licenseCardNumber: String(licenseCardNumber || '').trim(),
      isActive: true,
      // Nothing to verify without an email, and a manager-created account is
      // already vouched for.
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

    // A vehicle always has a driver (the schema requires one), so assigning it
    // here takes it off whoever held it before, which the response says plainly.
    let reassignedFrom = null;
    if (vehicle) {
      const previousDriverId = vehicle.driverId;
      vehicle.driverId = driver._id;
      await vehicle.save();
      if (previousDriverId && String(previousDriverId) !== String(driver._id)) {
        const previous = await Driver.findById(previousDriverId).select('name').lean();
        reassignedFrom = previous?.name || null;
      }
    }

    const organization = org.organizationId
      ? await Organization.findById(org.organizationId).select('name serviceType').lean()
      : null;

    return res.status(201).json({
      success: true,
      message: reassignedFrom
        ? `Driver created. Vehicle ${vehicle.vehicleId} moved from ${reassignedFrom}.`
        : 'Driver created successfully',
      data: sanitizeDriver(driver, vehicle, organization),
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
      if (normalizedEmail !== (driver.email || '')) {
        if (normalizedEmail && !emailRegex.test(normalizedEmail)) {
          return res.status(400).json({ success: false, message: 'Enter a valid email address' });
        }
        if (normalizedEmail) {
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
        }
        // Removing the email has to unset the field, not blank it, because a blank
        // would sit in the sparse unique index and collide with the next one.
        driver.set('email', normalizedEmail || undefined);
      }
    }

    if (req.body.organizationId !== undefined
      || req.body.organizationName !== undefined) {
      const org = await resolveOrganization(req.body, req.user._id);
      if (org.error) {
        return res.status(org.error.status).json({ success: false, message: org.error.message });
      }
      driver.organization = org.organizationId;
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

    const organization = driver.organization
      ? await Organization.findById(driver.organization).select('name serviceType').lean()
      : null;

    return res.status(200).json({
      success: true,
      message: 'Driver updated successfully',
      data: sanitizeDriver(driver, vehicle, organization)
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
