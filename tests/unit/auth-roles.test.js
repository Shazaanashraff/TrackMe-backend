const { requireRoles, requireManagerOrAbove, requireManager, requireSuperAdmin } = require('../../src/middleware/auth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('role-gating middleware (issue #78 rename)', () => {
  test('requireManagerOrAbove admits both the manager (admin) and super-admin roles', () => {
    for (const role of ['admin', 'super-admin']) {
      const req = { user: { role } };
      const res = mockRes();
      const next = jest.fn();

      requireManagerOrAbove(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  test('requireManagerOrAbove rejects a driver or passenger', () => {
    for (const role of ['driver', 'user']) {
      const req = { user: { role } };
      const res = mockRes();
      const next = jest.fn();

      requireManagerOrAbove(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  test('requireManager admits only the manager (admin) role, not super-admin', () => {
    const okReq = { user: { role: 'admin' } };
    const okRes = mockRes();
    const okNext = jest.fn();
    requireManager(okReq, okRes, okNext);
    expect(okNext).toHaveBeenCalled();

    const blockedReq = { user: { role: 'super-admin' } };
    const blockedRes = mockRes();
    const blockedNext = jest.fn();
    requireManager(blockedReq, blockedRes, blockedNext);
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.status).toHaveBeenCalledWith(403);
  });

  test('requireSuperAdmin admits only the super-admin role, not manager', () => {
    const okReq = { user: { role: 'super-admin' } };
    const okRes = mockRes();
    const okNext = jest.fn();
    requireSuperAdmin(okReq, okRes, okNext);
    expect(okNext).toHaveBeenCalled();

    const blockedReq = { user: { role: 'admin' } };
    const blockedRes = mockRes();
    const blockedNext = jest.fn();
    requireSuperAdmin(blockedReq, blockedRes, blockedNext);
    expect(blockedNext).not.toHaveBeenCalled();
  });

  test('requireRoles rejects an unauthenticated request with 401', () => {
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    requireRoles('admin')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
