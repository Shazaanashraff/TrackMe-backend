const rateLimit = require('../../src/utils/socketRateLimit');

// The limiter guards a stream a real client bursts on, so the cases that matter
// are the window boundary and the per-event separation — a shared bucket would
// let a location burst starve the start/stop presses.

beforeEach(() => rateLimit.reset());

describe('socketRateLimit', () => {
  it('allows up to the limit and refuses the one after', () => {
    const limit = rateLimit.limitFor('vehicle:subscribe');
    for (let i = 0; i < limit; i += 1) {
      expect(rateLimit.check('sock-1', 'vehicle:subscribe')).toBe(true);
    }
    expect(rateLimit.check('sock-1', 'vehicle:subscribe')).toBe(false);
  });

  it('counts each event separately', () => {
    const limit = rateLimit.limitFor('driver:start-tracking');
    for (let i = 0; i < limit; i += 1) rateLimit.check('sock-1', 'driver:start-tracking');

    expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(false);
    expect(rateLimit.check('sock-1', 'driver:location')).toBe(true);
  });

  it('counts each socket separately', () => {
    const limit = rateLimit.limitFor('driver:start-tracking');
    for (let i = 0; i < limit; i += 1) rateLimit.check('sock-1', 'driver:start-tracking');

    expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(false);
    expect(rateLimit.check('sock-2', 'driver:start-tracking')).toBe(true);
  });

  it('lets the allowance recover once the window passes', () => {
    jest.useFakeTimers();
    try {
      const limit = rateLimit.limitFor('driver:start-tracking');
      for (let i = 0; i < limit; i += 1) rateLimit.check('sock-1', 'driver:start-tracking');
      expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(false);

      jest.advanceTimersByTime(1100);
      expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('admits a full offline-buffer replay without a single refusal', () => {
    // 50 is MAX_BUFFER_SIZE in the driver app's useLocationBroadcast. Every one
    // of these must be accepted, or the client re-buffers the remainder and
    // replays it on the next reconnect, forever.
    const results = [];
    for (let i = 0; i < 50; i += 1) {
      results.push(rateLimit.check('sock-1', 'driver:location'));
    }
    expect(results.every(Boolean)).toBe(true);
  });

  it('forgets a socket entirely on disconnect', () => {
    const limit = rateLimit.limitFor('driver:start-tracking');
    for (let i = 0; i < limit; i += 1) rateLimit.check('sock-1', 'driver:start-tracking');
    expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(false);

    rateLimit.forget('sock-1');
    expect(rateLimit.check('sock-1', 'driver:start-tracking')).toBe(true);
  });
});
