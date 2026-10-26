const { sendMail } = require('./mailer');

// The emails around "change password" and "delete account", plus the notice a
// manager gets when one of their riders leaves or comes back because of it.
// Same plain layout as the verification and reset emails (authController.js,
// passwordReset.js). Every send resolves to a boolean and never throws
// (mailer.js), so a mail outage never fails the action that triggered it.

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Riders are in Sri Lanka, so dates read in Colombo time.
const formatWhen = (date) => new Date(date).toLocaleString('en-GB', {
  timeZone: 'Asia/Colombo',
  dateStyle: 'long',
  timeStyle: 'short'
});

const layout = (body, footer) => `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 500px; margin: 0 auto; padding: 20px; }
      .code-box { background: #f5f5f5; padding: 15px; border-left: 3px solid #333; margin: 20px 0; }
      .code { font-size: 24px; font-weight: bold; letter-spacing: 2px; font-family: monospace; }
      .footer { color: #666; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; }
    </style>
  </head>
  <body>
    <div class="container">
      ${body}
      <div class="footer">
        ${footer ? `<p>${footer}</p>` : ''}
        <p>Pingo © 2026</p>
      </div>
    </div>
  </body>
  </html>
`;

const NOT_YOU = 'If this was not you, reset your password from the sign-in screen straight away.';

const CODE_COPY = {
  CHANGE_PASSWORD: {
    subject: 'Your code to change your Pingo password',
    intro: 'You asked to change your Pingo password.',
    use: 'Enter this code in the app to choose a new password (valid for 5 minutes):'
  },
  DELETE_ACCOUNT: {
    subject: 'Your code to delete your Pingo account',
    intro: 'You asked to delete your Pingo account.',
    use: 'Enter this code in the app to confirm (valid for 5 minutes):'
  }
};

const sendAccountCodeEmail = (to, code, purpose) => {
  const copy = CODE_COPY[purpose];
  return sendMail({
    to,
    subject: copy.subject,
    html: layout(`
      <p>${copy.intro}</p>
      <p>${copy.use}</p>
      <div class="code-box"><div class="code">${escapeHtml(code)}</div></div>
    `, 'Did not ask for this? You can ignore this email. Nothing changes without the code.')
  }, 'sendAccountCodeEmail');
};

const sendPasswordChangedEmail = (to) => sendMail({
  to,
  subject: 'Your Pingo password was changed',
  html: layout(`
    <p>Your Pingo password was just changed.</p>
    <p>You stay signed in on the phone you used. Every other device was signed out.</p>
  `, NOT_YOU)
}, 'sendPasswordChangedEmail');

const sendDeletionScheduledEmail = (to, purgeAt) => sendMail({
  to,
  subject: 'Your Pingo account will be deleted',
  html: layout(`
    <p>Your Pingo account is scheduled for deletion on <strong>${escapeHtml(formatWhen(purgeAt))}</strong> (Sri Lanka time).</p>
    <p>You were taken off your shuttles and signed out everywhere.</p>
    <p>Changed your mind? Sign in to the app before that time and choose <strong>Keep my account</strong>. Your shuttles come back as they were.</p>
  `, NOT_YOU)
}, 'sendDeletionScheduledEmail');

const sendDeletionCancelledEmail = (to) => sendMail({
  to,
  subject: 'Your Pingo account was kept',
  html: layout(`
    <p>You chose to keep your Pingo account, so it will not be deleted.</p>
    <p>Your shuttles were put back as they were.</p>
  `, NOT_YOU)
}, 'sendDeletionCancelledEmail');

const sendAccountDeletedEmail = (to) => sendMail({
  to,
  subject: 'Your Pingo account was deleted',
  html: layout(`
    <p>Your Pingo account and its rider profiles, places, messages and reviews have been deleted.</p>
    <p>Past boarding records stay with the shuttle operator without your name or location.</p>
    <p>You can create a new account with this email at any time.</p>
  `)
}, 'sendAccountDeletedEmail');

// `kind` is 'DELETED' or 'RESTORED'.
const sendManagerRiderNoticeEmail = (to, { managerName, text, kind }) => sendMail({
  to,
  subject: kind === 'RESTORED' ? 'A rider is back on your shuttle' : 'A rider left your shuttle',
  html: layout(`
    <p>Hi ${escapeHtml(managerName || 'there')},</p>
    <p>${escapeHtml(text)}</p>
    <p>You can see this in the notifications bell of the Pingo manager portal.</p>
  `)
}, 'sendManagerRiderNoticeEmail');

module.exports = {
  formatWhen,
  sendAccountCodeEmail,
  sendPasswordChangedEmail,
  sendDeletionScheduledEmail,
  sendDeletionCancelledEmail,
  sendAccountDeletedEmail,
  sendManagerRiderNoticeEmail
};
