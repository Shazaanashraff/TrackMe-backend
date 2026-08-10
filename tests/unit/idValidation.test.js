const { allRequestedIdsFound } = require('../../src/utils/idValidation');

describe('allRequestedIdsFound (issue #82)', () => {
  test('passes when every requested id has a matching document', () => {
    const requested = ['a1', 'b2', 'c3'];
    const found = [{ _id: 'a1' }, { _id: 'b2' }, { _id: 'c3' }];

    expect(allRequestedIdsFound(requested, found)).toBe(true);
  });

  test('a duplicated valid id in the request does not produce a false-negative failure', () => {
    const requested = ['a1', 'a1', 'b2'];
    const found = [{ _id: 'a1' }, { _id: 'b2' }];

    expect(allRequestedIdsFound(requested, found)).toBe(true);
  });

  test('fails when a requested id has no matching document', () => {
    const requested = ['a1', 'missing'];
    const found = [{ _id: 'a1' }];

    expect(allRequestedIdsFound(requested, found)).toBe(false);
  });

  test('compares ids as strings, tolerant of ObjectId vs string mismatch', () => {
    const requested = ['507f1f77bcf86cd799439011'];
    const found = [{ _id: { toString: () => '507f1f77bcf86cd799439011' } }];

    expect(allRequestedIdsFound(requested, found)).toBe(true);
  });
});
