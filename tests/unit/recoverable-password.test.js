const crypto = require('crypto');
const {
  isRecoveryEnabled,
  encryptPassword,
  decryptPassword
} = require('../../src/utils/recoverablePassword');

const HEX_KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');

const withKey = (key, fn) => {
  const previous = process.env.DRIVER_PASSWORD_KEY;
  if (key === undefined) delete process.env.DRIVER_PASSWORD_KEY;
  else process.env.DRIVER_PASSWORD_KEY = key;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DRIVER_PASSWORD_KEY;
    else process.env.DRIVER_PASSWORD_KEY = previous;
  }
};

describe('feature gate', () => {
  test('is off when no key is configured', () => {
    withKey(undefined, () => {
      expect(isRecoveryEnabled()).toBe(false);
      expect(encryptPassword('Driver@123')).toBeNull();
    });
  });

  test('is on with a hex key', () => {
    withKey(HEX_KEY, () => expect(isRecoveryEnabled()).toBe(true));
  });

  // A weak passphrase must still yield a valid 32-byte key rather than crashing
  // at runtime on a deployment that set something non-hex.
  test('accepts a non-hex passphrase by deriving a key from it', () => {
    withKey('not-a-hex-key', () => {
      expect(isRecoveryEnabled()).toBe(true);
      expect(decryptPassword(encryptPassword('Driver@123'))).toBe('Driver@123');
    });
  });
});

describe('round trip', () => {
  test('recovers the original password', () => {
    withKey(HEX_KEY, () => {
      expect(decryptPassword(encryptPassword('Driver@123'))).toBe('Driver@123');
    });
  });

  test('handles unicode and long passwords', () => {
    withKey(HEX_KEY, () => {
      const secret = 'ශ්‍රී🚌 pässwörd with spaces ' + 'x'.repeat(200);
      expect(decryptPassword(encryptPassword(secret))).toBe(secret);
    });
  });

  // A fresh IV per record: identical passwords must not produce identical
  // ciphertext, or the store leaks which drivers share a password.
  test('encrypts the same password differently each time', () => {
    withKey(HEX_KEY, () => {
      expect(encryptPassword('same')).not.toBe(encryptPassword('same'));
    });
  });

  test('stores nothing for an empty password', () => {
    withKey(HEX_KEY, () => {
      expect(encryptPassword('')).toBeNull();
      expect(encryptPassword(null)).toBeNull();
      expect(encryptPassword(undefined)).toBeNull();
    });
  });
});

describe('decrypt refuses bad input instead of throwing', () => {
  test('returns null without a key', () => {
    const stored = withKey(HEX_KEY, () => encryptPassword('Driver@123'));
    withKey(undefined, () => expect(decryptPassword(stored)).toBeNull());
  });

  test('returns null under a different key rather than garbage', () => {
    const stored = withKey(HEX_KEY, () => encryptPassword('Driver@123'));
    withKey(OTHER_KEY, () => expect(decryptPassword(stored)).toBeNull());
  });

  test('rejects a tampered ciphertext via the auth tag', () => {
    withKey(HEX_KEY, () => {
      const stored = encryptPassword('Driver@123');
      const parts = stored.split(':');
      const bytes = Buffer.from(parts[3], 'base64url');
      bytes[0] ^= 0xff;
      parts[3] = bytes.toString('base64url');
      expect(decryptPassword(parts.join(':'))).toBeNull();
    });
  });

  test('rejects an unknown format version', () => {
    withKey(HEX_KEY, () => {
      const stored = encryptPassword('Driver@123');
      expect(decryptPassword(stored.replace(/^v1:/, 'v2:'))).toBeNull();
    });
  });

  test.each([null, undefined, '', 'garbage', 'v1:only:three', 42, {}])(
    'returns null for malformed input %p',
    (input) => {
      withKey(HEX_KEY, () => expect(decryptPassword(input)).toBeNull());
    }
  );
});
