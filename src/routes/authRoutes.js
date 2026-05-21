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
	updateProfile
} = require('../controllers/authController');
const {
	validateRegister,
	validateLogin,
	validateVerifyEmail,
	validateGoogleSignIn,
	validateRefreshToken,
	validateForgotPasswordRequest,
	validateForgotPasswordVerifyOtp,
	validateForgotPasswordReset
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', validateRegister, handleValidationErrors, register);

// POST /api/auth/verify-email
router.post('/verify-email', validateVerifyEmail, handleValidationErrors, verifyEmail);

// POST /api/auth/resend-verification-otp
router.post('/resend-verification-otp', resendVerificationOtp);

// POST /api/auth/login
router.post('/login', validateLogin, handleValidationErrors, login);

// POST /api/auth/google
router.post('/google', validateGoogleSignIn, handleValidationErrors, googleSignIn);

// POST /api/auth/refresh-token
router.post('/refresh-token', validateRefreshToken, handleValidationErrors, refreshAccessToken);

// POST /api/auth/forgot-password/request-otp
router.post('/forgot-password/request-otp', validateForgotPasswordRequest, handleValidationErrors, requestPasswordResetOtp);

// POST /api/auth/forgot-password/verify-otp
router.post('/forgot-password/verify-otp', validateForgotPasswordVerifyOtp, handleValidationErrors, verifyPasswordResetOtp);

// POST /api/auth/forgot-password/reset
router.post('/forgot-password/reset', validateForgotPasswordReset, handleValidationErrors, resetPasswordWithToken);

// POST /api/auth/logout
router.post('/logout', protect, logout);

// PUT /api/auth/profile
router.put('/profile', protect, updateProfile);

module.exports = router;
