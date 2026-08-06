// Sri Lankan phone numbers.
//
//   0771234567     local: a leading 0 then nine digits, ten in total
//   +94771234567   international: +94 then the same nine digits
//
// Ten digits is the ceiling unless the number is written internationally, which
// is the only case where a longer string is a real number rather than a typo.

const LOCAL = /^0\d{9}$/;
const INTERNATIONAL = /^\+94\d{9}$/;

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

// Caps what can be typed. Anything that is not a digit is dropped, apart from a
// leading +, which switches the limit from ten digits to eleven (94 + nine).
function cleanPhoneInput(value) {
  const raw = String(value ?? '').trim();
  const digits = digitsOnly(raw);

  if (raw.startsWith('+')) return `+${digits.slice(0, 11)}`;
  return digits.slice(0, 10);
}

// The stored form. A number given internationally is kept that way; '' when the
// input is not a Sri Lankan number at all.
//
// Note this does NOT go through cleanPhoneInput: that caps the length, which is
// right while someone is typing but would quietly turn a fourteen-digit typo
// into a valid ten-digit number instead of rejecting it.
function formatPhone(value) {
  const raw = String(value ?? '').trim();
  const candidate = raw.startsWith('+') ? `+${digitsOnly(raw)}` : digitsOnly(raw);

  if (LOCAL.test(candidate) || INTERNATIONAL.test(candidate)) return candidate;
  return '';
}

const isValidPhone = (value) => formatPhone(value) !== '';

// The same wording wherever a number is rejected.
const PHONE_FORMAT_MESSAGE =
  'Enter a Sri Lankan phone number, for example 0771234567 or +94771234567';

module.exports = {
  PHONE_FORMAT_MESSAGE,
  cleanPhoneInput,
  formatPhone,
  isValidPhone
};
