// A driver's permanent, human-readable sign-in ID (e.g. TMD-4K7P-9XQ2).
//
// Unlike the enrollment key this is not a secret — it is printed on a slip and
// read aloud, so it is stored in plaintext on the driver and only needs to be
// unique and hard to mistype. It never changes: a driver whose email is later
// added or removed keeps the same ID.
const crypto = require('crypto');

// Excludes I/O/0/1 — these get read aloud and typed by hand.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PREFIX = 'DRV';
const BLOCK = 4;
const MAX_GENERATE_RETRIES = 12;

function randomBlock(length = BLOCK) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const generateDriverCode = () => `${PREFIX}-${randomBlock()}-${randomBlock()}`;

// Accepts what a human might type: lower case, spaces instead of dashes, or the
// bare blocks without the prefix. Returns the canonical dashed form, or '' when
// the input could not be a driver code at all.
function normalizeDriverCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
  if (body.length !== BLOCK * 2) return '';
  if (!/^[0-9A-Z]+$/.test(body)) return '';
  return `${PREFIX}-${body.slice(0, BLOCK)}-${body.slice(BLOCK)}`;
}

// Anything with an @ is an email, never a driver code — checked first so a
// malformed email is reported as a bad email rather than a bad ID.
const looksLikeDriverCode = (value) =>
  !String(value || '').includes('@') && normalizeDriverCode(value) !== '';

// Retries on the unique driverCode index, so a collision costs a retry rather
// than handing two drivers the same ID.
async function generateUniqueDriverCode(Model) {
  for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt += 1) {
    const code = generateDriverCode();
    // eslint-disable-next-line no-await-in-loop
    const taken = await Model.exists({ driverCode: code });
    if (!taken) return code;
  }
  throw new Error('Could not generate a unique driver ID');
}

module.exports = {
  DRIVER_CODE_PREFIX: PREFIX,
  generateDriverCode,
  generateUniqueDriverCode,
  normalizeDriverCode,
  looksLikeDriverCode
};
