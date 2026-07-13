// Room-key (6-digit PIN) crypto helpers for the Private Routes feature.
// Pure functions, no DB access — see PRIVATE_ROUTES_PLAN.md §4.
const crypto = require('crypto');

const CODE_LENGTH = 6;
const CODE_MAX = 10 ** CODE_LENGTH; // 1_000_000
const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const MAX_GENERATE_RETRIES = 20;

function getEncryptionKey() {
  const secret = process.env.ROOM_KEY_SECRET;
  if (!secret) {
    throw new Error('ROOM_KEY_SECRET is not configured');
  }
  // Accept hex or base64; normalize to a 32-byte key.
  let key = Buffer.from(secret, /^[0-9a-fA-F]+$/.test(secret) && secret.length === 64 ? 'hex' : 'base64');
  if (key.length !== 32) {
    // Fall back to deriving a stable 32-byte key from whatever string was given.
    key = crypto.createHash('sha256').update(secret).digest();
  }
  return key;
}

function getPepper() {
  const pepper = process.env.ROOM_KEY_PEPPER;
  if (!pepper) {
    throw new Error('ROOM_KEY_PEPPER is not configured');
  }
  return pepper;
}

/**
 * Cryptographically-random 6-digit code, zero-padded.
 */
function generateCode() {
  const n = crypto.randomInt(0, CODE_MAX);
  return String(n).padStart(CODE_LENGTH, '0');
}

/**
 * AES-256-GCM encrypt a code. Reversible (manager can reveal it later).
 */
function encryptCode(code) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(code), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

/**
 * Decrypt a previously-encrypted code (manager reveal).
 */
function decryptCode({ ciphertext, iv, authTag }) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(AES_ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

/**
 * Deterministic HMAC-SHA256(code, ROOM_KEY_PEPPER) hex digest, used for manual-entry
 * lookup + a unique index (never store the plaintext code for lookup).
 */
function lookupHash(code) {
  return crypto.createHmac('sha256', getPepper()).update(String(code)).digest('hex');
}

/**
 * Constant-time comparison of a candidate code against a stored room key's lookupHash.
 */
function verifyCode(code, roomKey) {
  if (!roomKey || !roomKey.lookupHash) return false;
  const candidate = Buffer.from(lookupHash(code), 'hex');
  const stored = Buffer.from(roomKey.lookupHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/**
 * Generate a code/encryption/lookupHash triple that's globally unique, retrying on
 * the rare collision. `existsFn(hash)` should return a boolean/Promise<boolean>.
 */
async function generateUniqueRoomKey(existsFn) {
  for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt += 1) {
    const code = generateCode();
    const hash = lookupHash(code);
    // eslint-disable-next-line no-await-in-loop
    const exists = await existsFn(hash);
    if (!exists) {
      const { ciphertext, iv, authTag } = encryptCode(code);
      return { code, ciphertext, iv, authTag, lookupHash: hash };
    }
  }
  throw new Error('Could not generate a unique room key after maximum retries');
}

module.exports = {
  CODE_LENGTH,
  generateCode,
  encryptCode,
  decryptCode,
  lookupHash,
  verifyCode,
  generateUniqueRoomKey
};
