const {
  parsePlate,
  formatPlate,
  isValidPlate,
  plateMatches
} = require('../../src/utils/numberPlate');

// Sri Lankan plates come in three shapes: current issue (CAB-1234), current
// issue carrying a province (WP CAB-1234), and pre-2000 numeric (62-1234).
// Managers type them with whatever spacing they like, so everything is stored
// canonically.

describe('formatPlate', () => {
  test.each([
    ['CAB-1234', 'CAB-1234'],
    ['cab-1234', 'CAB-1234'],
    ['cab 1234', 'CAB-1234'],
    ['CAB1234', 'CAB-1234'],
    // Two-letter series, and the spacing from the bug report.
    ['PF-2327', 'PF-2327'],
    ['PF- 2327', 'PF-2327'],
    ['pf2327', 'PF-2327'],
    // Pre-2000 numeric plates.
    ['62-1234', '62-1234'],
    ['300-1234', '300-1234'],
    ['621234', '62-1234']
  ])('formats %s as %s', (input, expected) => {
    expect(formatPlate(input)).toBe(expected);
  });

  test.each([
    ['WP CAB-1234', 'WP CAB-1234'],
    ['wp cab 1234', 'WP CAB-1234'],
    ['WPCAB1234', 'WP CAB-1234'],
    ['sg-ka-9876', 'SG KA-9876'],
    ['NC 62-1234', 'NC 62-1234']
  ])('keeps the province on %s', (input, expected) => {
    expect(formatPlate(input)).toBe(expected);
  });

  // "WP-1234" is an ordinary plate whose series happens to spell a province, so
  // the province is only read when what follows is itself a whole plate.
  test('reads WP-1234 as a plate, not as a province with nothing after it', () => {
    expect(parsePlate('WP-1234')).toEqual({ province: null, series: 'WP', digits: '1234' });
    expect(formatPlate('WP-1234')).toBe('WP-1234');
  });

  test('reads WP CAB-1234 as a province plus a plate', () => {
    expect(parsePlate('WP CAB-1234')).toEqual({ province: 'WP', series: 'CAB', digits: '1234' });
  });

  test.each([
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['CAB-123', 'three digits'],
    ['CAB-12345', 'five digits'],
    ['C-1234', 'one letter'],
    ['CABX-1234', 'four letters'],
    ['1-1234', 'one digit series'],
    ['ABCD', 'no digits'],
    ['1234', 'digits only'],
    ['CAB-12A4', 'a letter among the digits'],
    ['ZZ CAB-1234', 'an unknown province code']
  ])('rejects %s (%s)', (input) => {
    expect(formatPlate(input)).toBe('');
    expect(isValidPlate(input)).toBe(false);
  });
});

describe('plateMatches', () => {
  test('matches the same plate however it was typed', () => {
    expect(plateMatches('PF-2327', 'pf 2327')).toBe(true);
    expect(plateMatches('WP CAB-1234', 'wpcab1234')).toBe(true);
  });

  test('does not match different plates', () => {
    expect(plateMatches('CAB-1234', 'CAB-1235')).toBe(false);
    expect(plateMatches('WP CAB-1234', 'CP CAB-1234')).toBe(false);
  });

  // Rows saved before plates were normalised may hold anything at all; they
  // still have to be findable by typing exactly what is stored.
  test('falls back to a plain comparison for a legacy plate', () => {
    expect(plateMatches('BUS-FLEET-9', 'bus fleet 9')).toBe(true);
    expect(plateMatches('BUS-FLEET-9', 'BUS-FLEET-8')).toBe(false);
  });

  test('never matches on emptiness', () => {
    expect(plateMatches('', '')).toBe(false);
    expect(plateMatches(null, undefined)).toBe(false);
  });
});
