const crypto = require('crypto');
const { hashToken, safeCompare } = require('./tokens');

// The emailed 6-digit code a signed-in rider confirms "change password" and
// "delete account" with. Same rules as the forgot-password code
// (controllers/authController.js): 5 minutes, and the code is wiped on the 5th
// wrong guess so it cannot be brute-forced inside its window.
const ACCOUNT_CODE_EXPIRY_MS = 5 * 60 * 1000;
const MAX_ACCOUNT_CODE_ATTEMPTS = 5;
const ACCOUNT_CODE_PURPOSES = ['CHANGE_PASSWORD', 'DELETE_ACCOUNT'];
const ACCOUNT_CODE_SELECT = '+accountCode.purpose +accountCode.otpHash +accountCode.expiresAt +accountCode.attempts';

const emptyCode = () => ({ purpose: null, otpHash: null, expiresAt: null, attempts: 0 });

// Replaces any earlier code: asking again is how a person gets a fresh one.
const issueAccountCode = async (identity, purpose) => {
  const code = String(crypto.randomInt(100000, 1000000));
  identity.accountCode = {
    purpose,
    otpHash: hashToken(code),
    expiresAt: new Date(Date.now() + ACCOUNT_CODE_EXPIRY_MS),
    attempts: 0
  };
  await identity.save();
  return code;
};

// `identity` must be loaded with ACCOUNT_CODE_SELECT. A correct code is consumed,
// so it works exactly once. Returns { ok } or { ok: false, message }.
const consumeAccountCode = async (identity, purpose, code) => {
  const stored = identity.accountCode || {};
  if (!stored.otpHash || !stored.expiresAt || stored.purpose !== purpose) {
    return { ok: false, message: 'Request a new code first.' };
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    identity.accountCode = emptyCode();
    await identity.save();
    return { ok: false, message: 'This code has expired. Request a new one.' };
  }

  if (!safeCompare(hashToken(String(code || '').trim()), stored.otpHash)) {
    const attempts = (stored.attempts || 0) + 1;
    if (attempts >= MAX_ACCOUNT_CODE_ATTEMPTS) {
      identity.accountCode = emptyCode();
    } else {
      identity.accountCode.attempts = attempts;
    }
    await identity.save();
    return {
      ok: false,
      message: attempts >= MAX_ACCOUNT_CODE_ATTEMPTS
        ? 'Too many wrong codes. Request a new one.'
        : 'That code is not right.'
    };
  }

  identity.accountCode = emptyCode();
  await identity.save();
  return { ok: true };
};

module.exports = {
  ACCOUNT_CODE_EXPIRY_MS,
  MAX_ACCOUNT_CODE_ATTEMPTS,
  ACCOUNT_CODE_PURPOSES,
  ACCOUNT_CODE_SELECT,
  issueAccountCode,
  consumeAccountCode
};
