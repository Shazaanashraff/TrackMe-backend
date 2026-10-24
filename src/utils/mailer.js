const { Resend } = require('resend');

// Single outbound-email path for every transactional message (verification OTP,
// password-reset OTP, manager invite/reset links).
//
// Resend is the primary provider. SMTP (nodemailer) is a fallback that is used when
// Resend is not configured OR when Resend rejects/throws — e.g. the sender domain is
// not verified yet, so Resend only delivers to the account owner. Callers keep their
// existing contract: the returned promise resolves to true when something was
// delivered to a provider, false otherwise, and never rejects.

const isResendConfigured = () => Boolean(process.env.RESEND_API_KEY);

const isSmtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const isEmailConfigured = () => isResendConfigured() || isSmtpConfigured();

const sendViaResend = async ({ to, subject, html }, label) => {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';

  const { data, error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    console.error(`[Resend] ${label} error:`, JSON.stringify(error));
    return false;
  }
  console.log(`[Resend] ${label} sent, id:`, data?.id);
  return true;
};

const sendViaSmtp = async ({ to, subject, html }, label) => {
  // Required lazily so a deploy that never configures SMTP never loads it.
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587/25 upgrade with STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const info = await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html
  });
  console.log(`[SMTP] ${label} sent, id:`, info?.messageId);
  return true;
};

const sendMail = async (message, label = 'sendMail') => {
  if (isResendConfigured()) {
    try {
      if (await sendViaResend(message, label)) return true;
    } catch (err) {
      console.error(`[Resend] ${label} threw:`, err?.message || err);
    }
  }

  if (isSmtpConfigured()) {
    try {
      return await sendViaSmtp(message, label);
    } catch (err) {
      console.error(`[SMTP] ${label} failed:`, err?.message || err);
    }
  }

  return false;
};

module.exports = { sendMail, isEmailConfigured, isResendConfigured, isSmtpConfigured };
