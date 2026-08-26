// Per-socket, per-event sliding-window rate limiting for the socket layer.
//
// Extracted from the pre-removal socketHandler so it can be unit-tested without
// standing up a server. A location stream is the one place a client legitimately
// emits many times a second, so the limits are per event rather than global —
// throttling a driver's position at the same rate as their start/stop presses
// would either starve the stream or leave the control events wide open.

const DEFAULT_WINDOW_MS = 1000;

// Chosen against the driver app's actual behaviour, not round numbers.
//
// useLocationBroadcast throttles to one fix per 2.5s, so the steady state is
// well under 1/s. What sets the ceiling is the reconnect: it replays an offline
// buffer of up to MAX_BUFFER_SIZE (50) with no spacing between emits, and the
// whole burst lands inside a single window. A limit at or below that size NACKs
// the tail, the client re-buffers whatever it could not send, and the next
// reconnect replays it again — one dropped connection becomes a permanent
// livelock. So the location limit is the client's buffer size plus headroom;
// it still bounds abuse, just above the largest burst the client can produce.
const LIMITS = {
  'driver:start-tracking': 2,
  'driver:stop-tracking': 2,
  'driver:location': 60,
  'vehicle:subscribe': 5,
  'vehicle:unsubscribe': 5
};

const DEFAULT_LIMIT = 10;

const buckets = new Map();

function limitFor(event) {
  return LIMITS[event] ?? DEFAULT_LIMIT;
}

// Returns true when the call is allowed and records it; false when the socket
// has already spent its allowance for this event in the current window.
function check(socketId, event, maxPerSecond = limitFor(event), windowMs = DEFAULT_WINDOW_MS) {
  const key = `${socketId}:${event}`;
  const now = Date.now();
  const times = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (times.length >= maxPerSecond) {
    buckets.set(key, times);
    return false;
  }

  times.push(now);
  buckets.set(key, times);
  return true;
}

// Drops empty windows so a long-lived process does not accumulate one entry per
// socket that ever connected.
function cleanup(windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();
  for (const [key, times] of buckets.entries()) {
    if (times.filter((t) => now - t < windowMs).length === 0) buckets.delete(key);
  }
}

// Called on disconnect: a socket id is never reused, so its buckets are garbage
// the moment it goes away.
function forget(socketId) {
  const prefix = `${socketId}:`;
  for (const key of buckets.keys()) {
    if (key.startsWith(prefix)) buckets.delete(key);
  }
}

function reset() {
  buckets.clear();
}

module.exports = { check, cleanup, forget, reset, limitFor, LIMITS };
