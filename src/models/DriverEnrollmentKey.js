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
    rotatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DriverEnrollmentKey', driverEnrollmentKeySchema);
