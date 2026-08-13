const { loginFilterForRole, ACCOUNTS } = require('../../src/utils/accountRegistry');

// `loginFilterForRole` is what stops a lookup by identityId alone from returning
// an arbitrary rider profile. Once an account holder can add managed profiles,
// several User documents share one identityId, and MongoDB's `findOne` picks in
// natural order — so without this filter a parent could sign in and be handed
// their child's session. These cases lock the filter's shape.

describe('loginFilterForRole', () => {
  it('narrows the rider role to the account holder', () => {
    // Expressed as "not MANAGED" rather than "is PRIMARY" deliberately: `$ne`
    // also matches documents written before profileKind existed, which is what
    // lets the filter ship ahead of the backfill.
    expect(loginFilterForRole('user')).toEqual({ profileKind: { $ne: 'MANAGED' } });
  });

  it('leaves the single-profile roles unfiltered', () => {
    // A person holds at most one of each of these per identity, so there is
    // nothing to disambiguate and the filter must not narrow the lookup.
    expect(loginFilterForRole('driver')).toEqual({});
    expect(loginFilterForRole('admin')).toEqual({});
    expect(loginFilterForRole('super-admin')).toEqual({});
  });

  it('returns an empty filter for an unknown role rather than throwing', () => {
    // Callers spread the result unconditionally, so an unknown role has to
    // degrade to "no extra criteria" instead of blowing up the query builder.
    expect(loginFilterForRole('nope')).toEqual({});
    expect(loginFilterForRole(undefined)).toEqual({});
  });

  it('gives every registered account type a usable filter', () => {
    // Guards the case where a new account type is added to ACCOUNTS but the
    // helper is not taught about it.
    for (const { role } of ACCOUNTS) {
      expect(typeof loginFilterForRole(role)).toBe('object');
    }
  });
});
