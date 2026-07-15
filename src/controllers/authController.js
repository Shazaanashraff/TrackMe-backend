const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const accessTokenExpiresIn = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
const refreshTokenExpiresIn = process.env.REFRESH_TOKEN_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '7d';

const toMillis = (expiresIn) => {
  const match = String(expiresIn).trim().match(/^(\d+)([smhd])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;

  return 7 * 24 * 60 * 60 * 1000;
};

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

const sendVerificationEmail = async (to, otp) => {
  if (!process.env.RESEND_API_KEY) return false;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Verify your TrackMe account',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 500px; margin: 0 auto; padding: 20px; }
          .header { margin-bottom: 30px; }
          .code-box { background: #f5f5f5; padding: 15px; border-left: 3px solid #333; margin: 20px 0; }
          .code { font-size: 24px; font-weight: bold; letter-spacing: 2px; font-family: monospace; }
          .footer { color: #666; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p>Welcome to TrackMe! Please verify your email address to finish setting up your account.</p>
          </div>

          <p>Use this code to verify your email (valid for 10 minutes):</p>

          <div class="code-box">
            <div class="code">${otp}</div>
          </div>

          <p><strong>Or copy and paste this code in the verification screen.</strong></p>

          <div class="footer">
            <p>Did not create a TrackMe account? You can safely ignore this email.</p>
            <p>TrackMe © 2026</p>
          </div>
        </div>
      </body>
      </html>
    `
  });

  if (error) {
    console.error('[Resend] sendVerificationEmail error:', JSON.stringify(error));
    return false;
  }

  console.log('[Resend] sendVerificationEmail sent, id:', data?.id);
  return true;
};

const sendPasswordResetOtpEmail = async (to, otp) => {
  if (!process.env.RESEND_API_KEY) return false;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Reset Your Password - TrackMe',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 500px; margin: 0 auto; padding: 20px; }
          .header { margin-bottom: 30px; }
          .code-box { background: #f5f5f5; padding: 15px; border-left: 3px solid #333; margin: 20px 0; }
          .code { font-size: 24px; font-weight: bold; letter-spacing: 2px; font-family: monospace; }
          .footer { color: #666; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p>We received a request to reset your TrackMe password.</p>
          </div>
          
          <p>Use this code to reset your password (valid for 10 minutes):</p>
          
          <div class="code-box">
            <div class="code">${otp}</div>
          </div>
          
          <p><strong>Or copy and paste this code in the password reset form.</strong></p>
          
          <div class="footer">
            <p>Did not request this? You can safely ignore this email.</p>
            <p>TrackMe © 2026</p>
          </div>
        </div>
      </body>
      </html>
    `
  });

  if (error) {
    console.error('[Resend] sendPasswordResetOtpEmail error:', JSON.stringify(error));
    return false;
  }

  console.log('[Resend] sendPasswordResetOtpEmail sent, id:', data?.id);
  return true;
};

const issueTokensForUser = async (user) => {
  const accessToken = jwt.sign({ id: user._id, tokenType: 'access' }, process.env.JWT_SECRET, {
    expiresIn: accessTokenExpiresIn
  });

  const refreshToken = jwt.sign({ id: user._id, tokenType: 'refresh' }, process.env.JWT_SECRET, {
    expiresIn: refreshTokenExpiresIn
  });

  user.refreshToken = {
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + toMillis(refreshTokenExpiresIn))
  };

  await user.save();

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn,
    refreshTokenExpiresIn
  };
};

const userPayload = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  phoneNumber: user.phoneNumber,
  role: user.role,
  isEmailVerified: user.isEmailVerified
});

const PHONE_NUMBER_REGEX = /^[0-9+()\-\s]{7,20}$/;

// @desc    Register new user
// @route   POST /api/auth/register
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    const derivedName = (name && name.trim()) || normalizedEmail.split('@')[0];
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = hashToken(otp);

    const user = await User.create({
      name: derivedName,
      email: normalizedEmail,
      password,
      role: 'user',
      isEmailVerified: false,
      emailVerification: {
        otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      }
    });

    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, otp);
    } catch (mailError) {
      emailSent = false;
    }

    const response = {
      success: true,
      message: emailSent
        ? 'Registration successful. Please verify your email with OTP.'
        : 'Registration successful. Email service unavailable, use development OTP.',
      requiresVerification: true,
      email: normalizedEmail,
      user: userPayload(user)
    };

    if (!emailSent && process.env.NODE_ENV !== 'production') {
      response.developmentOtp = otp;
    }

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
};

