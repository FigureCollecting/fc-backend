import mongoose from 'mongoose';
import SyncJob from '../../src/models/SyncJob';
import { StaleSessionMonitor } from '../../src/services/staleSessionMonitor';

describe('StaleSessionMonitor', () => {
  let testUserId: mongoose.Types.ObjectId;

  beforeEach(() => {
    testUserId = new mongoose.Types.ObjectId();
  });

  describe('checkForStaleSessions', () => {
    it('should return 0 when no active jobs exist', async () => {
      const monitor = new StaleSessionMonitor({ staleThresholdMs: 1000 });
      const count = await monitor.checkForStaleSessions();
      expect(count).toBe(0);
    });

    it('should not mark recently updated active jobs as stale', async () => {
      // Create a job that was just updated (not stale)
      await SyncJob.create({
        userId: testUserId,
        sessionId: 'recent-session',
        phase: 'enriching',
        message: 'Processing items...',
        items: [
          { mfcId: '100', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ],
        stats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 }
      });

      // Threshold of 30 minutes - job was just created so it's fresh
      const monitor = new StaleSessionMonitor({ staleThresholdMs: 30 * 60 * 1000 });
      const count = await monitor.checkForStaleSessions();

      expect(count).toBe(0);

      // Verify job is unchanged
      const job = await SyncJob.findOne({ sessionId: 'recent-session' });
      expect(job!.phase).toBe('enriching');
    });

    it('should mark stale active jobs as failed', async () => {
      // Create a job and manually set updatedAt to the past
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'stale-session',
        phase: 'enriching',
        message: 'Processing items...',
        items: [
          { mfcId: '100', status: 'pending', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '200', status: 'processing', collectionStatus: 'wished', retryCount: 0 },
          { mfcId: '300', status: 'completed', collectionStatus: 'owned', retryCount: 0 }
        ],
        stats: { total: 3, pending: 1, processing: 1, completed: 1, failed: 0, skipped: 0 }
      });

      // Force updatedAt to 1 hour ago (bypass Mongoose timestamps)
      await SyncJob.collection.updateOne(
        { sessionId: 'stale-session' },
        { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } }
      );

      // Use a 5-minute threshold
      const monitor = new StaleSessionMonitor({ staleThresholdMs: 5 * 60 * 1000 });
      const count = await monitor.checkForStaleSessions();

      expect(count).toBe(1);

      // Verify the job was marked as failed
      const updatedJob = await SyncJob.findOne({ sessionId: 'stale-session' });
      expect(updatedJob!.phase).toBe('failed');
      expect(updatedJob!.completedAt).toBeDefined();
      expect(updatedJob!.message).toContain('timed out');

      // Verify pending/processing items were failed, but completed items preserved
      const pendingItem = updatedJob!.items.find(i => i.mfcId === '100');
      expect(pendingItem!.status).toBe('failed');
      expect(pendingItem!.error).toContain('Timed out');

      const processingItem = updatedJob!.items.find(i => i.mfcId === '200');
      expect(processingItem!.status).toBe('failed');
      expect(processingItem!.error).toContain('Timed out');

      const completedItem = updatedJob!.items.find(i => i.mfcId === '300');
      expect(completedItem!.status).toBe('completed');

      // Stats should reflect the updates
      expect(updatedJob!.stats.failed).toBe(2);
      expect(updatedJob!.stats.completed).toBe(1);
      expect(updatedJob!.stats.pending).toBe(0);
      expect(updatedJob!.stats.processing).toBe(0);
    });

    it('should not mark completed/failed/cancelled jobs as stale', async () => {
      // Create jobs in terminal states with old updatedAt
      for (const phase of ['completed', 'failed', 'cancelled'] as const) {
        const job = await SyncJob.create({
          userId: testUserId,
          sessionId: `terminal-${phase}`,
          phase,
          message: `Job ${phase}`,
          completedAt: new Date()
        });
        // Force old updatedAt
        await SyncJob.collection.updateOne(
          { sessionId: `terminal-${phase}` },
          { $set: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
        );
      }

      const monitor = new StaleSessionMonitor({ staleThresholdMs: 1000 });
      const count = await monitor.checkForStaleSessions();

      expect(count).toBe(0);
    });

    it('should handle multiple stale sessions', async () => {
      // Create 3 stale jobs
      for (let i = 1; i <= 3; i++) {
        await SyncJob.create({
          userId: testUserId,
          sessionId: `stale-${i}`,
          phase: 'enriching',
          items: [
            { mfcId: `${i}00`, status: 'pending', collectionStatus: 'owned', retryCount: 0 }
          ],
          stats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 }
        });
        await SyncJob.collection.updateOne(
          { sessionId: `stale-${i}` },
          { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } }
        );
      }

      const monitor = new StaleSessionMonitor({ staleThresholdMs: 5 * 60 * 1000 });
      const count = await monitor.checkForStaleSessions();

      expect(count).toBe(3);

      // Verify all were marked failed
      for (let i = 1; i <= 3; i++) {
        const job = await SyncJob.findOne({ sessionId: `stale-${i}` });
        expect(job!.phase).toBe('failed');
      }
    });

    it('should call onSessionMarkedStale callback for each stale session', async () => {
      const markedStale: string[] = [];

      await SyncJob.create({
        userId: testUserId,
        sessionId: 'callback-test',
        phase: 'enriching',
        items: [
          { mfcId: '100', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ],
        stats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 }
      });
      await SyncJob.collection.updateOne(
        { sessionId: 'callback-test' },
        { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } }
      );

      const monitor = new StaleSessionMonitor({
        staleThresholdMs: 5 * 60 * 1000,
        onSessionMarkedStale: (sessionId) => markedStale.push(sessionId)
      });

      await monitor.checkForStaleSessions();

      expect(markedStale).toEqual(['callback-test']);
    });

    it('should handle jobs in any active phase (not just enriching)', async () => {
      const activePhases = ['validating', 'exporting', 'parsing', 'fetching_lists', 'queueing', 'enriching'] as const;

      for (const phase of activePhases) {
        await SyncJob.create({
          userId: testUserId,
          sessionId: `phase-${phase}`,
          phase,
          message: `Stuck in ${phase}`
        });
        await SyncJob.collection.updateOne(
          { sessionId: `phase-${phase}` },
          { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } }
        );
      }

      const monitor = new StaleSessionMonitor({ staleThresholdMs: 5 * 60 * 1000 });
      const count = await monitor.checkForStaleSessions();

      expect(count).toBe(activePhases.length);

      for (const phase of activePhases) {
        const job = await SyncJob.findOne({ sessionId: `phase-${phase}` });
        expect(job!.phase).toBe('failed');
        expect(job!.message).toContain('timed out');
      }
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', () => {
      const monitor = new StaleSessionMonitor({
        checkIntervalMs: 60000,
        staleThresholdMs: 30 * 60 * 1000
      });

      // Start should not throw
      monitor.start();

      // Stop should not throw
      monitor.stop();
    });

    it('should handle multiple start calls gracefully', () => {
      const monitor = new StaleSessionMonitor({ checkIntervalMs: 60000 });

      monitor.start();
      monitor.start(); // Should not create duplicate intervals

      monitor.stop();
    });

    it('should handle stop when not started', () => {
      const monitor = new StaleSessionMonitor();
      // Should not throw
      monitor.stop();
    });

    it('should catch and log errors from checkForStaleSessions in the interval', async () => {
      jest.useFakeTimers();

      const monitor = new StaleSessionMonitor({
        checkIntervalMs: 100,
        staleThresholdMs: 1000
      });

      // Spy on checkForStaleSessions and make it reject
      const checkSpy = jest
        .spyOn(monitor, 'checkForStaleSessions')
        .mockRejectedValue(new Error('DB connection lost'));

      monitor.start();

      // Advance past the interval to trigger the callback
      jest.advanceTimersByTime(150);

      // Allow the promise rejection to be caught by the .catch handler
      // Need to flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(checkSpy).toHaveBeenCalledTimes(1);

      monitor.stop();
      checkSpy.mockRestore();
      jest.useRealTimers();
    });
  });
});
