const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const { OAuth2Client } = require('google-auth-library');
const { findAccountById, modelForRole, ACCOUNTS } = require('../utils/accountRegistry');
const {
  findIdentityByEmail,
  findProfilesForIdentity,
  resolveProfileForAudience,
  hasSuperAdminProfile,
  attachProfile,
  createIdentityWithProfile,
  selectRoleForAudience,
  VALID_AUDIENCES
} = require('../utils/identityRegistry');
const { sendPasswordResetOtpEmail } = require('../utils/passwordReset');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- Identity rollout flags (see docs/modules/AUTH.md) ---
//
// While ALLOW_SHARED_IDENTITY is off, an email may still only hold one role: the
// behaviour is bit-for-bit what it was before the identity model landed. Turn it on
// only after every app has shipped its role gate, otherwise an old rider-app build
// (which sends no `audience`) could be handed a driver session for someone who is
// both — the legacy fallback prefers the higher-privilege role.
const ALLOW_SHARED_IDENTITY = process.env.ALLOW_SHARED_IDENTITY === 'true';
// Once every client sends an `audience`, flip this to stop honouring the legacy
// first-match fallback at all.
const AUTH_REQUIRE_AUDIENCE = process.env.AUTH_REQUIRE_AUDIENCE === 'true';

// Which app is asking. Absent (old build) ⇒ null ⇒ legacy first-match precedence.
const readAudience = (req) => {
  const raw = String(req.body?.audience || '').trim().toLowerCase();
  if (!raw) return null;
  return VALID_AUDIENCES.includes(raw) ? raw : undefined; // undefined = invalid
};

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

