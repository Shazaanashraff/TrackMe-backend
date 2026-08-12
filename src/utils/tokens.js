// JWT issuance + the generic token-hashing helper, extracted out of
// authController.js so profileController's switchProfile can issue a token
// pair through the exact same path login does, rather than a second copy of
// this security-sensitive logic that could drift from it.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

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

// Generic — used for refresh tokens, OTP hashes, password-reset tokens, and
// account-setup tokens alike. Never reversed, only compared.
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Issues an access+refresh pair for a profile document and persists the
// refresh token's hash on it. `user` is any of the four account-profile
// documents (User/Driver/Manager/SuperAdmin) — whichever one is signing in,
// or, for a rider, whichever one is being switched to.
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

module.exports = {
  accessTokenExpiresIn,
  refreshTokenExpiresIn,
  toMillis,
  hashToken,
  issueTokensForUser
};
