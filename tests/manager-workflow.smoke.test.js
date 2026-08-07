const test = require('node:test');
const assert = require('node:assert/strict');

test('manager controller exports expected handlers', () => {
  const managerController = require('../src/controllers/managerController');

  const expected = [
    'getManagerDashboard',
    'getManagerVehicles',
    'getManagerVehicleById',
    'updateManagerVehicle',
    'createManagerVehicle',
    'requestVehicleDelete',
    'getMyRequests',
    'resetVehicleAccountPassword',
    'getManagerAssignableRoutes'
  ];

  for (const key of expected) {
    assert.equal(typeof managerController[key], 'function', `${key} should be a function`);
  }
});

test('super-admin controller exports approval and audit handlers', () => {
  const superAdminController = require('../src/controllers/superAdminController');

  const expected = [
    'getPendingVehicleRequests',
    'reviewVehicleRequest',
    'getAuditLogs'
  ];

  for (const key of expected) {
    assert.equal(typeof superAdminController[key], 'function', `${key} should be a function`);
  }
});

test('manager routes module is loadable', () => {
  assert.doesNotThrow(() => {
    const router = require('../src/routes/managerRoutes');
    assert.ok(router, 'router should be defined');
  });
});
