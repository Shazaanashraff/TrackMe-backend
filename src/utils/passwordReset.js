const crypto = require('crypto');
const { Resend } = require('resend');

// Password-reset OTP delivery, shared by the self-service flow
// (POST /api/auth/forgot-password/request-otp) and the two admin "reset this
// person's password" endpoints.
//
// The admin endpoints need it because an admin may only *set* a password while the
// identity is still provisional — i.e. admin-created and never used by its owner.
// Once the person has signed in or chosen their own password, the login is theirs,
// and the only safe thing an admin can do is send them a reset code. Overwriting it
// would let a manager take over an email that may also hold that person's rider
// account. See docs/modules/AUTH.md.

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

// Stamp a fresh reset OTP on the identity and mail it. Returns the OTP so callers can
// echo it in non-production when email delivery is unavailable.
const issueResetOtpForIdentity = async (identity) => {
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
    emailSent = await sendPasswordResetOtpEmail(identity.email, otp);
  } catch (mailError) {
    emailSent = false;
  }

  return { otp, emailSent };
};

// An admin may set a password outright only while nobody has used this login yet.
const canAdminSetPassword = (identity) => Boolean(identity?.isProvisional);

// Shared by the manager "reset bus account password" and super-admin "reset manager
// password" endpoints so the rule can never drift between them.
//
// Provisional  -> write the password the admin chose.
// Otherwise    -> refuse to write, mail the owner a reset code instead.
const adminSetOrMailReset = async (identity, password) => {
  if (canAdminSetPassword(identity)) {
    identity.password = password;
    await identity.save();
    return { written: true, emailSent: false, otp: null };
  }

  const { otp, emailSent } = await issueResetOtpForIdentity(identity);
  return { written: false, emailSent, otp };
};

module.exports = {
  sendPasswordResetOtpEmail,
  issueResetOtpForIdentity,
  canAdminSetPassword,
  adminSetOrMailReset
};
