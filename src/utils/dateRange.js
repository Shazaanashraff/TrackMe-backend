// Shared from/to query-param resolver for attendance endpoints. A malformed date
// string used to silently produce an `Invalid Date`, which Mongo's $gte/$lte then
// matched against nothing — the caller got an empty 200 instead of an error
// explaining the param was bad. See issue #55.
const { ApiError } = require('../middleware/errorHandler');

const DEFAULT_RANGE_DAYS = 30;

// A bare date/datetime string (e.g. "2026-08-10" or "2026-08-10T00:00:00") is parsed by the
// Date constructor as UTC, not the caller's local day — a manager in UTC+5:30 asking for
// "today" without an offset silently gets a window shifted by their local offset. Requiring an
// explicit 'Z' or +/-HH:mm offset removes the ambiguity instead of guessing a timezone. See #58.
const OFFSET_OR_Z = /(Z|[+-]\d{2}:?\d{2})$/;

function assertExplicitOffset(raw, label) {
  if (raw && !OFFSET_OR_Z.test(String(raw).trim())) {
    throw new ApiError(400, `"${label}" must include an explicit UTC offset (e.g. a trailing Z)`);
  }
}

function resolveRange(query, { defaultRangeDays = DEFAULT_RANGE_DAYS } = {}) {
  assertExplicitOffset(query?.to, 'to');
  assertExplicitOffset(query?.from, 'from');

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
