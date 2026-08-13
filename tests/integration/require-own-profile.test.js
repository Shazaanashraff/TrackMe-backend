const mongoose = require('mongoose');
const User = require('../../src/models/User');
const Identity = require('../../src/models/Identity');
const { requireOwnProfile, requirePrimaryProfile } = require('../../src/middleware/auth');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// requireOwnProfile is the guard that decides whether a caller may act on a
// given rider profile — the single most important authz boundary this
// feature introduces. Tested directly against the middleware function rather
// than through an HTTP route, since the /api/profiles routes it will guard
// don't exist yet (Phase 3).

const fakeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

let identityA;
let identityB;
let primaryA;
let childOfA;
let primaryB;

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await clearTestDb();

  identityA = await Identity.create({ email: `a-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
  identityB = await Identity.create({ email: `b-${Date.now()}@t.com`, password: 'P@ssw0rd!' });

  primaryA = await User.create({
    name: 'Parent A', identityId: identityA._id, email: identityA.email, profileKind: 'PRIMARY'
  });
  childOfA = await User.create({
    name: 'Child of A', identityId: identityA._id, profileKind: 'MANAGED'
  });
  primaryB = await User.create({
    name: 'Parent B', identityId: identityB._id, email: identityB.email, profileKind: 'PRIMARY'
  });
});

describe('requireOwnProfile', () => {
  const run = async (identityId, targetId) => {
    const req = { identityId, params: { id: String(targetId) } };
    const res = fakeRes();
    const next = jest.fn();
    await requireOwnProfile()(req, res, next);
    return { req, res, next };
  };

  it('admits the caller reading their own managed profile', async () => {
    const { res, next, req } = await run(identityA._id, childOfA._id);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(String(req.targetProfile._id)).toBe(String(childOfA._id));
  });

  it('admits the caller reading their own primary profile', async () => {
    const { res, next } = await run(identityA._id, primaryA._id);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('404s when the profile belongs to a different identity', async () => {
    const { res, next } = await run(identityB._id, childOfA._id);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404s for a profile id that does not exist', async () => {
    const { res, next } = await run(identityA._id, new mongoose.Types.ObjectId());
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404s for a soft-deleted profile', async () => {
    childOfA.deletedAt = new Date();
    await childOfA.save();

    const { res, next } = await run(identityA._id, childOfA._id);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404s when the caller has no identityId at all', async () => {
    const { res, next } = await run(null, childOfA._id);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // The regression this guard exists to prevent: two pre-migration profiles
  // that both lack an identityId must never be treated as belonging to each
  // other just because `undefined === undefined`. Without the explicit falsy
  // check on both sides, this test fails with next() called and a 200 that
  // hands one legacy account's profile to a completely unrelated caller.
  it('never matches on two missing identityIds (the null-equality hole)', async () => {
    const orphanCaller = await User.create({ name: 'Orphan Caller', profileKind: 'PRIMARY', email: 'orphan-caller@t.com' });
    const orphanTarget = await User.create({ name: 'Orphan Target', profileKind: 'PRIMARY', email: 'orphan-target@t.com' });
    // Neither has an identityId (pre-migration shape) — this is the state
    // requireOwnProfile must refuse, not silently match.
    expect(orphanCaller.identityId).toBeUndefined();
    expect(orphanTarget.identityId).toBeUndefined();

    const { res, next } = await run(null, orphanTarget._id);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    void orphanCaller; // present only to document the scenario, not queried directly
  });
});

describe('requirePrimaryProfile', () => {
  const run = (user) => {
    const req = { user };
    const res = fakeRes();
    const next = jest.fn();
    requirePrimaryProfile(req, res, next);
    return { req, res, next };
  };

  it('admits the primary profile', () => {
    const { res, next } = run({ role: 'user', profileKind: 'PRIMARY' });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a managed profile with MANAGED_PROFILE_FORBIDDEN', () => {
    const { res, next } = run({ role: 'user', profileKind: 'MANAGED' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MANAGED_PROFILE_FORBIDDEN' }));
  });

  it('rejects when there is no req.user at all', () => {
    const { res, next } = run(null);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a non-user role even if profileKind is somehow set', () => {
    const { res, next } = run({ role: 'driver', profileKind: 'PRIMARY' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
