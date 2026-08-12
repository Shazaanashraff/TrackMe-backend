const { planProfileKindBackfill, planBlankEmailCleanup } = require('../../scripts/migrate-rider-profiles');

// Pure planning logic — no MongoDB. Every existing User document predates the
// managed-profile concept, so the backfill plan is deliberately simple: no
// document is ever excluded on a judgement call the way migrate-to-identities'
// conflict detection is. What has to be exactly right is which documents get
// touched and which don't.

describe('planProfileKindBackfill', () => {
  test('selects only documents with no profileKind at all', () => {
    const ids = planProfileKindBackfill([
      { _id: 'a' },
      { _id: 'b', profileKind: 'PRIMARY' },
      { _id: 'c', profileKind: 'MANAGED' }
    ]);
    expect(ids).toEqual(['a']);
  });

  test('a re-run after the first is a no-op', () => {
    const ids = planProfileKindBackfill([
      { _id: 'a', profileKind: 'PRIMARY' },
      { _id: 'b', profileKind: 'MANAGED' }
    ]);
    expect(ids).toEqual([]);
  });

  test('tolerates an empty or missing collection', () => {
    expect(planProfileKindBackfill([])).toEqual([]);
    expect(planProfileKindBackfill(undefined)).toEqual([]);
  });
});

describe('planBlankEmailCleanup', () => {
  test('selects MANAGED documents with an empty string or explicit null email', () => {
    const ids = planBlankEmailCleanup([
      { _id: 'a', profileKind: 'MANAGED', email: '' },
      { _id: 'b', profileKind: 'MANAGED', email: null },
      { _id: 'c', profileKind: 'MANAGED', email: 'real@test.com' },
      { _id: 'd', profileKind: 'MANAGED' } // already missing — nothing to unset
    ]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  test('never touches a PRIMARY document, even with a blank email', () => {
    // A blank email on a PRIMARY is exactly the state the backfill must not
    // produce — unsetting it here would leave a PRIMARY with no email, which
    // violates the invariant the schema itself enforces (User.js).
    const ids = planBlankEmailCleanup([
      { _id: 'a', profileKind: 'PRIMARY', email: '' },
      { _id: 'b', email: '' } // no profileKind yet — about to become PRIMARY
    ]);
    expect(ids).toEqual([]);
  });

  test('a re-run after cleanup is a no-op', () => {
    const ids = planBlankEmailCleanup([
      { _id: 'a', profileKind: 'MANAGED', email: 'real@test.com' },
      { _id: 'b', profileKind: 'MANAGED' }
    ]);
    expect(ids).toEqual([]);
  });

  test('tolerates an empty or missing collection', () => {
    expect(planBlankEmailCleanup([])).toEqual([]);
    expect(planBlankEmailCleanup(undefined)).toEqual([]);
  });
});
