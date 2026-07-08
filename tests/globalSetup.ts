import { MongoMemoryServer } from 'mongodb-memory-server';

// Jest globalSetup runs ONCE in the Node main process (not inside the jest VM
// sandbox). This is where we start a single shared in-memory MongoDB for the
// whole run. Starting/stopping the server here keeps mongodb-memory-server's
// process management (which relies on globals like setTimeout) in the real Node
// runtime, avoiding the Node 26 teardown crash that occurs when stop() runs
// inside the sandboxed jest VM during afterAll.
export default async function globalSetup(): Promise<void> {
  const instance = await MongoMemoryServer.create();
  const uri = instance.getUri();

  // Stash the instance so globalTeardown can stop the same server.
  (globalThis as any).__MONGOINSTANCE = instance;

  // Expose the URI to every worker process. testSetup.ts (setupFilesAfterEnv)
  // and src/config/db.ts both read these env vars to connect mongoose.
  process.env.MONGODB_URI = uri;
  process.env.TEST_MONGODB_URI = uri;
}
