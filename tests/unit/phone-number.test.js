const {
  cleanPhoneInput,
  formatPhone,
  isValidPhone
} = require('../../src/utils/phoneNumber');

// Sri Lankan numbers are ten digits locally (0771234567) or +94 and nine
// (+94771234567). Ten is the ceiling unless the number is written
// internationally, which is the only case where longer is real rather than a
// slipped finger on the keypad.

describe('cleanPhoneInput', () => {
  test('stops a local number at ten digits', () => {
    expect(cleanPhoneInput('0755613572222222222225')).toBe('0755613572');
  });

  test('allows eleven digits behind a +, for 94 plus the nine', () => {
    expect(cleanPhoneInput('+94755613572')).toBe('+94755613572');
    expect(cleanPhoneInput('+947556135729999')).toBe('+94755613572');
  });

  test('drops spaces, dashes and brackets as they are typed', () => {
    expect(cleanPhoneInput('077 123 4567')).toBe('0771234567');
    expect(cleanPhoneInput('077-123-4567')).toBe('0771234567');
    expect(cleanPhoneInput('(077) 1234567')).toBe('0771234567');
  });

  test('keeps a lone + so the country code can still be typed', () => {
    expect(cleanPhoneInput('+')).toBe('+');
  });

  test('drops letters', () => {
    expect(cleanPhoneInput('077abc4567')).toBe('0774567');
  });

  test.each([[''], [null], [undefined]])('returns empty for %s', (input) => {
    expect(cleanPhoneInput(input)).toBe('');
  });
});

describe('isValidPhone', () => {
  test.each([
    ['0771234567', 'a mobile'],
    ['0112345678', 'a Colombo landline'],
    ['+94771234567', 'the international form'],
    ['077 123 4567', 'spaced out']
  ])('accepts %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(true);
  });

  test.each([
    ['077123456', 'nine digits'],
    ['7712345678', 'no leading zero'],
    ['+94771234', 'too short for +94'],
    ['+4471234567', 'a country code that is not 94'],
    ['', 'empty']
  ])('rejects %s (%s)', (input) => {
    expect(isValidPhone(input)).toBe(false);
  });

  // The input cap truncates, and validation must not: a fourteen-digit typo is
  // a rejection, not a ten-digit number with the tail quietly dropped.
  test.each([
    ['0755613572222222222225', 'far too long'],
    ['07712345678', 'one digit too many'],
    ['+947712345678', 'one digit too many internationally']
  ])('rejects %s (%s) rather than trimming it', (input) => {
    expect(isValidPhone(input)).toBe(false);
  });
});

describe('formatPhone', () => {
  test('keeps the form it was given', () => {
    expect(formatPhone('077 123 4567')).toBe('0771234567');
    expect(formatPhone('+94 77 123 4567')).toBe('+94771234567');
  });

  test('returns empty for a number that is not Sri Lankan', () => {
    expect(formatPhone('+4471234567')).toBe('');
  });
});
