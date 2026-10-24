// Test-only opt-in for the dev-OTP echo (issue #66) — production deploys must never
// set this, so it lives here rather than in any shipped config.
process.env.ENABLE_DEV_OTP_ECHO = 'true';

// Never send real mail from tests. .env may hold live Resend/SMTP credentials, and
// dotenv will not overwrite a variable that is already defined — even as an empty
// string — so blanking them here keeps them blank when the server loads .env.
process.env.RESEND_API_KEY = '';
process.env.SMTP_HOST = '';
