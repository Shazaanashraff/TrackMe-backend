// Test-only opt-in for the dev-OTP echo (issue #66) — production deploys must never
// set this, so it lives here rather than in any shipped config.
process.env.ENABLE_DEV_OTP_ECHO = 'true';
