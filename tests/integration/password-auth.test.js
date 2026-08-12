const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const applyPasswordAuth = require('../../src/models/shared/passwordAuth');

// Pure schema-level tests — no MongoDB connection. `applyPasswordAuth` is shared by
// `Identity` (which owns credentials) and the four profile models (dormant during the
// identity migration), so a regression here breaks every login in the system.

const buildSchema = () => applyPasswordAuth(new mongoose.Schema({ password: String }));

describe('applyPasswordAuth — comparePassword', () => {
  const compareOn = async (doc, candidate) => {
    const { comparePassword } = buildSchema().methods;
    return comparePassword.call(doc, candidate);
  };

  test('returns true for the correct password', async () => {
    const doc = { password: await bcrypt.hash('P@ssw0rd!', 12) };
    expect(await compareOn(doc, 'P@ssw0rd!')).toBe(true);
  });

  test('returns false for the wrong password', async () => {
    const doc = { password: await bcrypt.hash('P@ssw0rd!', 12) };
    expect(await compareOn(doc, 'not-the-password')).toBe(false);
  });

  test('returns false instead of throwing when the account has no password', async () => {
    // A Google-only identity has `password === undefined`. bcrypt.compare throws on
    // an undefined hash, which would surface as a 500 rather than a failed login.
    expect(await compareOn({ password: undefined }, 'anything')).toBe(false);
    expect(await compareOn({ password: null }, 'anything')).toBe(false);
    expect(await compareOn({ password: '' }, 'anything')).toBe(false);
  });
});

describe('applyPasswordAuth — hashing hook', () => {
  // Invoke the registered pre-save hook directly against a stand-in document.
  const runHook = async (doc) => {
    const schema = buildSchema();
    const hook = schema.s.hooks._pres.get('save').find((h) => h.fn.name === 'hashPassword');
    await new Promise((resolve, reject) => {
      hook.fn.call(doc, (err) => (err ? reject(err) : resolve()));
    });
    return doc;
  };

  test('hashes a modified password to a verifiable bcrypt digest', async () => {
    const doc = await runHook({ password: 'P@ssw0rd!', isModified: () => true });
    expect(doc.password).not.toBe('P@ssw0rd!');
    expect(await bcrypt.compare('P@ssw0rd!', doc.password)).toBe(true);
  });

  test('leaves an untouched password alone so it is never double-hashed', async () => {
    // This is the guard that keeps a re-save (e.g. storing a refresh-token hash)
    // from re-hashing an already-hashed password and locking the account out.
    const alreadyHashed = await bcrypt.hash('P@ssw0rd!', 12);
    const doc = await runHook({ password: alreadyHashed, isModified: () => false });
    expect(doc.password).toBe(alreadyHashed);
    expect(await bcrypt.compare('P@ssw0rd!', doc.password)).toBe(true);
  });
});
