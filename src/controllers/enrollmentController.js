const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Vehicle = require('../models/Vehicle');
const Organization = require('../models/Organization');
const { publicOrganization } = require('../utils/organizations');
const { findDriverIdByEnrollmentKey } = require('../utils/enrollmentKey');
const { findHouseholdProfiles } = require('../utils/identityRegistry');
const { riderTagForServiceType } = require('../utils/riderTag');
const RiderOrganizationProfile = require('../models/StudentOrganizationProfile');
const RiderProfile = require('../models/RiderProfile');
const { normalizedEnrollmentConfig, validateEnrollmentResponses } = require('../utils/enrollmentSchema');
const {
  ensureLegacyRider,
  findOwnedRider,
  assertOwnedPlaces,
  effectiveContactPhone,
  validContactPhone,
  publicRider,
  mapValuesToObject
} = require('../utils/riders');
const { riderRoleForResolvedService } = require('../utils/riderRole');

// One message for every reason a key does not work, so a caller cannot use the
// response to learn which keys exist or which drivers are private.
const INVALID_KEY = 'That enrollment key is not valid';

// The key is a bearer credential, so a passenger who starts guessing gets slowed
// down. Held in memory rather than a collection: this only needs to blunt online
// guessing, and the key space (12 characters over a 32-symbol alphabet) already
// makes exhaustion hopeless. A restart clearing the counters is acceptable for
// that job; if this ever needs to hold across instances it wants a shared store.
const MAX_FAILED_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const failedAttempts = new Map();

function attemptState(userId) {
  const record = failedAttempts.get(String(userId));
  if (!record) return null;
  if (Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
    failedAttempts.delete(String(userId));
    return null;
  }
  return record;
}

