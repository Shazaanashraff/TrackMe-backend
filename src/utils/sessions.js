const { ACCOUNTS } = require('./accountRegistry');

// Ends sessions for the profiles one person (an Identity) holds.
//
// Two things make a session: the refresh token stored on the profile, and the
// short-lived access token in the app's hands. Clearing the refresh token stops
// the next refresh; bumping `sessionVersion` stops the access token on its next
// request (middleware/auth.js) and at the next socket handshake. Sockets that
// are already open are dropped here, so they reconnect and meet the same check.
//
// `roles` limits the revoke to some of this person's roles: deleting a rider
// account must leave their driver or manager sessions alone. `keepSocketsOf`
// spares one profile's open sockets, for the caller of a password change who
// stays signed in with a fresh token; disconnecting them would race the client
// storing that token.
const roomFor = (role, id) => `${role === 'driver' ? 'driver' : 'account'}:${id}`;

const revokeSessions = async (identityId, { roles = null, io = null, keepSocketsOf = null } = {}) => {
  if (!identityId) return [];
  const targets = ACCOUNTS.filter(({ role }) => !roles || roles.includes(role));

  const revoked = (await Promise.all(targets.map(async ({ role, model }) => {
    const ids = await model.find({ identityId }).distinct('_id');
    if (!ids.length) return [];
    await model.updateMany(
      { _id: { $in: ids } },
      {
        $inc: { sessionVersion: 1 },
        $set: { 'refreshToken.tokenHash': null, 'refreshToken.expiresAt': null }
      }
    );
    return ids.map((id) => ({ role, id: String(id) }));
  }))).flat();

  if (io) {
    for (const { role, id } of revoked) {
      if (keepSocketsOf && String(keepSocketsOf) === id) continue;
      io.in(roomFor(role, id)).disconnectSockets(true);
    }
  }

  return revoked;
};

module.exports = { revokeSessions };