// @desc    Verify user email with OTP
// @route   POST /api/auth/verify-email
exports.verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).select('+emailVerification.otpHash +emailVerification.expiresAt');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    if (!user.emailVerification?.otpHash || !user.emailVerification?.expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Verification OTP is not available. Please register again.'
      });
    }

    if (user.emailVerification.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Please register again.'
      });
    }

    if (hashToken(otp) !== user.emailVerification.otpHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP code'
      });
    }

    user.isEmailVerified = true;
    user.emailVerification = { otpHash: null, expiresAt: null };

    const tokens = await issueTokensForUser(user);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      ...tokens,
      user: userPayload(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Login user
// @route   POST /api/auth/login
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact super admin.'
      });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: 'This account uses Google Sign-In. Please continue with Google.'
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const canBypassVerification = ['admin', 'super-admin'].includes(user.role);

    if (!user.isEmailVerified && !canBypassVerification) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
        requiresVerification: true,
        email: normalizedEmail
      });
    }

    const tokens = await issueTokensForUser(user);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      ...tokens,
      user: userPayload(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Sign in with Google idToken
// @route   POST /api/auth/google
exports.googleSignIn = async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        success: false,
        message: 'Google auth is not configured on server'
      });
    }

    const { idToken } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();

    if (!email || !payload?.email_verified) {
      return res.status(401).json({
        success: false,
        message: 'Google account email is not verified'
      });
    }

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: payload.name || email.split('@')[0],
        email,
        googleId: payload.sub,
        role: 'user',
        isEmailVerified: true
      });
    } else {
      if (!user.googleId) {
        user.googleId = payload.sub;
      }
      if (!user.isEmailVerified) {
        user.isEmailVerified = true;
      }
      if (!user.name && payload.name) {
        user.name = payload.name;
      }
      await user.save();
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact super admin.'
      });
    }

    const tokens = await issueTokensForUser(user);

    res.status(200).json({
      success: true,
      message: 'Google sign-in successful',
      ...tokens,
      user: userPayload(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Refresh access token
// @route   POST /api/auth/refresh-token
exports.refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (decoded.tokenType !== 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token type'
      });
    }

    const user = await User.findById(decoded.id).select('+refreshToken.tokenHash +refreshToken.expiresAt');
    if (!user || !user.refreshToken?.tokenHash) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    if (user.refreshToken.expiresAt && user.refreshToken.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired'
      });
    }

    if (hashToken(refreshToken) !== user.refreshToken.tokenHash) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    const tokens = await issueTokensForUser(user);

    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      ...tokens,
      user: userPayload(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Logout user and invalidate refresh token
// @route   POST /api/auth/logout
exports.logout = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const user = await User.findById(req.user._id).select('+refreshToken.tokenHash +refreshToken.expiresAt');
    if (user) {
      user.refreshToken = {
        tokenHash: null,
        expiresAt: null
      };
      await user.save();
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Request forgot-password OTP
// @route   POST /api/auth/forgot-password/request-otp
exports.requestPasswordResetOtp = async (req, res, next) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+passwordReset.otpHash +passwordReset.expiresAt +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt'
    );

    const genericSuccess = {
      success: true,
      message: 'If this email is registered, an OTP has been sent.'
    };

    if (!user || user.isActive === false) {
      return res.status(200).json(genericSuccess);
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    user.passwordReset = {
      otpHash: hashToken(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      resetTokenHash: null,
      resetTokenExpiresAt: null
    };

    await user.save();

    let emailSent = false;
    try {
      emailSent = await sendPasswordResetOtpEmail(normalizedEmail, otp);
    } catch (mailError) {
      emailSent = false;
    }

    const response = {
      success: true,
      message: emailSent
        ? 'If this email is registered, an OTP has been sent.'
        : 'Email service unavailable. Use development OTP in non-production environments.'
    };

    if (!emailSent && process.env.NODE_ENV !== 'production') {
      response.developmentOtp = otp;
    }

    return res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

// @desc    Verify forgot-password OTP
// @route   POST /api/auth/forgot-password/verify-otp
exports.verifyPasswordResetOtp = async (req, res, next) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+passwordReset.otpHash +passwordReset.expiresAt +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt'
    );

    if (!user || !user.passwordReset?.otpHash || !user.passwordReset?.expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'OTP is invalid or not requested.'
      });
    }

    if (user.passwordReset.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Please request a new one.'
      });
    }

    if (hashToken(otp) !== user.passwordReset.otpHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP code'
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordReset = {
      otpHash: null,
      expiresAt: null,
      resetTokenHash: hashToken(resetToken),
      resetTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      resetToken,
      email: normalizedEmail
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset password after OTP verification
// @route   POST /api/auth/forgot-password/reset
exports.resetPasswordWithToken = async (req, res, next) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const { resetToken, password } = req.body;

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+password +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt +refreshToken.tokenHash +refreshToken.expiresAt'
    );

    if (!user || !user.passwordReset?.resetTokenHash || !user.passwordReset?.resetTokenExpiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Password reset session is invalid or expired.'
      });
    }

    if (user.passwordReset.resetTokenExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Password reset session expired. Please verify OTP again.'
      });
    }

    if (hashToken(String(resetToken)) !== user.passwordReset.resetTokenHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid password reset session.'
      });
    }

    user.password = password;
    user.passwordReset = {
      otpHash: null,
      expiresAt: null,
      resetTokenHash: null,
      resetTokenExpiresAt: null
    };
    user.refreshToken = {
      tokenHash: null,
      expiresAt: null
    };

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Password reset successful. Please login with your new password.'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { name, phoneNumber } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    const update = { name: name.trim() };

    if (phoneNumber !== undefined) {
      const trimmedPhone = String(phoneNumber).trim();
      if (trimmedPhone && !PHONE_NUMBER_REGEX.test(trimmedPhone)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid phone number'
        });
      }
      update.phoneNumber = trimmedPhone;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      update,
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: userPayload(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Resend email verification OTP
// @route   POST /api/auth/resend-verification-otp
exports.resendVerificationOtp = async (req, res, next) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+emailVerification.otpHash +emailVerification.expiresAt'
    );

    if (!user || user.isEmailVerified) {
      return res.status(200).json({ success: true, message: 'If unverified, a new code has been sent.' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    user.emailVerification = {
      otpHash: hashToken(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };
    await user.save();

    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, otp);
    } catch (_) {}

    const response = { success: true, message: 'If unverified, a new code has been sent.' };
    if (!emailSent && process.env.NODE_ENV !== 'production') {
      response.developmentOtp = otp;
    }

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
