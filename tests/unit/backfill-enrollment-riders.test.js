const { planEnrollmentBackfill } = require('../../scripts/backfill-enrollment-riders');

// Pure planning logic — no MongoDB. The stakes here are not "did every row get
// touched" but "was any row attached to the WRONG rider", so the ambiguous
// cases matter more than the happy path.

const accounts = (entries) => new Map(Object.entries(entries));

describe('planEnrollmentBackfill', () => {
  test('backfills a legacy row from its account’s only rider profile', () => {
    const { updates, skipped } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: null, userId: 'acct1' }],
      accounts({ acct1: ['rider1'] })
    );

    expect(updates).toEqual([{ _id: 'e1', studentId: 'rider1' }]);
    expect(skipped).toEqual([]);
  });

  test('treats a missing studentId field the same as an explicit null', () => {
    const { updates } = planEnrollmentBackfill(
      [{ _id: 'e1', userId: 'acct1' }],
      accounts({ acct1: ['rider1'] })
    );

    expect(updates).toEqual([{ _id: 'e1', studentId: 'rider1' }]);
  });

  test('leaves an already-correct row alone, so a re-run is a no-op', () => {
    const { updates, skipped } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: 'rider1', userId: 'acct1' }],
      accounts({ acct1: ['rider1'] })
    );

    expect(updates).toEqual([]);
    expect(skipped).toEqual([]);
  });

  // The case this migration exists for: the profile reused the account's _id.
  test('handles a profile whose id equals the account id', () => {
    const { updates } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: null, userId: 'shared-id' }],
      accounts({ 'shared-id': ['shared-id'] })
    );

    expect(updates).toEqual([{ _id: 'e1', studentId: 'shared-id' }]);
  });

  test('refuses to guess when an account has several rider profiles', () => {
    const { updates, skipped } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: null, userId: 'acct1' }],
      accounts({ acct1: ['riderA', 'riderB'] })
    );

    expect(updates).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/ambiguous/);
  });

  test('skips a row whose account has no rider profile', () => {
    const { updates, skipped } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: null, userId: 'acct1' }],
      accounts({})
    );

    expect(updates).toEqual([]);
    expect(skipped[0].reason).toMatch(/no rider profile/);
  });

  test('skips an unattributable row with neither studentId nor userId', () => {
    const { updates, skipped } = planEnrollmentBackfill(
      [{ _id: 'e1', studentId: null, userId: null }],
      accounts({ acct1: ['rider1'] })
    );

    expect(updates).toEqual([]);
    expect(skipped[0].reason).toMatch(/cannot attribute/);
  });

  test('resolves each row against its own account, not the first one seen', () => {
    const { updates } = planEnrollmentBackfill(
      [
        { _id: 'e1', studentId: null, userId: 'acct1' },
        { _id: 'e2', studentId: null, userId: 'acct2' }
      ],
      accounts({ acct1: ['riderA'], acct2: ['riderB'] })
    );

    expect(updates).toEqual([
      { _id: 'e1', studentId: 'riderA' },
      { _id: 'e2', studentId: 'riderB' }
    ]);
  });

  test('tolerates an empty or missing collection', () => {
    expect(planEnrollmentBackfill([], accounts({})).updates).toEqual([]);
    expect(planEnrollmentBackfill(undefined, undefined).updates).toEqual([]);
  });
});
