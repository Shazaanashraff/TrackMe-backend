const { graceMs, isDue } = require('../../src/services/accountDeletion');

// ACCOUNT_DELETION_GRACE_DAYS: unset or blank means the default 3 days; 0 is a
// real value (used to try the purge locally); anything invalid falls back.
const DAY = 24 * 60 * 60 * 1000;

describe('account deletion grace period', () => {
  const original = process.env.ACCOUNT_DELETION_GRACE_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.ACCOUNT_DELETION_GRACE_DAYS;
    else process.env.ACCOUNT_DELETION_GRACE_DAYS = original;
  });

  it.each([
    [undefined, 3 * DAY],
    ['', 3 * DAY],
    ['  ', 3 * DAY],
    ['7', 7 * DAY],
    ['0', 0],
    ['-1', 3 * DAY],
    ['soon', 3 * DAY]
  ])('ACCOUNT_DELETION_GRACE_DAYS=%p gives %p ms', (value, expected) => {
    if (value === undefined) delete process.env.ACCOUNT_DELETION_GRACE_DAYS;
    else process.env.ACCOUNT_DELETION_GRACE_DAYS = value;
    expect(graceMs()).toBe(expected);
  });

  it('isDue only once purgeAt has passed', () => {
    expect(isDue({ deletion: { purgeAt: null } })).toBe(false);
    expect(isDue({ deletion: { purgeAt: new Date(Date.now() + 1000) } })).toBe(false);
    expect(isDue({ deletion: { purgeAt: new Date(Date.now() - 1000) } })).toBe(true);
    expect(isDue(null)).toBe(false);
  });
});
