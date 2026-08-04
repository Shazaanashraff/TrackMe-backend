// Driver enrollment keys — the code a passenger uses to enrol with a driver.
//
// The plaintext key is never stored. Two derived values are kept instead:
//   lookupHash — HMAC, so a scanned key can find its driver without decrypting
//   ciphertext — AES-256-GCM, so a manager can reveal the key again later
//
// Both derive from one master secret via separate HMAC purposes, so the lookup
// hash can never be used to work backwards into the encryption key.
const crypto = require('crypto');
const DriverEnrollmentKey = require('../models/DriverEnrollmentKey');

// Excludes I/O/0/1 — these get read aloud and typed by hand.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PREFIX = 'TMD';
const MAX_GENERATE_RETRIES = 12;

function masterSecret() {
  const value = process.env.DRIVER_ENROLLMENT_KEY_SECRET || process.env.JWT_SECRET;
  if (!value) {
    throw new Error('DRIVER_ENROLLMENT_KEY_SECRET or JWT_SECRET is required');
  }
  return crypto.createHash('sha256').update(value).digest();
}

const derivedKey = (purpose) =>
  crypto.createHmac('sha256', masterSecret()).update(`trackme:${purpose}`).digest();

// Accepts what a human might type: lower case, spaces, missing prefix.
function normalizeEnrollmentKey(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.startsWith(PREFIX) ? raw : `${PREFIX}${raw}`;
}

function randomBlock(length = 4) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const generateDisplayKey = () => `${PREFIX}-${randomBlock()}-${randomBlock()}-${randomBlock()}`;

const lookupHash = (value) =>
  crypto
    .createHmac('sha256', derivedKey('enrollment-lookup'))
    .update(normalizeEnrollmentKey(value))
    .digest('hex');

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey('enrollment-encryption'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt(record) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    derivedKey('enrollment-encryption'),
    Buffer.from(record.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

// Retries on the unique lookupHash index, so a collision costs a retry rather
// than handing two drivers the same key.
async function createKeyForDriver(driverId) {
  for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt += 1) {
    const key = generateDisplayKey();
    try {
      // eslint-disable-next-line no-await-in-loop
      await DriverEnrollmentKey.findOneAndUpdate(
        { driverId },
        { driverId, lookupHash: lookupHash(key), ...encrypt(key), rotatedAt: new Date() },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return key;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error('Could not generate a unique enrollment key');
}

// Returns the existing key, creating one if the driver has none yet.
async function ensureDriverEnrollmentKey(driverId) {
  const existing = await DriverEnrollmentKey.findOne({ driverId }).select(
    '+ciphertext +iv +authTag'
  );
  if (existing) return decrypt(existing);
  return createKeyForDriver(driverId);
}

const rotateDriverEnrollmentKey = (driverId) => createKeyForDriver(driverId);

const findDriverIdByEnrollmentKey = async (value) => {
  const record = await DriverEnrollmentKey.findOne({ lookupHash: lookupHash(value) });
  return record ? record.driverId : null;
};

module.exports = {
  normalizeEnrollmentKey,
  ensureDriverEnrollmentKey,
  rotateDriverEnrollmentKey,
  findDriverIdByEnrollmentKey
};
