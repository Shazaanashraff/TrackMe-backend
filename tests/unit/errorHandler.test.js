const { errorHandler, ApiError } = require('../../src/middleware/errorHandler');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('returns a clean 400 for a Mongoose CastError without leaking the raw value', () => {
    const err = Object.assign(new Error('Cast to ObjectId failed for value "not-an-id" at path "requestId"'), {
      name: 'CastError',
      path: 'requestId',
      value: 'not-an-id'
    });
    const res = mockRes();

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.message).not.toContain('not-an-id');
  });

  test('masks an unhandled 500 error message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('connect ECONNREFUSED 127.0.0.1:27017');
    const res = mockRes();

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toBe('Internal Server Error');
  });

  test('still shows the raw message for an unhandled 500 outside production', () => {
    process.env.NODE_ENV = 'test';
    const err = new Error('connect ECONNREFUSED 127.0.0.1:27017');
    const res = mockRes();

    errorHandler(err, {}, res, () => {});

    expect(res.json.mock.calls[0][0].message).toBe('connect ECONNREFUSED 127.0.0.1:27017');
  });

  test('always shows a deliberate ApiError message, even in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new ApiError(404, 'Manager not found');
    const res = mockRes();

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toBe('Manager not found');
  });
});
