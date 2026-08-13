const { riderTagForServiceType } = require('../../src/utils/riderTag');

describe('riderTagForServiceType', () => {
  test.each([
    ['SCHOOL', 'STUDENT'],
    ['UNIVERSITY', 'STUDENT'],
    ['OFFICE', 'EMPLOYEE'],
    ['PUBLIC', 'PASSENGER'],
    [null, 'PASSENGER'],
    [undefined, 'PASSENGER'],
    ['', 'PASSENGER'],
    ['not-a-real-service-type', 'PASSENGER']
  ])('%s -> %s', (serviceType, expected) => {
    expect(riderTagForServiceType(serviceType)).toBe(expected);
  });
});
