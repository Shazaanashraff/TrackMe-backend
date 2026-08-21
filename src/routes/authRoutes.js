const express = require('express');
const router = express.Router();
const {
	register,
	login,
	verifyEmail,
	resendVerificationOtp,
	googleSignIn,
	refreshAccessToken,
	logout,
	requestPasswordResetOtp,
	verifyPasswordResetOtp,
	resetPasswordWithToken,
	validateAccountSetup,
	completeAccountSetup,
	getMe,
	updateProfile,
	updateAvatar,
	changePassword
} = require('../controllers/authController');
const {
	validateRegister,
	validateLogin,
	validateVerifyEmail,
	validateGoogleSignIn,
	validateRefreshToken,
	validateForgotPasswordRequest,
	validateForgotPasswordVerifyOtp,
	validateForgotPasswordReset,
	validateAccountSetupValidate,
	validateAccountSetupComplete,
	validateChangePassword
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect } = require('../middleware/auth');
const { createEmailRateLimiter } = require('../middleware/emailRateLimiter');

const RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_EMAIL_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.AUTH_EMAIL_RATE_LIMIT_MAX) || 3;

const resendVerificationRateLimit = createEmailRateLimiter({
	windowMs: RATE_LIMIT_WINDOW_MS,
	max: RATE_LIMIT_MAX,
	message: 'Too many verification code requests for this email. Please wait before trying again.'
});
const passwordResetRequestRateLimit = createEmailRateLimiter({
	windowMs: RATE_LIMIT_WINDOW_MS,
	max: RATE_LIMIT_MAX,
	message: 'Too many password reset requests for this email. Please wait before trying again.'
});

// Login has no OTP-style attempt lockout of its own, so an unbounded number of
// password guesses were possible against any single account. Keyed the same
// way login itself resolves its caller, so an email and a driver code don't
// share a bucket. A wider window and higher ceiling than the OTP limiters
// above — legitimate users retry a mistyped password more than they retry an
// OTP request — but still throttles a realistic brute-force attempt.
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX) || 10;
const loginRateLimit = createEmailRateLimiter({
	windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
	max: LOGIN_RATE_LIMIT_MAX,
	message: 'Too many login attempts for this account. Please wait before trying again.',
	keyExtractor: (req) => String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase()
});

// POST /api/auth/register
router.post('/register', validateRegister, handleValidationErrors, register);

// POST /api/auth/verify-email
router.post('/verify-email', validateVerifyEmail, handleValidationErrors, verifyEmail);

// POST /api/auth/resend-verification-otp
router.post('/resend-verification-otp', resendVerificationRateLimit, resendVerificationOtp);

// POST /api/auth/login
router.post('/login', validateLogin, handleValidationErrors, loginRateLimit, login);

// POST /api/auth/google
router.post('/google', validateGoogleSignIn, handleValidationErrors, googleSignIn);

// POST /api/auth/refresh-token
router.post('/refresh-token', validateRefreshToken, handleValidationErrors, refreshAccessToken);

// POST /api/auth/forgot-password/request-otp
router.post('/forgot-password/request-otp', validateForgotPasswordRequest, handleValidationErrors, passwordResetRequestRateLimit, requestPasswordResetOtp);

// POST /api/auth/forgot-password/verify-otp
router.post('/forgot-password/verify-otp', validateForgotPasswordVerifyOtp, handleValidationErrors, verifyPasswordResetOtp);

// POST /api/auth/forgot-password/reset
router.post('/forgot-password/reset', validateForgotPasswordReset, handleValidationErrors, resetPasswordWithToken);

// POST /api/auth/account-setup/validate  (public — invite/reset link lookup)
router.post('/account-setup/validate', validateAccountSetupValidate, handleValidationErrors, validateAccountSetup);

// POST /api/auth/account-setup/complete  (public — manager sets their own password)
router.post('/account-setup/complete', validateAccountSetupComplete, handleValidationErrors, completeAccountSetup);

// POST /api/auth/logout
router.post('/logout', protect, logout);

// GET /api/auth/me
router.get('/me', protect, getMe);

// PUT /api/auth/profile
router.put('/profile', protect, updateProfile);

// PUT /api/auth/avatar — body carries a base64 image data URL; the app-wide JSON
// limit (3 MB, set in server.js) covers it. Size is re-checked in the controller.
router.put('/avatar', protect, updateAvatar);

// PUT /api/auth/change-password — self-service, requires the current password.
router.put('/change-password', protect, validateChangePassword, handleValidationErrors, changePassword);

module.exports = router;
