const {
  selectRoleForAudience,
  assertShareable,
  SuperAdminIsolationError
} = require('../../src/utils/identityRegistry');

// Pure resolution logic — no MongoDB. These two functions decide which app a person
// may sign into and which roles may share a login, so they are the security core of
// the identity model.

describe('selectRoleForAudience', () => {
  test.each([
    [['user'], 'user', 'user'],
    [['user'], 'rider', 'user'],
    [['driver'], 'driver', 'driver'],
    [['admin'], 'admin', 'admin'],
    [['admin'], 'web-admin', 'admin'],
    [['super-admin'], 'web-admin', 'super-admin'],
    [['user', 'driver'], 'driver', 'driver'],
    [['user', 'driver'], 'user', 'user'],
    [['user', 'driver', 'admin'], 'web-admin', 'admin']
  ])('roles %p asking as %s resolves to %s', (roles, audience, expected) => {
    expect(selectRoleForAudience(roles, audience)).toBe(expected);
  });

  test('a super-admin outranks a manager in the shared admin portal', () => {
    expect(selectRoleForAudience(['admin', 'super-admin'], 'web-admin')).toBe('super-admin');
  });

  test('returns null when the person holds no profile for that app', () => {
    // The caller turns this into 403 NO_PROFILE_FOR_APP — "this login has no driver
    // account" — rather than a misleading wrong-password error.
    expect(selectRoleForAudience(['user'], 'driver')).toBeNull();
    expect(selectRoleForAudience(['driver'], 'user')).toBeNull();
    expect(selectRoleForAudience(['user'], 'web-admin')).toBeNull();
    expect(selectRoleForAudience([], 'user')).toBeNull();
  });

  test('returns null for an unrecognised audience rather than falling back', () => {
    expect(selectRoleForAudience(['user'], 'not-an-app')).toBeNull();
  });

  test('handles a missing role list without throwing', () => {
    expect(selectRoleForAudience(undefined, 'user')).toBeNull();
  });

  describe('legacy fallback when no audience is sent', () => {
    // Reproduces exactly what findAccountByEmail did (scan super-admin, admin, driver,
    // user and take the first hit) so app builds released before this change keep
    // working during the staged rollout.
    test('resolves a single-role person the same way as before', () => {
      expect(selectRoleForAudience(['user'], undefined)).toBe('user');
      expect(selectRoleForAudience(['driver'], null)).toBe('driver');
    });

    test('prefers the higher-privilege role for a multi-role person', () => {
      // THIS is why user-app's role gate must ship before shared identities are
      // enabled: an old rider-app build sending no audience would be handed a driver
      // session for someone who is both.
      expect(selectRoleForAudience(['user', 'driver'], undefined)).toBe('driver');
      expect(selectRoleForAudience(['user', 'admin'], undefined)).toBe('admin');
    });
  });
});

describe('assertShareable — super-admin isolation', () => {
  test('allows a fresh identity to become a super-admin', () => {
    expect(assertShareable([], 'super-admin')).toBe(true);
  });

  test('allows rider, driver and manager to share one login', () => {
    expect(assertShareable(['user'], 'driver')).toBe(true);
    expect(assertShareable(['user'], 'admin')).toBe(true);
    expect(assertShareable(['user', 'driver'], 'admin')).toBe(true);
    expect(assertShareable(['driver'], 'user')).toBe(true);
  });

  test('refuses to make an existing account a super-admin', () => {
    expect(() => assertShareable(['user'], 'super-admin')).toThrow(SuperAdminIsolationError);
    expect(() => assertShareable(['driver'], 'super-admin')).toThrow(/dedicated email/i);
  });

  test('refuses to add any role to a super-admin login', () => {
    expect(() => assertShareable(['super-admin'], 'user')).toThrow(SuperAdminIsolationError);
    expect(() => assertShareable(['super-admin'], 'driver')).toThrow(/cannot take on additional roles/i);
    expect(() => assertShareable(['super-admin'], 'admin')).toThrow(SuperAdminIsolationError);
  });

  test('the thrown error carries a machine-readable code', () => {
    expect.assertions(1);
    try {
      assertShareable(['user'], 'super-admin');
    } catch (err) {
      expect(err.code).toBe('SUPER_ADMIN_ISOLATED');
    }
  });
});
