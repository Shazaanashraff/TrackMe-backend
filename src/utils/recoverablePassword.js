// Reversible storage of a driver's password, so an owning manager can read it
// back and relay it to a driver who has no email.
//
// ────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE USING IT ANYWHERE ELSE.
//
// This deliberately weakens a property the rest of the system holds: every
// other credential here is bcrypt-hashed and unrecoverable by anyone. A
// reversible copy means a database dump plus the key is a plaintext credential
// dump. It exists because the product wants managers to view driver passwords;
// it is not a pattern to copy for managers, riders, or super-admins, and it is
// explicitly the opposite of the 2026-07-08 decision that stopped super-admins
// seeing manager passwords.
//
// Deliberate limits on the blast radius:
//   - Authentication NEVER reads this. `comparePassword` still uses the bcrypt
//     hash, so a corrupted or absent ciphertext cannot let anyone in.
//   - Off unless DRIVER_PASSWORD_KEY is set. No key means nothing is written,
//     and existing rows simply stay unreadable. Leave it unset in production.
//   - The key lives only in the environment, never in the database, so a
//     database leak alone is not enough to decrypt.
//   - AES-256-GCM, random IV per record, auth tag verified on read: tampering
//     fails loudly instead of returning garbage.
// ────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32; // AES-256
const VERSION = 'v1'; // lets the format change later without silent misreads

/**
 * Derives the 32-byte key from DRIVER_PASSWORD_KEY. Accepts a 64-char hex key
 * (preferred, generate with `openssl rand -hex 32`) or falls back to SHA-256 of
 * whatever string is supplied, so a weak passphrase still yields a valid-length
 * key rather than crashing at runtime.
 */
const getKey = () => {
  const raw = process.env.DRIVER_PASSWORD_KEY;
  if (!raw) return null;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
};

/** Whether reversible storage is switched on at all. */
const isRecoveryEnabled = () => getKey() !== null;

/**
 * @returns {string|null} `v1:<iv>:<tag>:<ciphertext>` (base64url parts), or null
 *   when the feature is off or there is nothing to store.
 */
const encryptPassword = (plaintext) => {
  const key = getKey();
  if (!key || !plaintext) return null;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
};

/**
 * @returns {string|null} the plaintext, or null when the feature is off, the
 *   value is absent/malformed, or the auth tag fails. Never throws: a manager
 *   opening the dialog on an undecryptable row should see "unavailable", not a
 *   500.
 */
const decryptPassword = (stored) => {
  const key = getKey();
  if (!key || typeof stored !== 'string' || !stored) return null;

  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, tampered ciphertext, or a row written under a rotated key.
    return null;
  }
};

module.exports = {
  isRecoveryEnabled,
  encryptPassword,
  decryptPassword,
  KEY_BYTES
};
