const { body, param, query } = require('express-validator');
const { looksLikeDriverCode } = require('../utils/driverCode');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Route Validation Rules
exports.validateCreateRoute = [
  body('routeId')
    .trim()
    .notEmpty().withMessage('Route ID is required')
    .matches(/^[A-Z0-9\-_]+$/).withMessage('Route ID must contain only alphanumeric characters, hyphens, and underscores'),
  body('routeName')
    .trim()
    .notEmpty().withMessage('Route name is required')
    .isLength({ min: 3, max: 100 }).withMessage('Route name must be between 3 and 100 characters'),
  body('source')
    .trim()
    .notEmpty().withMessage('Source is required')
    .isLength({ min: 2 }).withMessage('Source must be at least 2 characters'),
  body('destination')
    .trim()
    .notEmpty().withMessage('Destination is required')
    .isLength({ min: 2 }).withMessage('Destination must be at least 2 characters'),
  body('distance')
    .isFloat({ min: 0.1 }).withMessage('Distance must be a positive number'),
  body('estimatedTime')
    .optional()
    .isInt({ min: 0 }).withMessage('Estimated time must be a non-negative integer (in minutes)'),
  body('fare')
    .isFloat({ min: 0.1 }).withMessage('Fare must be a positive number'),
  body('serviceType')
    .optional()
    .isIn(SERVICE_TYPES).withMessage('Invalid service type'),
  body('stopsCount')
    .optional()
    .isInt({ min: 0 }).withMessage('Stops count must be a non-negative integer'),
  body('stops')
    .optional()
    .isArray().withMessage('Stops must be an array')
    .custom((stops) => {
      if (!Array.isArray(stops)) return true;
      const isValid = stops.every((stop) => {
        if (!stop || typeof stop !== 'object') return false;
        const hasName = typeof stop.stopName === 'string' && stop.stopName.trim().length > 0;
        const lat = Number(stop.lat);
        const lng = Number(stop.lng);
        return hasName && Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;
      });
      if (!isValid) {
        throw new Error('Each stop must include stopName, lat, and lng with valid coordinates');
      }
      return true;
    })
];

exports.validateUpdateRoute = [
  body('routeName')
    .optional()
    .trim()
    .isLength({ min: 3, max: 100 }).withMessage('Route name must be between 3 and 100 characters'),
  body('source')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('Source must be at least 2 characters'),
  body('destination')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('Destination must be at least 2 characters'),
  body('distance')
    .optional()
    .isFloat({ min: 0.1 }).withMessage('Distance must be a positive number'),
  body('estimatedTime')
    .optional()
    .isInt({ min: 0 }).withMessage('Estimated time must be a non-negative integer (in minutes)'),
  body('fare')
    .optional()
    .isFloat({ min: 0.1 }).withMessage('Fare must be a positive number'),
  body('serviceType')
    .optional()
    .isIn(SERVICE_TYPES).withMessage('Invalid service type'),
  body('stops')
    .optional()
    .isArray().withMessage('Stops must be an array')
    .custom((stops) => {
      if (!Array.isArray(stops)) return true;
      const isValid = stops.every((stop) => {
        if (!stop || typeof stop !== 'object') return false;
        const hasName = typeof stop.stopName === 'string' && stop.stopName.trim().length > 0;
        const lat = Number(stop.lat);
        const lng = Number(stop.lng);
        return hasName && Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;
      });
      if (!isValid) {
        throw new Error('Each stop must include stopName, lat, and lng with valid coordinates');
      }
      return true;
    }),
  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be a boolean')
];

exports.validateRouteId = [
  param('routeId')
    .trim()
    .notEmpty().withMessage('Route ID is required')
];

