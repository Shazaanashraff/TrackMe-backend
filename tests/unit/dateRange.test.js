const { resolveRange, DEFAULT_RANGE_DAYS } = require('../../src/utils/dateRange');

describe('resolveRange (issue #58 — explicit UTC offset requirement)', () => {
  test('a "today" query for a non-UTC (UTC+5:30) manager resolves to the correct local-day window', () => {
    const { from, to } = resolveRange({
      from: '2026-08-10T00:00:00+05:30',
      to: '2026-08-10T23:59:59+05:30'
    });

    // Local midnight in Colombo (+05:30) is 18:30 UTC the previous day.
    expect(from.toISOString()).toBe('2026-08-09T18:30:00.000Z');
    // Local end-of-day in Colombo (+05:30) is 18:29:59 UTC the same day.
    expect(to.toISOString()).toBe('2026-08-10T18:29:59.000Z');
  });

  test('rejects a bare date-only "from" with no offset instead of silently treating it as UTC', () => {
    expect(() => resolveRange({ from: '2026-08-10', to: '2026-08-10T23:59:59Z' })).toThrow(
      /explicit UTC offset/
    );
  });

  test('rejects a bare local datetime "to" with no offset', () => {
    expect(() => resolveRange({ from: '2026-08-01T00:00:00Z', to: '2026-08-10T00:00:00' })).toThrow(
      /explicit UTC offset/
    );
  });

  test('accepts a trailing "Z" as an explicit offset', () => {
    const { from, to } = resolveRange({ from: '2026-08-01T00:00:00Z', to: '2026-08-10T00:00:00Z' });
    expect(from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  test('omitting "to" still defaults to now() and omitting "from" defaults to DEFAULT_RANGE_DAYS earlier', () => {
    const { from, to } = resolveRange({});
    const diffDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(DEFAULT_RANGE_DAYS, 5);
  });
});
