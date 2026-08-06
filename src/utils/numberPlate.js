// Sri Lankan vehicle number plates.
//
// Three shapes are on the road and all three are accepted:
//   CAB-1234      current issue: two or three letters, then four digits
//   WP CAB-1234   the same, carrying the province the vehicle is registered in
//   62-1234       pre-2000 issue: two or three digits, then four digits
//
// Everything is stored in the canonical form above, so a plate typed as
// "wp cab 1234", "PF- 2327" or "pf2327" is the same record either way.

const PROVINCES = {
  WP: 'Western',
  CP: 'Central',
  SP: 'Southern',
  NP: 'Northern',
  EP: 'Eastern',
  NW: 'North Western',
  NC: 'North Central',
  UP: 'Uva',
  SG: 'Sabaragamuwa'
};

const PROVINCE_CODES = Object.keys(PROVINCES);

// The part that identifies the vehicle, without any province prefix.
const LETTER_PLATE = /^([A-Z]{2,3})(\d{4})$/;
const NUMERIC_PLATE = /^(\d{2,3})(\d{4})$/;

const strip = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Returns { province, series, digits } or null. `province` is null unless the
// plate carries one.
//
// A leading province code is only read as a province when what follows is itself
// a whole plate, because "WP-1234" is a perfectly ordinary plate whose series
// happens to spell a province.
function parsePlate(value) {
  const raw = strip(value);
  if (!raw) return null;

  const asPlate = (body, province = null) => {
    const letters = body.match(LETTER_PLATE);
    if (letters) return { province, series: letters[1], digits: letters[2] };
    const numeric = body.match(NUMERIC_PLATE);
    if (numeric) return { province, series: numeric[1], digits: numeric[2] };
    return null;
  };

  const withoutProvince = asPlate(raw);
  if (withoutProvince) return withoutProvince;

  const code = raw.slice(0, 2);
  if (PROVINCE_CODES.includes(code)) {
    const rest = asPlate(raw.slice(2), code);
    if (rest) return rest;
  }

  return null;
}

// The stored/displayed form. Returns '' when the input is not a plate at all,
// so callers can tell "nothing usable" from a real value.
function formatPlate(value) {
  const parsed = parsePlate(value);
  if (!parsed) return '';
  const plate = `${parsed.series}-${parsed.digits}`;
  return parsed.province ? `${parsed.province} ${plate}` : plate;
}

const isValidPlate = (value) => parsePlate(value) !== null;

// Same wording everywhere a plate is rejected, so the manager sees one rule.
const PLATE_FORMAT_MESSAGE =
  'Enter a Sri Lankan number plate, for example CAB-1234, WP CAB-1234 or 62-1234';

// Two plates are the same vehicle when they canonicalise to the same thing.
// Falls back to a plain comparison for legacy rows stored in some other shape.
function plateMatches(a, b) {
  const left = formatPlate(a);
  const right = formatPlate(b);
  if (left && right) return left === right;
  return strip(a) === strip(b) && strip(a) !== '';
}

module.exports = {
  PROVINCES,
  PROVINCE_CODES,
  PLATE_FORMAT_MESSAGE,
  parsePlate,
  formatPlate,
  isValidPlate,
  plateMatches
};
