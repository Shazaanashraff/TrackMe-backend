const bcrypt = require('bcryptjs');

// Password hashing + verification, extracted from accountFields.js so the new
// `Identity` model (which owns credentials) and the four profile models (whose
// credential fields are dormant during the identity migration) can share one
// implementation. Nothing that calls `doc.comparePassword(...)` needs to know
// which of the two it is holding.
//
// IMPORTANT: the pre-save hook means any write through Mongoose re-hashes a
// modified `password`. Bulk-loading already-hashed passwords (as the identity
// migration does) MUST bypass this via the raw driver — going through Mongoose
// would double-hash and lock every user out.
const applyPasswordAuth = (schema) => {
  schema.pre('save', async function hashPassword(next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
  });

  schema.methods.comparePassword = async function comparePassword(candidatePassword) {
    // A Google-only account has no password at all; treat that as "no match"
    // rather than letting bcrypt throw on an undefined hash.
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
  };

  return schema;
};

module.exports = applyPasswordAuth;
