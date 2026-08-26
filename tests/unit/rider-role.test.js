const { riderRoleForResolvedService } = require('../../src/utils/riderRole');

describe('riderRoleForResolvedService', () => {
  test.each([
    ['SCHOOL', 'student'],
    ['UNIVERSITY', 'student'],
    ['OFFICE', 'employee'],
    ['PUBLIC', 'passenger'],
    [undefined, 'passenger']
  ])('derives %s as %s only after enrollment resolution', (serviceType, expected) => {
    expect(riderRoleForResolvedService(serviceType)).toBe(expected);
  });
});
