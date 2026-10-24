const crypto = require('crypto');
const { sendMail, isEmailConfigured: isMailerConfigured } = require('./mailer');

// Invite / password-reset links are long-lived compared to the 10-minute OTPs
// used elsewhere: the super admin sends them out-of-band (email) and a manager
// may not act immediately. Seven days keeps them usable without lingering forever.
const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Same one-way hashing used across auth so a leaked DB row never exposes a usable
// token. We store only the hash; the raw token lives only in the emailed link.
const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const generateSetupToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    rawToken,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_MS)
  };
};

// The activation page lives in the WebAdmin SPA. ADMIN_APP_URL points at it in
// production; locally it defaults to the Vite dev server.
const buildSetupLink = (rawToken) => {
  const base = (process.env.ADMIN_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/activate?token=${rawToken}`;
};

// Whether real outbound email is set up. When true, callers must treat email as
// the only delivery path (no on-screen demo link); when false we're in local demo
// mode and surface the link instead.
// Resend or the SMTP fallback counts — see utils/mailer.js.
const isEmailConfigured = () => isMailerConfigured();

// Sends the invite/reset link. Returns false (never throws) when email isn't
// configured, so callers can fall back to surfacing the link on-screen in dev —
// mirroring how OTP emails degrade in authController.
const sendAccountSetupEmail = async (to, { link, name, purpose } = {}) => {
  if (!isMailerConfigured()) return false;

  const isReset = purpose === 'RESET';
  const subject = isReset
    ? 'Reset your TrackMe manager password'
    : 'Activate your TrackMe manager account';
  const intro = isReset
    ? 'A password reset was requested for your TrackMe manager account.'
    : `You've been added as a manager on TrackMe${name ? `, ${name}` : ''}.`;
  const action = isReset ? 'reset your password' : 'set your password';

  return sendMail({
    to,
    subject,
    html: `
        <p>${intro}</p>
        <p>Use the link below to ${action}. It is valid for 7 days:</p>
        <p><a href="${link}">${isReset ? 'Reset password' : 'Set your password'}</a></p>
        <p>Or paste this URL into your browser:<br>${link}</p>
        <p>If you weren't expecting this, you can safely ignore this email.</p>
      `
  }, 'sendAccountSetupEmail');
};

module.exports = {
  SETUP_TOKEN_TTL_MS,
  hashToken,
  generateSetupToken,
  buildSetupLink,
  isEmailConfigured,
  sendAccountSetupEmail
};
