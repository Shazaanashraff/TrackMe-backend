const { validationResult } = require('express-validator');

// Middleware to handle validation errors
exports.handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.param,
      message: error.msg
    }));
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errorMessages
    });
  }
  next();
};

// Custom error handler middleware
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

exports.ApiError = ApiError;

exports.errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Handle Mongoose validation errors
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => ({
      field: e.path,
      message: e.message
    }));
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors
    });
  }

  // Handle Mongoose duplicate key errors
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      message: `${field} already exists`
    });
  }

  // Handle Mongoose CastError (e.g. a malformed ObjectId in a route/query param) —
  // without this branch it falls through to the generic 500 below, which leaks the
  // raw invalid value in err.message.
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: `Invalid ${err.path}`
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired'
    });
  }

  // Unrecognized errors default to 500, and their message is whatever the
  // underlying driver/runtime produced (Mongo connection errors, raw TypeErrors,
  // etc.) — never echo that to the client in production. Deliberate ApiErrors
  // (statusCode < 500) carry an intentional, safe-to-show message and are unaffected.
  const isUnhandledInternalError = statusCode >= 500;
  const safeMessage =
    isUnhandledInternalError && process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : message;

  res.status(statusCode).json({
    success: false,
    message: safeMessage
  });
};
