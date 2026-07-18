// Unit tests for the room-key crypto helpers (pure functions, no DB). See
// PRIVATE_ROUTES_PLAN.md §4 and docs/TESTING_GUIDE.md.
require('dotenv').config();
const {
  generateCode,
  encryptCode,
  decryptCode,
  lookupHash,
  verifyCode,
  generateUniqueRoomKey
} = require('../../src/utils/roomKey');

describe('roomKey utils', () => {
  describe('generateCode', () => {
    it('produces a zero-padded 6-digit string', () => {
      for (let i = 0; i < 50; i += 1) {
        const code = generateCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(Number(code)).toBeGreaterThanOrEqual(0);
        expect(Number(code)).toBeLessThan(1000000);
      }
    });
  });

  describe('encryptCode / decryptCode', () => {
    it('round-trips a code', () => {
      const code = '042317';
      const enc = encryptCode(code);
      expect(enc.ciphertext).toEqual(expect.any(String));
      expect(enc.iv).toEqual(expect.any(String));
      expect(enc.authTag).toEqual(expect.any(String));
      expect(decryptCode(enc)).toBe(code);
    });

    it('produces different ciphertext/iv each call (random IV)', () => {
      const a = encryptCode('123456');
      const b = encryptCode('123456');
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it('fails to decrypt with a tampered authTag', () => {
      const enc = encryptCode('123456');
      const tampered = { ...enc, authTag: Buffer.alloc(16, 1).toString('base64') };
      expect(() => decryptCode(tampered)).toThrow();
    });
  });

  describe('lookupHash', () => {
    it('is deterministic for the same code', () => {
      expect(lookupHash('123456')).toBe(lookupHash('123456'));
    });

    it('differs for different codes', () => {
      expect(lookupHash('123456')).not.toBe(lookupHash('654321'));
    });
  });

  describe('verifyCode', () => {
    it('returns true for the correct code', () => {
      const roomKey = { lookupHash: lookupHash('555555') };
      expect(verifyCode('555555', roomKey)).toBe(true);
    });

    it('returns false for the wrong code', () => {
      const roomKey = { lookupHash: lookupHash('555555') };
      expect(verifyCode('111111', roomKey)).toBe(false);
    });

    it('returns false when roomKey has no lookupHash', () => {
      expect(verifyCode('123456', { lookupHash: null })).toBe(false);
      expect(verifyCode('123456', null)).toBe(false);
    });
  });

  describe('generateUniqueRoomKey', () => {
    it('returns a code/ciphertext/lookupHash tuple when no collision', async () => {
      const existsFn = jest.fn().mockResolvedValue(false);
      const result = await generateUniqueRoomKey(existsFn);
      expect(result.code).toMatch(/^\d{6}$/);
      expect(result.lookupHash).toBe(lookupHash(result.code));
      expect(decryptCode(result)).toBe(result.code);
      expect(existsFn).toHaveBeenCalledTimes(1);
    });

    it('retries on collision until a unique hash is found', async () => {
      let calls = 0;
      const existsFn = jest.fn().mockImplementation(async () => {
        calls += 1;
        return calls < 3; // first two "exist", third is unique
      });
      const result = await generateUniqueRoomKey(existsFn);
      expect(result.code).toMatch(/^\d{6}$/);
      expect(existsFn).toHaveBeenCalledTimes(3);
    });

    it('throws after exceeding max retries', async () => {
      const existsFn = jest.fn().mockResolvedValue(true);
      await expect(generateUniqueRoomKey(existsFn)).rejects.toThrow();
    });
  });
});