function recordFailure(userId) {
  const key = String(userId);
  const record = attemptState(userId);
  if (!record) {
    failedAttempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count += 1;
}

const clearFailures = (userId) => failedAttempts.delete(String(userId));

const isThrottled = (userId) => (attemptState(userId)?.count || 0) >= MAX_FAILED_ATTEMPTS;

// Exposed so tests can start from a clean slate rather than sharing counters.
const resetAttempts = () => failedAttempts.clear();

// includeContact / vehicle.routeId back the "which route does this cover, and who
// do I contact" view. Contact stays opt-in: phone/email are only released once an
// enrollment is ACTIVE, so a bare key lookup never leaks driver contact details.
const driverSummary = (driver, organization, vehicle, includeContact = false) => ({
  _id: driver._id,
  name: driver.name,
  driverCode: driver.driverCode || null,
  phoneNumber: includeContact ? driver.phoneNumber || null : null,
  email: includeContact ? driver.email || null : null,
  organization: publicOrganization(organization),
  vehicle: vehicle
    ? {
        _id: vehicle._id,
        vehicleId: vehicle.vehicleId,
        vehicleName: vehicle.vehicleName,
        numberPlate: vehicle.numberPlate,
        vehicleType: vehicle.vehicleType,
        serviceType: vehicle.serviceType || null,
        routeId: vehicle.routeId || null
      }
    : null
});

const enrollmentSummary = (enrollment, driver, organization, vehicle) => ({
  _id: enrollment._id,
  riderId: enrollment.studentId,
  // Compatibility for clients released before rider-neutral terminology.
  studentId: enrollment.studentId,
  status: enrollment.status,
  requiredApproval: enrollment.requiredApproval,
  requestedAt: enrollment.createdAt,
  decidedAt: enrollment.decidedAt || null,
  pickupPlaceId: enrollment.pickupPlaceId || null,
  dropoffPlaceId: enrollment.dropoffPlaceId || null,
  driver: driver ? driverSummary(driver, organization, vehicle, enrollment.status === 'ACTIVE') : null,
  // Derived from the driver's organization, never stored — see utils/riderTag.js.
  riderTag: riderTagForServiceType(organization?.serviceType)
});

// Shared by getMyEnrollments (one profile) and getHouseholdEnrollments
// (every profile on an identity): fetches ACTIVE/PENDING enrollments for a
// set of profile ids and batch-loads the drivers/organizations/vehicles they
// reference, returning one summary list per profile id. Keeping this in one
// place is what makes the household view's per-profile grouping consistent
// with what a single profile's own "my shuttle" list already shows.
const loadEnrollmentsByProfile = async (profileIds) => {
  const byProfile = new Map(profileIds.map((id) => [String(id), []]));
  if (!profileIds.length) return byProfile;

  // An enrollment is owned by a RiderProfile (`studentId`); `userId` is the
  // pre-split owner the schema keeps for the migration. Resolving the account's
  // riders first is what lets one query find both generations of row — reading
  // `userId` alone silently hides every enrollment made since the split, because
  // createEnrollment writes `userId: null`.
  const riders = await RiderProfile.find({ accountId: { $in: profileIds } })
    .select('_id accountId')
    .lean();
  const accountByRider = new Map(riders.map((r) => [String(r._id), String(r.accountId)]));

  const enrollments = await DriverEnrollment.find({
    status: { $in: ['ACTIVE', 'PENDING'] },
    $or: [
      { studentId: { $in: riders.map((r) => r._id) } },
      { userId: { $in: profileIds } }
    ]
  }).sort({ createdAt: -1 }).lean();

  if (!enrollments.length) return byProfile;

  const driverIds = enrollments.map((item) => item.driverId);
  const drivers = await Driver.find({ _id: { $in: driverIds } })
    .select('name driverCode organization isActive phoneNumber email')
    .lean();

  const orgIds = drivers.map((d) => d.organization).filter(Boolean);
  const [organizations, vehicles] = await Promise.all([
    orgIds.length
      ? Organization.find({ _id: { $in: orgIds } }).select('name serviceType').lean()
      : [],
    Vehicle.find({ driverId: { $in: driverIds } }).select('vehicleId vehicleName numberPlate vehicleType serviceType driverId routeId').lean()
  ]);

  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const orgById = new Map(organizations.map((o) => [String(o._id), o]));
  const vehicleByDriver = new Map(vehicles.map((v) => [String(v.driverId), v]));

  for (const enrollment of enrollments) {
    const driver = driverById.get(String(enrollment.driverId));
    const organization = driver?.organization ? orgById.get(String(driver.organization)) : null;
    const summary = enrollmentSummary(enrollment, driver, organization, vehicleByDriver.get(String(enrollment.driverId)));

    // Group under the owning account: via the rider for post-split rows, and by
    // the legacy owner for rows the migration has not translated yet.
    const key = accountByRider.get(String(enrollment.studentId)) || String(enrollment.userId);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(summary);
  }

  return byProfile;
};

// @route POST /api/enrollments/redeem
exports.redeemEnrollmentKey = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const raw = String(req.body?.key || '').trim();

    if (!raw) {
      return res.status(400).json({ success: false, message: 'Please provide an enrollment key' });
    }

    if (isThrottled(userId)) {
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect keys. Please wait a few minutes and try again.'
      });
    }

    const driverId = await findDriverIdByEnrollmentKey(raw);
    const driver = driverId ? await Driver.findById(driverId) : null;

    // An inactive driver is treated exactly like an unknown key: a passenger has
    // no business learning that a suspended driver exists.
    if (!driver || driver.isActive === false) {
      recordFailure(userId);
      return res.status(404).json({ success: false, message: INVALID_KEY });
    }

    clearFailures(userId);

    // This account-scoped entry point predates rider profiles, but the row it
    // writes must still name one: `studentId` is required, and an enrollment
    // saved without it cannot later be approved (a manager's approve calls
    // enrollment.save(), which validates the whole document and rejects).
    const rider = await ensureLegacyRider(req.user);

    const [organization, vehicle, existing] = await Promise.all([
      driver.organization
        ? Organization.findById(driver.organization).select('name serviceType').lean()
        : null,
      Vehicle.findOne({ driverId: driver._id }).select('vehicleId vehicleName numberPlate vehicleType serviceType routeId').lean(),
      DriverEnrollment.findOne({ studentId: rider._id, driverId: driver._id })
    ]);

    if (existing?.status === 'ACTIVE') {
      return res.status(409).json({
        success: false,
        message: `You are already enrolled with ${driver.name}`,
        data: enrollmentSummary(existing, driver, organization, vehicle)
      });
    }

    // Re-submitting while a request is queued is a no-op rather than an error, so
    // a double tap on a slow connection does not read as a failure.
    if (existing?.status === 'PENDING') {
      return res.status(200).json({
        success: true,
        message: `Your request is waiting for ${driver.name}'s manager to approve it`,
        data: enrollmentSummary(existing, driver, organization, vehicle)
      });
    }

    const requiredApproval = Boolean(driver.isPrivate);
    const status = requiredApproval ? 'PENDING' : 'ACTIVE';

    // Upsert rather than create: a previously REJECTED row is revived here, which
    // also lets the unique (studentId, driverId) index stand guard against duplicates.
    const enrollment = await DriverEnrollment.findOneAndUpdate(
      { studentId: rider._id, driverId: driver._id },
      {
        $set: {
          studentId: rider._id,
          userId,
          driverId: driver._id,
          managerId: driver.managerId || null,
          status,
          requiredApproval,
          decidedBy: null,
          decidedAt: null
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
      success: true,
      message: requiredApproval
        ? `Request sent. ${driver.name}'s manager needs to approve it.`
        : `You are now enrolled with ${driver.name}`,
      data: enrollmentSummary(enrollment, driver, organization, vehicle)
    });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/enrollments/mine
// Returns joined shuttles and anything still awaiting approval. Rejected records
// are left out: to the passenger the request simply did not succeed.
exports.getMyEnrollments = async (req, res, next) => {
  try {
    const byProfile = await loadEnrollmentsByProfile([req.user._id]);
    return res.status(200).json({ success: true, data: byProfile.get(String(req.user._id)) || [] });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/profiles/household/enrollments
// Every profile on the caller's identity — the account holder plus everyone
// they manage — with its own ACTIVE/PENDING enrollments, so the app can show
// one map with every household member's shuttle at once (see
// docs/modules/PROFILES.md). An identity-less caller (a pre-migration
// account, in principle) gets an empty list rather than an unscoped query —
// there is no household to return.
exports.getHouseholdEnrollments = async (req, res, next) => {
  try {
    if (!req.identityId) {
      return res.status(200).json({ success: true, data: [] });
    }

    const profiles = await findHouseholdProfiles(req.identityId);
    if (!profiles.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const byProfile = await loadEnrollmentsByProfile(profiles.map((p) => p._id));

    const data = profiles.map((profile) => ({
      profile: {
        _id: profile._id,
        name: profile.name,
        relation: profile.relation || '',
        profileKind: profile.profileKind,
        hasAvatar: Boolean(profile.avatarUrl)
      },
      enrollments: byProfile.get(String(profile._id)) || []
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/enrollments/:id
// Leaving and cancelling a pending request are the same action to the passenger,
// so both drop the record and let them start over later.
exports.leaveEnrollment = async (req, res, next) => {
  try {
    // Scoped to the caller either way: through a rider they own, or through the
    // legacy owner field on a row the migration has not translated yet.
    const riderIds = await RiderProfile.find({ accountId: req.user._id }).distinct('_id');
    const enrollment = await DriverEnrollment.findOneAndDelete({
      _id: req.params.id,
      $or: [{ studentId: { $in: riderIds } }, { userId: req.user._id }]
    });

    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }

    // This is the only place a rider ever comes off ACTIVE — there is no
    // manager-side removal. If they had a live-tracking socket open on this
    // vehicle it stays joined to the room until it disconnects or explicitly
    // unsubscribes, so tell it to leave now rather than on a timeout.
    if (enrollment.status === 'ACTIVE') {
      const vehicle = await Vehicle.findOne({ driverId: enrollment.driverId, isDeleted: false })
        .select('vehicleId')
        .lean();
      if (vehicle) {
        req.app.get('io')?.to(`vehicle:${vehicle.vehicleId}`).emit('vehicle:access-revoked', {
          vehicleId: vehicle.vehicleId,
          riderId: String(enrollment.studentId || '')
        });
      }
    }

    return res.status(200).json({ success: true, message: 'Enrollment removed' });
  } catch (error) {
    next(error);
  }
};

exports.resetAttempts = resetAttempts;

// ── Rider-profile enrollment ────────────────────────────────────────────────
// Additive to the key-redemption flow above: these endpoints enroll a specific
// rider profile owned by the caller, and answer "which route does this key
// cover, and who do I call" before the passenger commits to enrolling.

async function resolveKeyContext(account, key, riderId) {
  const rider = await findOwnedRider(account, riderId);
  if (!rider) return { error: { status: 404, message: 'Rider not found' } };
  if (isThrottled(account._id)) {
    return { error: { status: 429, message: 'Too many incorrect keys. Please wait a few minutes and try again.' } };
  }

  const raw = String(key || '').trim();
  if (!raw) return { error: { status: 400, message: 'Please provide an enrollment key' } };
  const driverId = await findDriverIdByEnrollmentKey(raw);
  const driver = driverId ? await Driver.findById(driverId) : null;
  if (!driver || driver.isActive === false) {
    recordFailure(account._id);
    return { error: { status: 404, message: INVALID_KEY } };
  }
  clearFailures(account._id);

  const [organization, vehicle, existingEnrollment] = await Promise.all([
    driver.organization ? Organization.findById(driver.organization) : null,
    Vehicle.findOne({ driverId: driver._id }).select('vehicleId vehicleName numberPlate vehicleType serviceType routeId').lean(),
    DriverEnrollment.findOne({ studentId: rider._id, driverId: driver._id })
  ]);
  const organizationProfile = organization
    ? await RiderOrganizationProfile.findOne({ studentId: rider._id, organizationId: organization._id })
    : null;

  return { raw, rider, driver, organization, vehicle, existingEnrollment, organizationProfile };
}


exports.resolveEnrollmentKey = async (req, res, next) => {
  try {
    const context = await resolveKeyContext(req.user, req.body?.key, req.body?.riderId || req.body?.studentId);
    if (context.error) return res.status(context.error.status).json({ success: false, message: context.error.message });
    const config = context.organization ? normalizedEnrollmentConfig(context.organization) : { schemaVersion: 1, fields: [] };
    return res.status(200).json({
      success: true,
      data: {
        rider: publicRider(context.rider, req.user),
        // Compatibility for clients released before rider-neutral terminology.
        student: publicRider(context.rider, req.user),
        driver: driverSummary(context.driver, context.organization, context.vehicle, false),
        schemaVersion: config.schemaVersion,
        fields: config.fields.filter((field) => field.enabled),
        // createEnrollment refuses without a valid contact phone, but the phone
        // is not one of the organization's `fields` — so a client rendering
        // only `fields` had no way to collect it and no way to know it was
        // missing. It hit a 400 it could not act on.
        contactPhone: effectiveContactPhone(context.rider, req.user),
        contactPhoneRequired: !validContactPhone(effectiveContactPhone(context.rider, req.user)),
        existingValues: mapValuesToObject(context.organizationProfile?.values),
        needsUpdate: Boolean(context.organizationProfile?.needsUpdate),
        existingEnrollment: context.existingEnrollment
          ? enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle)
          : null
      }
    });
  } catch (error) { next(error); }
};

async function createEnrollment(req, { legacy = false } = {}) {
  const riderId = req.params?.riderId || req.params?.studentId || req.body?.riderId || req.body?.studentId;
  const context = await resolveKeyContext(req.user, req.body?.key, riderId);
  if (context.error) return context;

  // A caller may supply the contact phone with the enrolment itself, which is
  // the only way an account that has never set one can get past this check
  // without a separate profile-edit round trip.
  const submittedPhone = String(req.body?.contactPhone ?? req.body?.guardianPhone ?? '').trim();
  if (submittedPhone) {
    if (!validContactPhone(submittedPhone)) {
      return { error: { status: 400, message: 'Enter a valid contact phone number', errors: { contactPhone: 'Invalid' } } };
    }
    context.rider.guardianPhoneOverride = submittedPhone;
    await context.rider.save();
  }

  if (!validContactPhone(effectiveContactPhone(context.rider, req.user))) {
    const role = riderRoleForResolvedService(context.organization?.serviceType);
    return {
      error: {
        status: 400,
        message: `Add a valid contact phone number before enrolling this ${role}`,
        code: 'CONTACT_PHONE_REQUIRED',
        errors: { contactPhone: 'Required', guardianPhone: 'Required' }
      }
    };
  }

  const pickupPlaceId = req.body?.pickupPlaceId ?? context.rider.defaultPickupPlaceId ?? null;
  const dropoffPlaceId = req.body?.dropoffPlaceId ?? context.rider.defaultDropoffPlaceId ?? null;
  const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupPlaceId, dropoffPlaceId]);
  if (!ownedPlaces.valid) {
    return { error: { status: 400, message: 'Pickup or drop-off location does not belong to this account' } };
  }

  let organizationProfile = null;
  if (context.organization) {
    const config = normalizedEnrollmentConfig(context.organization);
    if (!legacy && Number(req.body?.schemaVersion) !== config.schemaVersion) {
      return { error: { status: 409, message: 'The organization updated its enrollment form. Review the latest fields and try again.', code: 'SCHEMA_STALE' } };
    }
    const validation = validateEnrollmentResponses(config, req.body?.responses);
    if (!legacy && !validation.valid) {
      return { error: { status: 400, message: 'Complete the required enrollment fields', errors: validation.errors } };
    }
    organizationProfile = await RiderOrganizationProfile.findOneAndUpdate(
      { studentId: context.rider._id, organizationId: context.organization._id },
      {
        $set: {
          schemaVersion: config.schemaVersion,
          values: legacy ? (context.organizationProfile?.values || {}) : validation.values,
          needsUpdate: false,
          legacyGrandfathered: legacy
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  if (context.existingEnrollment?.status === 'ACTIVE') {
    return { error: { status: 409, message: `${context.rider.fullName} is already enrolled with ${context.driver.name}`, data: enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle) } };
  }
  if (context.existingEnrollment?.status === 'PENDING') {
    return {
      success: true,
      status: 200,
      message: `${context.rider.fullName}'s request is waiting for approval`,
      data: enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle)
    };
  }

  const requiredApproval = Boolean(context.driver.isPrivate);
  const status = requiredApproval ? 'PENDING' : 'ACTIVE';
  const enrollment = await DriverEnrollment.findOneAndUpdate(
    { studentId: context.rider._id, driverId: context.driver._id },
    {
      $set: {
        userId: null,
        studentId: context.rider._id,
        driverId: context.driver._id,
        managerId: context.driver.managerId || null,
        status,
        requiredApproval,
        organizationProfileId: organizationProfile?._id || null,
        pickupPlaceId,
        dropoffPlaceId,
        decidedBy: null,
        decidedAt: null
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return {
    success: true,
    status: 201,
    message: requiredApproval
      ? `${context.rider.fullName}'s request was sent for approval.`
      : `${context.rider.fullName} is now enrolled with ${context.driver.name}`,
    data: enrollmentSummary(enrollment, context.driver, context.organization, context.vehicle)
  };
}

exports.enrollStudent = async (req, res, next) => {
  try {
    const result = await createEnrollment(req);
    if (result.error) return res.status(result.error.status).json({ success: false, ...result.error });
    return res.status(result.status).json({ success: true, message: result.message, data: result.data });
  } catch (error) { next(error); }
};

// Rider-neutral endpoint used by current clients. The legacy function remains
// exported because older app versions still call /students/:studentId.
exports.enrollRider = exports.enrollStudent;

// Temporary compatibility endpoint for an app build released before the
// student wizard. It enrolls the account's first migrated student without
// enforcing newly-configured organization fields.

// Compatibility for an app build released before the rider wizard: enrolls
// without enforcing newly-configured organization fields. Named ...Legacy so
// it no longer shadows the key-redemption handler above.
exports.redeemEnrollmentKeyLegacy = async (req, res, next) => {
  try {
    const result = await createEnrollment(req, { legacy: true });
    if (result.error) return res.status(result.error.status).json({ success: false, ...result.error });
    return res.status(result.status).json({ success: true, message: result.message, data: result.data });
  } catch (error) { next(error); }
};

