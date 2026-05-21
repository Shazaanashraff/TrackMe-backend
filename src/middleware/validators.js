const { body, param, query } = require('express-validator');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

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

// Bus Validation Rules
exports.validateCreateBus = [
  body('busId')
    .trim()
    .notEmpty().withMessage('Bus ID is required')
    .matches(/^[A-Z0-9\-_]+$/).withMessage('Bus ID must contain only alphanumeric characters, hyphens, and underscores'),
  body('busName')
    .trim()
    .notEmpty().withMessage('Bus name is required')
    .isLength({ min: 2, max: 50 }).withMessage('Bus name must be between 2 and 50 characters'),
  body('registrationNumber')
    .trim()
    .notEmpty().withMessage('Registration number is required')
    .matches(/^[A-Z0-9\-]+$/).withMessage('Invalid registration number format'),
  body('routeId')
    .trim()
    .notEmpty().withMessage('Route ID is required'),
  body('seatCapacity')
    .isInt({ min: 1, max: 100 }).withMessage('Seat capacity must be between 1 and 100'),
  body('busType')
    .optional()
    .isIn(['AC', 'NON-AC', 'DELUXE', 'SLEEPER']).withMessage('Invalid bus type'),
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

exports.validateUpdateBus = [
  body('busName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 }).withMessage('Bus name must be between 2 and 50 characters'),
  body('seatCapacity')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Seat capacity must be between 1 and 100'),
  body('busType')
    .optional()
    .isIn(['AC', 'NON-AC', 'DELUXE', 'SLEEPER']).withMessage('Invalid bus type'),
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

exports.validateBusId = [
  param('busId')
    .trim()
    .notEmpty().withMessage('Bus ID is required')
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

exports.validateLogin = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('password')
    .notEmpty().withMessage('Password is required')
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

exports.validateCreateManager = [
  body('name')
    .trim()
    .notEmpty().withMessage('Manager name is required')
    .isLength({ min: 2, max: 80 }).withMessage('Manager name must be between 2 and 80 characters'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
];

exports.validateUpdateManager = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 }).withMessage('Manager name must be between 2 and 80 characters'),
  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Invalid email format')
];

exports.validateManagerId = [
  param('managerId')
    .isMongoId().withMessage('Invalid manager id')
];

exports.validateManagerStatus = [
  body('isActive')
    .isBoolean().withMessage('isActive must be boolean')
];

exports.validateManagerPasswordReset = [
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be between 8 and 64 characters')
];

exports.validateAssignBuses = [
  body('busIds')
    .isArray({ min: 1 }).withMessage('busIds must be a non-empty array'),
  body('busIds.*')
    .isMongoId().withMessage('Each busId must be a valid Mongo ID')
];

exports.validateCreateBusReview = [
  body('busId')
    .isMongoId().withMessage('Valid busId is required'),
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

exports.validateUpdateBusReview = [
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

exports.validateBusObjectId = [
  param('busId')
    .isMongoId().withMessage('Invalid bus id')
];
