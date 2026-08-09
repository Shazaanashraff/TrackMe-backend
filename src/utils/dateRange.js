// Shared from/to query-param resolver for attendance endpoints. A malformed date
// string used to silently produce an `Invalid Date`, which Mongo's $gte/$lte then
// matched against nothing — the caller got an empty 200 instead of an error
// explaining the param was bad. See issue #55.
const { ApiError } = require('../middleware/errorHandler');

const DEFAULT_RANGE_DAYS = 30;

function resolveRange(query, { defaultRangeDays = DEFAULT_RANGE_DAYS } = {}) {
  const to = query?.to ? new Date(query.to) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new ApiError(400, 'Invalid "to" date');
  }

  const from = query?.from
    ? new Date(query.from)
    : new Date(to.getTime() - defaultRangeDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) {
    throw new ApiError(400, 'Invalid "from" date');
  }

  return { from, to };
}

module.exports = { resolveRange, DEFAULT_RANGE_DAYS };
