const { validCoord, resolveRecordedAt, roomFor } = require('../../src/socket/liveTracking');

// The two pure decisions the location hot path makes before it touches the
// database: is this a believable position, and is this a believable clock.

describe('roomFor', () => {
  it('keys on the business vehicle id', () => {
    expect(roomFor('VH-001')).toBe('vehicle:VH-001');
  });
});

describe('validCoord', () => {
  it('accepts a real position', () => {
    expect(validCoord(6.9271, 79.8612)).toBe(true);
  });

  it.each([
    ['latitude above range', 90.1, 79.8],
    ['latitude below range', -90.1, 79.8],
    ['longitude above range', 6.9, 180.1],
    ['longitude below range', 6.9, -180.1]
  ])('refuses %s', (_label, lat, lng) => {
    expect(validCoord(lat, lng)).toBe(false);
  });

  it.each([
    ['NaN', NaN, 79.8],
    ['Infinity', Infinity, 79.8],
    ['a non-number', 'here', 79.8]
  ])('refuses %s', (_label, lat, lng) => {
    expect(validCoord(Number(lat), lng)).toBe(false);
  });

  it('refuses null island, which is what a failed fix usually serialises to', () => {
    expect(validCoord(0, 0)).toBe(false);
  });
});

describe('resolveRecordedAt', () => {
  const now = Date.parse('2026-08-14T10:00:00.000Z');

  it('trusts a device clock that is close to the server', () => {
    const recent = now - 3000;
    expect(resolveRecordedAt(recent, now).getTime()).toBe(recent);
  });

  it('falls back to server time when the timestamp is missing', () => {
    expect(resolveRecordedAt(undefined, now).getTime()).toBe(now);
  });

  it('falls back to server time when the device clock is implausible', () => {
    // A phone whose clock is a day fast would otherwise pin itself permanently
    // ahead of every real fix and reject them all as stale.
    expect(resolveRecordedAt(now + 24 * 60 * 60 * 1000, now).getTime()).toBe(now);
    expect(resolveRecordedAt(now - 24 * 60 * 60 * 1000, now).getTime()).toBe(now);
  });

  it('still trusts a timestamp at the edge of tolerance', () => {
    const edge = now - 4 * 60 * 1000;
    expect(resolveRecordedAt(edge, now).getTime()).toBe(edge);
  });
});