// Vehicle Validation Rules
exports.validateCreateVehicle = [
  body('vehicleId')
    .trim()
    .notEmpty().withMessage('Vehicle ID is required')
    .matches(/^[A-Z0-9\-_]+$/).withMessage('Vehicle ID must contain only alphanumeric characters, hyphens, and underscores'),
  body('vehicleName')
    .trim()
    .notEmpty().withMessage('Vehicle name is required')
    .isLength({ min: 2, max: 50 }).withMessage('Vehicle name must be between 2 and 50 characters'),
  body('registrationNumber')
    .trim()
    .notEmpty().withMessage('Registration number is required')
    .matches(/^[A-Z0-9\-]+$/).withMessage('Invalid registration number format'),
  body('routeId')
    .trim()
    .notEmpty().withMessage('Route ID is required'),
  // Optional since drivers are no longer asked for a seat count when they
  // register a vehicle. The bounds still apply to anything that does send one
  // (seat-map bookings read it — see bookingController.getAvailableSeats).
  body('seatCapacity')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Seat capacity must be between 1 and 100'),
  body('vehicleType')
    .optional()
    .isIn(['AC', 'NON-AC', 'DELUXE', 'SLEEPER']).withMessage('Invalid vehicle type'),
  body('serviceType')
    .optional()
    .isIn(SERVICE_TYPES).withMessage('Invalid service type'),
  body('bookingEnabled')
    .optional()
    .isBoolean().withMessage('bookingEnabled must be a boolean'),
  body('registrationExpiry')
    .optional()
    .isISO8601().withMessage('Invalid date format'),
  body('insuranceExpiry')
    .optional()
    .isISO8601().withMessage('Invalid date format'),
  body('nextServiceDate')
    .optional()
    .isISO8601().withMessage('Invalid date format')
];

exports.validateUpdateVehicle = [
  body('vehicleName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 }).withMessage('Vehicle name must be between 2 and 50 characters'),
  body('seatCapacity')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Seat capacity must be between 1 and 100'),
  body('vehicleType')
    .optional()
    .isIn(['AC', 'NON-AC', 'DELUXE', 'SLEEPER']).withMessage('Invalid vehicle type'),
  body('serviceType')
    .optional()
    .isIn(SERVICE_TYPES).withMessage('Invalid service type'),
  body('bookingEnabled')
    .optional()
    .isBoolean().withMessage('bookingEnabled must be a boolean'),
  body('maintenanceStatus')
    .optional()
    .isIn(['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE']).withMessage('Invalid maintenance status'),
  body('registrationExpiry')
    .optional()
    .isISO8601().withMessage('Invalid date format'),
  body('insuranceExpiry')
    .optional()
    .isISO8601().withMessage('Invalid date format'),
  body('nextServiceDate')
    .optional()
    .isISO8601().withMessage('Invalid date format')
];

exports.validateVehicleId = [
  param('vehicleId')
    .trim()
    .notEmpty().withMessage('Vehicle ID is required')
];

// Auth Validation Rules
exports.validateRegister = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 }).withMessage('Name must be between 2 and 50 characters'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character')
];

// Sign-in accepts an email or a driver code (drivers may have no email), sent as
// either `identifier` or the original `email` field. The shape check happens
// here; which account it belongs to is the controller's business.
exports.validateLogin = [
  body(['identifier', 'email'])
    .custom((_value, { req }) => {
      const raw = String(req.body?.identifier ?? req.body?.email ?? '').trim();
      if (!raw) throw new Error('Email or driver ID is required');
      if (looksLikeDriverCode(raw)) return true;
      if (!EMAIL_REGEX.test(raw)) throw new Error('Enter a valid email address or driver ID');
      return true;
    }),
  body('password')
    .notEmpty().withMessage('Password is required'),
  // Which app is signing in, so login resolves the right role profile for a person who
  // holds several (a rider who also drives). Optional while the apps are still being
  // released; absent means "use the legacy first-match precedence".
  body('audience')
    .optional()
    .trim()
    .toLowerCase()
    .isIn(['user', 'rider', 'driver', 'admin', 'web-admin', 'manager', 'super-admin'])
    .withMessage('Invalid audience')
];

exports.validateVerifyEmail = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .matches(/^\d{6}$/).withMessage('OTP must be a 6-digit code')
];

exports.validateGoogleSignIn = [
  body('idToken')
    .trim()
    .notEmpty().withMessage('Google idToken is required')
];

exports.validateRefreshToken = [
  body('refreshToken')
    .trim()
    .notEmpty().withMessage('refreshToken is required')
];

exports.validateForgotPasswordRequest = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format')
];

exports.validateForgotPasswordVerifyOtp = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .matches(/^\d{6}$/).withMessage('OTP must be a 6-digit code')
];

exports.validateForgotPasswordReset = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('resetToken')
    .trim()
    .notEmpty().withMessage('resetToken is required'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character')
];

const MANAGER_SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const ORG_SERVICE_TYPES = ['SCHOOL', 'UNIVERSITY', 'OFFICE'];