const issueTokensForUser = async (user, role) => {
  const accessToken = jwt.sign({ id: user._id, role, tokenType: 'access' }, process.env.JWT_SECRET, {
    expiresIn: accessTokenExpiresIn
  });

  const refreshToken = jwt.sign({ id: user._id, role, tokenType: 'refresh' }, process.env.JWT_SECRET, {
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

// `identity` is optional so the two profile-only flows (refresh, logout) can keep
// calling this without a second lookup. When present it is the source of truth for
// `isEmailVerified`, which now belongs to the person rather than to one of their roles.
const userPayload = (user, role, identity = null) => ({
  _id: user._id,
  name: user.name,
  email: identity?.email || user.email,
  phoneNumber: user.phoneNumber,
  avatarUrl: user.avatarUrl || '',
  role,
  isEmailVerified: identity ? identity.isEmailVerified : user.isEmailVerified
});

// Email verification is only enforced for riders. Every other role is created by an
// admin (a manager provisioning a driver, a super-admin adding a manager), which
// vouches for the address. Enforcing it for them would also mean that attaching a
// driver profile to an unverified rider identity had to silently mark that rider
// verified — which would be a real hole.
const requiresEmailVerification = (role) => role === 'user';

// Clear the refresh token on EVERY profile this person holds. Used when the password
// changes: the password is now identity-wide, so leaving another app's session alive
// after a reset would defeat the point of the reset.
const revokeAllSessions = async (identityId) => {
  await Promise.all(
    ACCOUNTS.map(({ model }) =>
      model.updateMany(
        { identityId },
        { $set: { 'refreshToken.tokenHash': null, 'refreshToken.expiresAt': null } }
      )
    )
  );
};

const PHONE_NUMBER_REGEX = /^[0-9+()\-\s]{7,20}$/;

// Profile pictures are stored inline as base64 data URLs. Cap the decoded size so a
// single document can't bloat the collection; ~2 MB of image is plenty for an avatar.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_DATA_URL_REGEX = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Returns the decoded byte length of a base64 string without allocating a Buffer copy.
const base64ByteLength = (b64) => {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (len * 3) / 4 - padding;
};

// @desc    Register new user
// @route   POST /api/auth/register
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();

    const derivedName = (name && name.trim()) || normalizedEmail.split('@')[0];
    const existingIdentity = await findIdentityByEmail(normalizedEmail, { select: '+password' });

    if (existingIdentity) {
      const passwordMatches = await existingIdentity.comparePassword(password);
      const profiles = await findProfilesForIdentity(existingIdentity._id);
      const roles = profiles.map((p) => p.role);
      const riderProfile = profiles.find((p) => p.role === 'user');

      // A super-admin login never takes on another role, and never advertises that it
      // exists by offering a sign-in shortcut.
      if (roles.includes('super-admin')) {
        return res.status(409).json({
          success: false,
          code: 'EMAIL_IN_USE',
          canSignIn: false,
          message: 'Email already registered'
        });
      }

      // Already a rider — nothing to create. Offer the shortcut only when they proved
      // they know the password, so this never confirms a password to a stranger.
      if (riderProfile) {
        return res.status(409).json({
          success: false,
          code: 'EMAIL_IN_USE',
          canSignIn: passwordMatches,
          message: passwordMatches ? 'Account already registered' : 'Email already registered'
        });
      }

      // This person exists (as a driver or a manager) but has no rider profile. With
      // the correct password they have proved the login is theirs, so give them the
      // passenger side of the app — this is the "I drive, and I also want to ride" path.
      if (passwordMatches && ALLOW_SHARED_IDENTITY) {
        const { doc: newRider } = await attachProfile({
          identityId: existingIdentity._id,
          role: 'user',
          fields: { name: derivedName }
        });

        const tokens = await issueTokensForUser(newRider, 'user');
        return res.status(200).json({
          success: true,
          message: 'Passenger access added to your existing TrackMe account',
          attachedToExistingIdentity: true,
          ...tokens,
          user: userPayload(newRider, 'user', existingIdentity)
        });
      }

      return res.status(409).json({
        success: false,
        code: 'EMAIL_IN_USE',
        canSignIn: false,
        message: 'Email already registered'
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = hashToken(otp);

    const { identity, doc: user } = await createIdentityWithProfile({
      email: normalizedEmail,
      password,
      isEmailVerified: false,
      role: 'user',
      fields: { name: derivedName }
    });

    identity.emailVerification = {
      otpHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };
    await identity.save();

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
      user: userPayload(user, 'user', identity)
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

    const identity = await findIdentityByEmail(normalizedEmail, {
      select: '+emailVerification.otpHash +emailVerification.expiresAt'
    });
    if (!identity) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (identity.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    if (!identity.emailVerification?.otpHash || !identity.emailVerification?.expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Verification OTP is not available. Please register again.'
      });
    }

    if (identity.emailVerification.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Please register again.'
      });
    }

    if (hashToken(otp) !== identity.emailVerification.otpHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP code'
      });
    }

    // Verification is a property of the person, so it covers every role they hold.
    identity.isEmailVerified = true;
    identity.emailVerification = { otpHash: null, expiresAt: null };
    await identity.save();

    // Only riders ever reach this endpoint (every other role is admin-provisioned and
    // pre-verified), but resolve by audience anyway rather than assuming.
    const profile = await resolveProfileForAudience(identity._id, readAudience(req) || 'user');
    if (!profile) {
      return res.status(403).json({
        success: false,
        code: 'NO_PROFILE_FOR_APP',
        message: 'This login has no account for this app'
      });
    }

    const tokens = await issueTokensForUser(profile.doc, profile.role);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      ...tokens,
      user: userPayload(profile.doc, profile.role, identity)
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

    const audience = readAudience(req);
    if (audience === undefined) {
      return res.status(400).json({ success: false, message: 'Unknown audience' });
    }
    if (AUTH_REQUIRE_AUDIENCE && !audience) {
      return res.status(400).json({ success: false, message: 'audience is required' });
    }

    const identity = await findIdentityByEmail(normalizedEmail, { select: '+password' });

    if (!identity) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (!identity.password) {
      return res.status(400).json({
        success: false,
        message: 'This account uses Google Sign-In. Please continue with Google.'
      });
    }

    // Password is checked against the Identity — once, for whichever app is asking.
    const isMatch = await identity.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const profile = await resolveProfileForAudience(identity._id, audience);
    if (!profile) {
      // Deliberately distinct from a bad password: this login is valid, it just has no
      // profile for this app ("you have no driver account"). Only reachable after the
      // password check, so it leaks nothing to someone who is guessing.
      return res.status(403).json({
        success: false,
        code: 'NO_PROFILE_FOR_APP',
        message: 'This login has no account for this app'
      });
    }
    const { doc: user, role } = profile;

    // Per-role deactivation: switching off someone's driver profile must leave their
    // rider login working, so this is checked on the profile, not the identity.
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact super admin.'
      });
    }

    if (!identity.isEmailVerified && requiresEmailVerification(role)) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
        requiresVerification: true,
        email: normalizedEmail
      });
    }

    // The person has now used this login themselves, so it stops being an
    // admin-provisioned placeholder and admins can no longer overwrite its password.
    if (identity.isProvisional) {
      identity.isProvisional = false;
      await identity.save();
    }

    const tokens = await issueTokensForUser(user, role);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      ...tokens,
      user: userPayload(user, role, identity)
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

    const audience = readAudience(req);
    if (audience === undefined) {
      return res.status(400).json({ success: false, message: 'Unknown audience' });
    }
    const derivedName = payload.name || email.split('@')[0];

    let identity = await findIdentityByEmail(email);
    let profile;

    if (!identity) {
      // Google gives us a verified address, so the new identity starts verified.
      const created = await createIdentityWithProfile({
        email,
        googleId: payload.sub,
        isEmailVerified: true,
        role: 'user',
        fields: { name: derivedName, googleId: payload.sub }
      });
      identity = created.identity;
      profile = { doc: created.doc, role: created.role };
    } else {
      // Never let Google sign-in reach a super-admin login.
      if (await hasSuperAdminProfile(identity._id)) {
        return res.status(403).json({
          success: false,
          code: 'SUPER_ADMIN_ISOLATED',
          message: 'This email belongs to a super-admin account. Sign in with a password.'
        });
      }

      if (!identity.googleId) identity.googleId = payload.sub;
      if (!identity.isEmailVerified) identity.isEmailVerified = true;
      await identity.save();

      profile = await resolveProfileForAudience(identity._id, audience || 'user');

      // Only the passenger app may create a profile on the fly. A driver or manager
      // profile is always provisioned by an admin, so Google sign-in must not mint one.
      if (!profile) {
        const wantsRider = !audience || selectRoleForAudience(['user'], audience) === 'user';
        if (!wantsRider || !ALLOW_SHARED_IDENTITY) {
          return res.status(403).json({
            success: false,
            code: 'NO_PROFILE_FOR_APP',
            message: 'This login has no account for this app'
          });
        }

        const attached = await attachProfile({
          identityId: identity._id,
          role: 'user',
          fields: { name: derivedName, googleId: payload.sub }
        });
        profile = { doc: attached.doc, role: attached.role };
      }

      if (!profile.doc.name && derivedName) {
        profile.doc.name = derivedName;
        await profile.doc.save();
      }
    }

    if (profile.doc.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact super admin.'
      });
    }

    if (identity.isProvisional) {
      identity.isProvisional = false;
      await identity.save();
    }

    const tokens = await issueTokensForUser(profile.doc, profile.role);

    res.status(200).json({
      success: true,
      message: 'Google sign-in successful',
      ...tokens,
      user: userPayload(profile.doc, profile.role, identity)
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

    const account = await findAccountById(decoded.id, decoded.role, {
      select: '+refreshToken.tokenHash +refreshToken.expiresAt'
    });
    if (!account || !account.doc.refreshToken?.tokenHash) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }
    const { doc: user, role } = account;

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

    const tokens = await issueTokensForUser(user, role);

    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      ...tokens,
      user: userPayload(user, role)
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

    const account = await findAccountById(req.user._id, req.user.role, {
      select: '+refreshToken.tokenHash +refreshToken.expiresAt'
    });
    if (account) {
      account.doc.refreshToken = {
        tokenHash: null,
        expiresAt: null
      };
      await account.doc.save();
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

    const identity = await findIdentityByEmail(normalizedEmail, {
      select: '+passwordReset.otpHash +passwordReset.expiresAt +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt'
    });

    const genericSuccess = {
      success: true,
      message: 'If this email is registered, an OTP has been sent.'
    };

    if (!identity) {
      return res.status(200).json(genericSuccess);
    }

    // The password is identity-wide, so a reset is only pointless if the person has no
    // usable role left at all — one deactivated role must not block it.
    const profiles = await findProfilesForIdentity(identity._id);
    if (!profiles.some((p) => p.doc.isActive !== false)) {
      return res.status(200).json(genericSuccess);
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    identity.passwordReset = {
      otpHash: hashToken(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      resetTokenHash: null,
      resetTokenExpiresAt: null
    };

    await identity.save();

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

    const identity = await findIdentityByEmail(normalizedEmail, {
      select: '+passwordReset.otpHash +passwordReset.expiresAt +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt'
    });

    if (!identity || !identity.passwordReset?.otpHash || !identity.passwordReset?.expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'OTP is invalid or not requested.'
      });
    }

    if (identity.passwordReset.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired. Please request a new one.'
      });
    }

    if (hashToken(otp) !== identity.passwordReset.otpHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP code'
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    identity.passwordReset = {
      otpHash: null,
      expiresAt: null,
      resetTokenHash: hashToken(resetToken),
      resetTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };

    await identity.save();

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

    const identity = await findIdentityByEmail(normalizedEmail, {
      select: '+password +passwordReset.resetTokenHash +passwordReset.resetTokenExpiresAt'
    });

    if (!identity || !identity.passwordReset?.resetTokenHash || !identity.passwordReset?.resetTokenExpiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Password reset session is invalid or expired.'
      });
    }

    if (identity.passwordReset.resetTokenExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Password reset session expired. Please verify OTP again.'
      });
    }

    if (hashToken(String(resetToken)) !== identity.passwordReset.resetTokenHash) {
      return res.status(400).json({
        success: false,
        message: 'Invalid password reset session.'
      });
    }

    identity.password = password;
    identity.passwordReset = {
      otpHash: null,
      expiresAt: null,
      resetTokenHash: null,
      resetTokenExpiresAt: null
    };
    // Choosing their own password makes this login theirs: admins can no longer
    // overwrite it (see the isProvisional gate on the admin reset endpoints).
    identity.isProvisional = false;

    await identity.save();

    // The new password unlocks every role this person holds, so every existing session
    // must die — not just the one whose app happened to run the reset.
    await revokeAllSessions(identity._id);

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

    const model = modelForRole(req.user.role);
    const user = await model.findByIdAndUpdate(
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
      user: userPayload(user, req.user.role)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update (or clear) the user's profile picture
// @route   PUT /api/auth/avatar
// @access  Private
exports.updateAvatar = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { avatar } = req.body;
    const model = modelForRole(req.user.role);

    // An empty string / null clears the current avatar.
    if (avatar === '' || avatar === null || avatar === undefined) {
      const cleared = await model.findByIdAndUpdate(
        userId,
        { avatarUrl: '' },
        { new: true }
      );
      if (!cleared) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.status(200).json({
        success: true,
        message: 'Profile picture removed',
        user: userPayload(cleared, req.user.role)
      });
    }

    if (typeof avatar !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid image format'
      });
    }

    const match = AVATAR_DATA_URL_REGEX.exec(avatar);
    if (!match) {
      return res.status(400).json({
        success: false,
        message: 'Profile picture must be a PNG, JPEG, or WebP image'
      });
    }

    if (base64ByteLength(match[2]) > MAX_AVATAR_BYTES) {
      return res.status(413).json({
        success: false,
        message: 'Profile picture is too large (max 2 MB)'
      });
    }

    const user = await model.findByIdAndUpdate(
      userId,
      { avatarUrl: avatar },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile picture updated',
      user: userPayload(user, req.user.role)
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

    const identity = await findIdentityByEmail(normalizedEmail, {
      select: '+emailVerification.otpHash +emailVerification.expiresAt'
    });

    if (!identity || identity.isEmailVerified) {
      return res.status(200).json({ success: true, message: 'If unverified, a new code has been sent.' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    identity.emailVerification = {
      otpHash: hashToken(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };
    await identity.save();

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
