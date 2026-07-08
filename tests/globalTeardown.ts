import type { MongoMemoryServer } from 'mongodb-memory-server';

// Jest globalTeardown runs ONCE in the Node main process after all suites
// finish. Stopping the shared in-memory MongoDB here (rather than in an
// afterAll inside a worker) keeps mongodb-memory-server's killProcess in the
// real Node runtime where setTimeout exists, fixing the Node 26 teardown crash.
export default async function globalTeardown(): Promise<void> {
  const instance = (globalThis as any).__MONGOINSTANCE as MongoMemoryServer | undefined;
  if (instance) {
    await instance.stop();
  }
}
