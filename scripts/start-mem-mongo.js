const { MongoMemoryServer } = require('mongodb-memory-server');
(async () => {
  const mongod = await MongoMemoryServer.create();
  console.log('MONGO_URI=' + mongod.getUri());
  console.log('READY');
  process.stdin.resume();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
