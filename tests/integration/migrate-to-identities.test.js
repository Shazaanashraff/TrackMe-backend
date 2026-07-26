const { groupAccountsByEmail, planIdentities } = require('../../scripts/migrate-to-identities');

// Pure planning logic — no MongoDB. This decides which document's password becomes the
// shared Identity's password, so a mistake here silently changes someone's credentials
// or locks them out. The runner that consumes this plan writes via the raw driver on
// purpose, to avoid re-hashing the already-hashed passwords it copies.

const HASH_A = '$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = '$2a$12$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const acct = (overrides = {}) => ({
  _id: overrides._id || Math.random().toString(36).slice(2),
  email: 'rider@test.com',
  password: HASH_A,
  isEmailVerified: true,
  ...overrides
});

const group = (accountsByRole) => groupAccountsByEmail(accountsByRole);

describe('groupAccountsByEmail', () => {
  test('buckets accounts from different collections under one email', () => {
    const groups = group([
      { role: 'user', docs: [acct({ _id: 'u1' })] },
      { role: 'driver', docs: [acct({ _id: 'd1' })] }
    ]);

    expect(groups.size).toBe(1);
    expect(groups.get('rider@test.com').map((m) => m.role)).toEqual(['user', 'driver']);
  });

  test('normalises case and surrounding whitespace', () => {
    const groups = group([
      { role: 'user', docs: [acct({ email: '  Rider@Test.com ' })] },
      { role: 'driver', docs: [acct({ email: 'RIDER@TEST.COM' })] }
    ]);

    expect([...groups.keys()]).toEqual(['rider@test.com']);
    expect(groups.get('rider@test.com')).toHaveLength(2);
  });

  test('ignores documents with no usable email', () => {
    const groups = group([
      { role: 'user', docs: [acct({ email: '' }), acct({ email: null }), acct({ email: undefined })] }
    ]);
    expect(groups.size).toBe(0);
  });

  test('tolerates a collection with no documents', () => {
    expect(group([{ role: 'user', docs: [] }, { role: 'driver' }]).size).toBe(0);
  });
});

describe('planIdentities — the normal case', () => {
  test('maps each unique email to exactly one identity, preserving profile ids', () => {
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ _id: 'u1', email: 'a@test.com' })] },
        { role: 'driver', docs: [acct({ _id: 'd1', email: 'b@test.com' })] }
      ])
    );

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.superAdminViolations).toHaveLength(0);
    expect(plan.identities).toHaveLength(2);
    expect(plan.identities.map((i) => i.email).sort()).toEqual(['a@test.com', 'b@test.com']);
    expect(plan.identities.find((i) => i.email === 'a@test.com').members).toEqual([
      { role: 'user', _id: 'u1' }
    ]);
  });

  test('carries the password across verbatim, without re-hashing it', () => {
    const plan = planIdentities(group([{ role: 'user', docs: [acct({ password: HASH_A })] }]));
    expect(plan.identities[0].password).toBe(HASH_A);
  });

  test('carries in-flight verification and reset state across', () => {
    const emailVerification = { otpHash: 'otp', expiresAt: new Date('2026-07-26') };
    const passwordReset = { resetTokenHash: 'rst' };
    const plan = planIdentities(
      group([{ role: 'user', docs: [acct({ emailVerification, passwordReset })] }])
    );

    expect(plan.identities[0].emailVerification).toEqual(emailVerification);
    expect(plan.identities[0].passwordReset).toEqual(passwordReset);
  });
});

describe('planIdentities — merging an email already shared by two roles', () => {
  test('merges into one identity holding both profiles', () => {
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ _id: 'u1', password: HASH_A })] },
        { role: 'driver', docs: [acct({ _id: 'd1', password: undefined })] }
      ])
    );

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0].password).toBe(HASH_A);
    expect(plan.identities[0].members).toEqual([
      { role: 'user', _id: 'u1' },
      { role: 'driver', _id: 'd1' }
    ]);
  });

  test('an identical hash on both documents is not a conflict', () => {
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ password: HASH_A })] },
        { role: 'driver', docs: [acct({ password: HASH_A })] }
      ])
    );

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.identities[0].password).toBe(HASH_A);
  });

  test('two DIFFERENT passwords is a blocking conflict, never auto-resolved', () => {
    // Picking either one would silently change the other account's password.
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ password: HASH_A })] },
        { role: 'driver', docs: [acct({ password: HASH_B })] }
      ])
    );

    expect(plan.identities).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { email: 'rider@test.com', reason: 'multiple different passwords across roles', roles: ['user', 'driver'] }
    ]);
  });

  test('two different googleIds is a blocking conflict', () => {
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ password: undefined, googleId: 'g1' })] },
        { role: 'driver', docs: [acct({ password: undefined, googleId: 'g2' })] }
      ])
    );

    expect(plan.identities).toHaveLength(0);
    expect(plan.conflicts[0].reason).toBe('multiple different googleIds across roles');
  });

  test('takes the more permissive verification state when merging', () => {
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ isEmailVerified: false, password: HASH_A })] },
        { role: 'driver', docs: [acct({ isEmailVerified: true, password: undefined })] }
      ])
    );
    expect(plan.identities[0].isEmailVerified).toBe(true);
  });
});

describe('planIdentities — super-admin isolation', () => {
  test('refuses to merge a super-admin with any other role', () => {
    const plan = planIdentities(
      group([
        { role: 'super-admin', docs: [acct({ _id: 's1' })] },
        { role: 'user', docs: [acct({ _id: 'u1' })] }
      ])
    );

    expect(plan.identities).toHaveLength(0);
    expect(plan.superAdminViolations).toEqual([
      { email: 'rider@test.com', roles: ['super-admin', 'user'] }
    ]);
  });

  test('a super-admin on its own dedicated email migrates normally', () => {
    const plan = planIdentities(
      group([{ role: 'super-admin', docs: [acct({ _id: 's1', email: 'boss@test.com' })] }])
    );

    expect(plan.superAdminViolations).toHaveLength(0);
    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0].members).toEqual([{ role: 'super-admin', _id: 's1' }]);
  });
});

describe('planIdentities — google-only and idempotency', () => {
  test('a google-only account plans an identity with no password', () => {
    const plan = planIdentities(
      group([{ role: 'user', docs: [acct({ password: undefined, googleId: 'g-123' })] }])
    );

    expect(plan.identities[0].password).toBeNull();
    expect(plan.identities[0].googleId).toBe('g-123');
  });

  test('skips accounts that already have an identityId, so a re-run is a no-op', () => {
    const plan = planIdentities(
      group([{ role: 'user', docs: [acct({ identityId: 'existing-identity' })] }])
    );

    expect(plan.identities).toHaveLength(0);
    expect(plan.alreadyMigrated).toEqual([{ email: 'rider@test.com', roles: ['user'] }]);
  });

  test('a partially-migrated group is re-planned rather than skipped', () => {
    // If a previous run linked the rider but died before the driver, the group must
    // still be processed.
    const plan = planIdentities(
      group([
        { role: 'user', docs: [acct({ _id: 'u1', identityId: 'existing' })] },
        { role: 'driver', docs: [acct({ _id: 'd1', password: undefined })] }
      ])
    );

    expect(plan.alreadyMigrated).toHaveLength(0);
    expect(plan.identities).toHaveLength(1);
  });
});
