const {
  generateDriverCode,
  normalizeDriverCode,
  looksLikeDriverCode
} = require('../../src/utils/driverCode');

// A driver's permanent sign-in ID. It gets read aloud and typed by hand on a
// phone, so the normalizer has to forgive case, spacing, and a missing prefix —
// without ever turning something that is not an ID into one.

describe('generateDriverCode', () => {
  test('produces the canonical DRV-XXXX-XXXX shape', () => {
    expect(generateDriverCode()).toMatch(/^DRV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  test('omits characters that are misread when spoken (I, O, 0, 1)', () => {
    const codes = Array.from({ length: 200 }, () => generateDriverCode()).join('');
    expect(codes).not.toMatch(/[IO01]/);
  });

  test('does not repeat itself across many draws', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateDriverCode()));
    expect(codes.size).toBe(500);
  });
});

describe('normalizeDriverCode', () => {
  test.each([
    ['DRV-4K7P-9XQ2', 'DRV-4K7P-9XQ2'],
    ['drv-4k7p-9xq2', 'DRV-4K7P-9XQ2'],
    ['DRV 4K7P 9XQ2', 'DRV-4K7P-9XQ2'],
    ['drv4k7p9xq2', 'DRV-4K7P-9XQ2'],
    // Typed without the prefix, which is what people do when reading a slip.
    ['4K7P9XQ2', 'DRV-4K7P-9XQ2'],
    ['4k7p-9xq2', 'DRV-4K7P-9XQ2']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDriverCode(input)).toBe(expected);
  });

  test.each([
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['DRV-4K7P', 'too short'],
    ['DRV-4K7P-9XQ2-EXTRA', 'too long'],
    ['someone@example.com', 'an email']
  ])('returns empty for %s (%s)', (input) => {
    expect(normalizeDriverCode(input)).toBe('');
  });
});

describe('looksLikeDriverCode', () => {
  test('accepts a driver code in any of the forms people type', () => {
    expect(looksLikeDriverCode('DRV-4K7P-9XQ2')).toBe(true);
    expect(looksLikeDriverCode('4k7p9xq2')).toBe(true);
  });

  test('rejects anything with an @, so a bad email is never read as an ID', () => {
    expect(looksLikeDriverCode('drv4k7p9xq2@t.com')).toBe(false);
    expect(looksLikeDriverCode('driver@company.com')).toBe(false);
  });

  test('rejects a partial or empty entry', () => {
    expect(looksLikeDriverCode('DRV-')).toBe(false);
    expect(looksLikeDriverCode('')).toBe(false);
  });
});
