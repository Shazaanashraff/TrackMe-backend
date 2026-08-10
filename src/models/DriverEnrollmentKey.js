const mongoose = require('mongoose');

// One reversible enrollment key per driver. The plaintext key is never stored:
// `lookupHash` is an HMAC used to find a driver from a scanned/typed key, and
// the AES-256-GCM fields let a manager reveal the key again later.
// All secret material is `select: false` so it can never leak through a
// stray .find() — the util re-selects it explicitly when it needs to decrypt.
const driverEnrollmentKeySchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
      unique: true
    },
    lookupHash: { type: String, required: true, unique: true, select: false },
    ciphertext: { type: String, required: true, select: false },
    iv: { type: String, required: true, select: false },
    authTag: { type: String, required: true, select: false },
    rotatedAt: { type: Date, default: Date.now },

    // The key this one replaced, kept so a manager who rotated by accident can
    // undo it exactly once. Deliberately NOT indexed on lookupHash: only the
    // top-level field is consulted when a passenger enrols, so the superseded
    // key stops working the moment it lands here, and starts working again only
    // if it is promoted back. Cleared on revert, and overwritten on each
    // rotation, so at most one key is ever recoverable.
    previous: {
      type: new mongoose.Schema(
        {
          lookupHash: { type: String, required: true },
          ciphertext: { type: String, required: true },
          iv: { type: String, required: true },
          authTag: { type: String, required: true },
          replacedAt: { type: Date, default: Date.now }
        },
        { _id: false }
      ),
      required: false,
      select: false
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DriverEnrollmentKey', driverEnrollmentKeySchema);
