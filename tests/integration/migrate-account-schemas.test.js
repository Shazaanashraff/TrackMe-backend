const { selectCanonicalSuperAdmin, stripRole } = require('../../scripts/migrate-account-schemas');

// Pure-function tests for the one-off account-schema migration script's
// super-admin dedup rule — no database needed.

describe('migrate-account-schemas: selectCanonicalSuperAdmin', () => {
  test('returns null kept + empty archived when there are no super-admins', () => {
    const result = selectCanonicalSuperAdmin([], 'canonical@test.com');
    expect(result.kept).toBeNull();
    expect(result.archived).toEqual([]);
  });

  test('keeps the sole super-admin when there is only one', () => {
    const only = { _id: 'a1', email: 'only@test.com', createdAt: new Date('2026-01-01') };
    const result = selectCanonicalSuperAdmin([only], 'canonical@test.com');
    expect(result.kept).toBe(only);
    expect(result.archived).toEqual([]);
  });

  test('prefers the canonical email among duplicates, regardless of creation order', () => {
    const older = { _id: 'a1', email: 'random-old@test.com', createdAt: new Date('2026-01-01') };
    const canonical = { _id: 'a2', email: 'canonical@test.com', createdAt: new Date('2026-02-01') };
    const newer = { _id: 'a3', email: 'random-new@test.com', createdAt: new Date('2026-03-01') };

    const result = selectCanonicalSuperAdmin([older, canonical, newer], 'canonical@test.com');

    expect(result.kept).toBe(canonical);
    expect(result.archived).toEqual([older, newer]);
  });

  test('is case-insensitive when matching the canonical email', () => {
    const doc = { _id: 'a1', email: 'Canonical@Test.com', createdAt: new Date() };
    const result = selectCanonicalSuperAdmin([doc], 'canonical@test.com');
    expect(result.kept).toBe(doc);
  });

  test('falls back to the earliest-created account when no duplicate matches the canonical email', () => {
    const earliest = { _id: 'a1', email: 'first@test.com', createdAt: new Date('2026-01-01') };
    const later = { _id: 'a2', email: 'second@test.com', createdAt: new Date('2026-02-01') };

    const result = selectCanonicalSuperAdmin([later, earliest], 'no-match@test.com');

    expect(result.kept).toBe(earliest);
    expect(result.archived).toEqual([later]);
  });
});

describe('migrate-account-schemas: stripRole', () => {
  test('removes the role field but preserves everything else', () => {
    const doc = { _id: 'a1', email: 'x@test.com', role: 'admin', name: 'X' };
    expect(stripRole(doc)).toEqual({ _id: 'a1', email: 'x@test.com', name: 'X' });
  });

  test('is a no-op when role is already absent', () => {
    const doc = { _id: 'a1', email: 'x@test.com', name: 'X' };
    expect(stripRole(doc)).toEqual(doc);
  });
});
