module.exports = {
  testEnvironment: 'node',
  // tests/unit holds pure-function suites that need no database; the integration
  // suites below need the Mongo at MONGODB_TEST_URI.
  testMatch: ['**/tests/unit/**/*.test.js', '**/tests/integration/**/*.test.js'],
  testTimeout: 30000,
  // Integration tests share a single MongoDB; run serially to avoid cross-test races.
  maxWorkers: 1,
  forceExit: true,
  setupFiles: ['<rootDir>/tests/jest.setup.js'],
};
