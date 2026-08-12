const { validateAvatarDataUrl, base64ByteLength } = require('../../src/utils/avatar');

const VALID_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('validateAvatarDataUrl', () => {
  test('accepts a valid PNG data URL under the cap', () => {
    expect(validateAvatarDataUrl(VALID_PNG, 2 * 1024 * 1024)).toEqual({ ok: true });
  });

  test('rejects a non-string', () => {
    expect(validateAvatarDataUrl(null, 2 * 1024 * 1024)).toMatchObject({ ok: false, status: 400 });
  });

  test('rejects a non-image data URL', () => {
    expect(validateAvatarDataUrl('data:text/plain;base64,aGVsbG8=', 2 * 1024 * 1024))
      .toMatchObject({ ok: false, status: 400 });
  });

  test('rejects an image over the given byte cap, with the cap named in the message', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(1000)}`;
    const res = validateAvatarDataUrl(oversized, 100); // 100-byte cap, well under 750 decoded bytes
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(res.message).toMatch(/max 0 KB|max \d+ KB/);
  });

  test('the same image passes a looser cap and fails a tighter one', () => {
    // 2800000 base64 chars ~= 2.1 MB decoded, matching authController's own oversize test fixture.
    const big = `data:image/png;base64,${'A'.repeat(2_800_000)}`;
    expect(validateAvatarDataUrl(big, 3 * 1024 * 1024).ok).toBe(true);
    expect(validateAvatarDataUrl(big, 512 * 1024).ok).toBe(false);
  });
});

describe('base64ByteLength', () => {
  test('accounts for padding', () => {
    expect(base64ByteLength('QQ==')).toBe(1); // 'A'
    expect(base64ByteLength('QUI=')).toBe(2); // 'AB'
    expect(base64ByteLength('QUJD')).toBe(3); // 'ABC'
  });
});