exports.validateCreateManager = [
  body('name')
    .trim()
    .notEmpty().withMessage('Manager name is required')
    .isLength({ min: 2, max: 80 }).withMessage('Manager name must be between 2 and 80 characters'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  // The super admin sets the manager's password directly at creation time.
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character'),
  body('serviceType')
    .optional()
    .isIn(MANAGER_SERVICE_TYPES).withMessage('Invalid service type'),
  body('organizationId')
    .optional({ nullable: true })
    .isMongoId().withMessage('Invalid organization id')
];

exports.validateUpdateManager = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 }).withMessage('Manager name must be between 2 and 80 characters'),
  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Invalid email format'),
  body('serviceType')
    .optional()
    .isIn(MANAGER_SERVICE_TYPES).withMessage('Invalid service type'),
  body('organizationId')
    .optional({ nullable: true })
    .isMongoId().withMessage('Invalid organization id')
];

exports.validateCreateOrganization = [
  body('name')
    .trim()
    .notEmpty().withMessage('Organization name is required')
    .isLength({ min: 2, max: 120 }).withMessage('Organization name must be between 2 and 120 characters'),
  body('serviceType')
    .notEmpty().withMessage('Service type is required')
    .isIn(ORG_SERVICE_TYPES).withMessage('Organizations only exist for school, university, or office services')
];

exports.validateManagerId = [
  param('managerId')
    .isMongoId().withMessage('Invalid manager id')
];

exports.validateManagerStatus = [
  body('isActive')
    .isBoolean().withMessage('isActive must be boolean')
];

// The super admin sets a manager's password directly, with no emailed link.
exports.validateManagerPasswordReset = [
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character')
];

// Public invite/reset link endpoints (manager sets their own password).
exports.validateAccountSetupValidate = [
  body('token')
    .trim()
    .notEmpty().withMessage('Token is required')
];

exports.validateAccountSetupComplete = [
  body('token')
    .trim()
    .notEmpty().withMessage('Token is required'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
];

exports.validateAssignVehicles = [
  body('vehicleIds')
    .isArray({ min: 1 }).withMessage('vehicleIds must be a non-empty array'),
  body('vehicleIds.*')
    .isMongoId().withMessage('Each vehicleId must be a valid Mongo ID')
];

exports.validateCreateVehicleReview = [
  body('vehicleId')
    .isMongoId().withMessage('Valid vehicleId is required'),
  body('rating')
    .isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('title')
    .optional()
    .trim()
    .isLength({ max: 120 }).withMessage('Title cannot exceed 120 characters'),
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 1200 }).withMessage('Comment cannot exceed 1200 characters')
];

exports.validateUpdateVehicleReview = [
  body('rating')
    .optional()
    .isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('title')
    .optional()
    .trim()
    .isLength({ max: 120 }).withMessage('Title cannot exceed 120 characters'),
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 1200 }).withMessage('Comment cannot exceed 1200 characters')
];

exports.validateReviewId = [
  param('reviewId')
    .isMongoId().withMessage('Invalid review id')
];

exports.validateVehicleObjectId = [
  param('vehicleId')
    .isMongoId().withMessage('Invalid vehicle id')
];

exports.validateVehicleRequestId = [
  param('requestId')
    .isMongoId().withMessage('Invalid request id')
];

exports.validateManagerIdQuery = [
  query('managerId')
    .optional()
    .isMongoId().withMessage('Invalid manager id')
];

// Rider profiles (docs/modules/PROFILES.md). Phone number is validated in
// profileController itself via utils/phoneNumber.js — every other manager/
// driver phone check in this codebase lives in its controller the same way,
// not here.
exports.validateProfileId = [
  param('id')
    .isMongoId().withMessage('Invalid profile id')
];

exports.validateCreateProfile = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 50 }).withMessage('Name must be between 2 and 50 characters'),
  body('relation')
    .optional()
    .trim()
    .isLength({ max: 30 }).withMessage('Relation cannot exceed 30 characters'),
  body('avatarUrl')
    .optional()
    .isString().withMessage('avatarUrl must be a string')
];

exports.validateUpdateProfile = [
  param('id')
    .isMongoId().withMessage('Invalid profile id'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 }).withMessage('Name must be between 2 and 50 characters'),
  body('relation')
    .optional()
    .trim()
    .isLength({ max: 30 }).withMessage('Relation cannot exceed 30 characters'),
  body('avatarUrl')
    .optional()
    .isString().withMessage('avatarUrl must be a string')
];
