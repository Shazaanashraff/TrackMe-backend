// Confirms every id the caller asked for was actually found, tolerant of duplicate ids in the
// request. A plain `foundDocs.length !== requestedIds.length` comparison (the bug in #82) only
// works by coincidence: a duplicated valid id inflates requestedIds.length past the number of
// unique documents Mongo's $in actually returns, producing a false validation failure.
const allRequestedIdsFound = (requestedIds, foundDocs) => {
  const uniqueRequested = new Set(requestedIds.map(String));
  const foundIds = new Set(foundDocs.map((doc) => String(doc._id)));

  for (const id of uniqueRequested) {
    if (!foundIds.has(id)) return false;
  }
  return true;
};

module.exports = { allRequestedIdsFound };
