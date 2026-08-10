const test = require('node:test');
const assert = require('node:assert');
const { _googleShortName: googleShortName } = require('../src/controllers/placesController');

// Helper to build a Google Geocoding-style result with the given components.
const result = (components, formatted) => ({
  formatted_address: formatted,
  address_components: components.map(([long_name, types]) => ({ long_name, types })),
});

test('uses the road-segment result, not the nearest address on an adjacent road', () => {
  const results = [
    // Nearest street address sits on an adjacent road...
    { types: ['premise', 'street_address'], formatted_address: '300/B Bopatta Rd, Kolonnawa, Sri Lanka',
      address_components: [
        { long_name: 'Bopatta Road', types: ['route'] },
        { long_name: 'Kolonnawa', types: ['locality'] },
      ] },
    // ...but the actual road the point is on is the route-typed result.
    { types: ['route'], formatted_address: 'Pathanwatta Rd, Kolonnawa, Sri Lanka',
      address_components: [
        { long_name: 'Pathanwatta Road', types: ['route'] },
        { long_name: 'Kolonnawa', types: ['locality'] },
      ] },
  ];
  assert.strictEqual(googleShortName(results), 'Pathanwatta Road, Kolonnawa');
});

test('prefers "Road, Suburb" over a nearby POI/establishment', () => {
  const results = [
    result([
      ['Gothatuwa Vehicle Stop', ['point_of_interest', 'establishment']],
      ['Bopatta Road', ['route']],
      ['Kolonnawa', ['locality']],
    ], '300/B Bopatta Rd, Kolonnawa, Sri Lanka'),
  ];
  assert.strictEqual(googleShortName(results), 'Bopatta Road, Kolonnawa');
});

test('uses the road alone when no suburb/locality is present', () => {
  const results = [result([['Galle Road', ['route']]], 'Galle Rd, Sri Lanka')];
  assert.strictEqual(googleShortName(results), 'Galle Road');
});

test('uses the area alone when there is no road', () => {
  const results = [result([['Nugegoda', ['sublocality', 'sublocality_level_1']]], 'Nugegoda, Sri Lanka')];
  assert.strictEqual(googleShortName(results), 'Nugegoda');
});

test('does not fall back to a Plus Code segment', () => {
  const results = [result([], 'WVG6+RFQ, Colombo 01000, Sri Lanka')];
  assert.strictEqual(googleShortName(results), 'Colombo 01000');
});

test('returns null when there is nothing usable', () => {
  assert.strictEqual(googleShortName([]), null);
});
