const jwt = require('jsonwebtoken');

// The handshake middleware labelled every failure "Invalid token", database
// errors included, so the apps answered a server hiccup by burning token
// refreshes. Only a token problem may say "Invalid token"; anything else says
// "Server unavailable" and the apps retry the connection instead.
// No database: the account lookup is mocked, the token is signed here.

const mockFindAccountById = jest.fn();
jest.mock('../../src/utils/accountRegistry', () => ({
  ...jest.requireActual('../../src/utils/accountRegistry'),
  findAccountById: (...args) => mockFindAccountById(...args),
}));
jest.mock('../../src/utils/liveVehicles', () => ({ startSweeper: jest.fn() }));
jest.mock('../../src/socket/liveTracking', () => ({ registerLiveTracking: jest.fn() }));

const setupSocket = require('../../src/socket/socketHandler');

const SECRET = 'socket-auth-errors-test-secret';
let middleware;
let errorSpy;

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  const io = {
    use: (fn) => {
      middleware = fn;
    },
    on: jest.fn(),
    to: () => ({ emit: jest.fn() }),
  };
  setupSocket(io);
});

beforeEach(() => {
  mockFindAccountById.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

async function handshake(token) {
  const socket = { handshake: { auth: { token } } };
  const next = jest.fn();
  await middleware(socket, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { socket, error: next.mock.calls[0][0] };
}

const accessToken = () =>
  jwt.sign({ id: 'driver-1', role: 'driver' }, SECRET, { algorithm: 'HS256', expiresIn: '15m' });

describe('socket handshake auth errors', () => {
  it('answers Server unavailable when the account lookup fails, not Invalid token', async () => {
    mockFindAccountById.mockRejectedValue(new Error('connection pool closed'));

    const { error } = await handshake(accessToken());

    expect(error.message).toBe('Server unavailable');
    expect(errorSpy).toHaveBeenCalledWith('❌ Socket auth lookup failed:', 'connection pool closed');
  });

  it('answers Invalid token: jwt malformed for a bad token, without a lookup', async () => {
    const { error } = await handshake('not-a-jwt');

    expect(error.message).toBe('Invalid token: jwt malformed');
    expect(mockFindAccountById).not.toHaveBeenCalled();
  });

  it('answers Invalid token: jwt expired for an expired token', async () => {
    const expired = jwt.sign({ id: 'driver-1', role: 'driver', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, {
      algorithm: 'HS256',
    });

    const { error } = await handshake(expired);

    expect(error.message).toBe('Invalid token: jwt expired');
  });

  it('answers Invalid token: account is deactivated for a deactivated account', async () => {
    mockFindAccountById.mockResolvedValue({ doc: { isActive: false } });

    const { error } = await handshake(accessToken());

    expect(error.message).toBe('Invalid token: account is deactivated');
  });

  it('lets an active account through', async () => {
    mockFindAccountById.mockResolvedValue({ doc: { isActive: true } });

    const { socket, error } = await handshake(accessToken());

    expect(error).toBeUndefined();
    expect(socket.userId).toBe('driver-1');
    expect(socket.userRole).toBe('driver');
  });
});
