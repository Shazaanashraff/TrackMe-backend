module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.js'],
  testTimeout: 30000,
  // Integration tests share a single MongoDB; run serially to avoid cross-test races.
  maxWorkers: 1,
  forceExit: true,
};
