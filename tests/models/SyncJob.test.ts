import mongoose from 'mongoose';
import SyncJob, { ISyncJob, SyncItemStatus, ISyncItem } from '../../src/models/SyncJob';

describe('SyncJob Model', () => {
  let testUserId: mongoose.Types.ObjectId;

  beforeAll(() => {
    testUserId = new mongoose.Types.ObjectId();
  });

  describe('Schema Validation', () => {
    it('should create a SyncJob with required fields', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'test-session-1',
        phase: 'validating',
        message: 'Starting sync...'
      });

      expect(job.userId.toString()).toBe(testUserId.toString());
      expect(job.sessionId).toBe('test-session-1');
      expect(job.phase).toBe('validating');
      expect(job.message).toBe('Starting sync...');
      expect(job.stats).toBeDefined();
      expect(job.items).toEqual([]);
      expect(job.syncErrors).toEqual([]);
      expect(job.includeLists).toEqual(['owned', 'ordered', 'wished']);
      expect(job.skipCached).toBe(false);
      expect(job.startedAt).toBeDefined();
      expect(job.createdAt).toBeDefined();
      expect(job.updatedAt).toBeDefined();
    });

    it('should only accept valid phase values', async () => {
      const validPhases = [
        'validating', 'exporting', 'parsing', 'fetching_lists',
        'queueing', 'enriching', 'completed', 'failed', 'cancelled'
      ] as const;

      for (const phase of validPhases) {
        const job = await SyncJob.create({
          userId: testUserId,
          sessionId: `phase-test-${phase}`,
          phase
        });
        expect(job.phase).toBe(phase);
      }
    });

    it('should have default stats with all zeros', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'stats-default-test',
        phase: 'validating'
      });

      expect(job.stats.total).toBe(0);
      expect(job.stats.pending).toBe(0);
      expect(job.stats.processing).toBe(0);
      expect(job.stats.completed).toBe(0);
      expect(job.stats.failed).toBe(0);
      expect(job.stats.skipped).toBe(0);
    });

    it('should store items with all fields', async () => {
      const items: ISyncItem[] = [
        {
          mfcId: '12345',
          name: 'Test Figure',
          status: 'pending',
          collectionStatus: 'owned',
          isNsfw: false,
          retryCount: 0
        },
        {
          mfcId: '67890',
          name: 'NSFW Figure',
          status: 'pending',
          collectionStatus: 'wished',
          isNsfw: true,
          retryCount: 0
        }
      ];

      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'items-test',
        phase: 'queueing',
        items
      });

      expect(job.items.length).toBe(2);
      expect(job.items[0].mfcId).toBe('12345');
      expect(job.items[0].collectionStatus).toBe('owned');
      expect(job.items[1].isNsfw).toBe(true);
    });
  });

  describe('isActive method', () => {
    it('should return true for active phases', async () => {
      const activePhases = ['validating', 'exporting', 'parsing', 'fetching_lists', 'queueing', 'enriching'] as const;

      for (const phase of activePhases) {
        const job = await SyncJob.create({
          userId: testUserId,
          sessionId: `active-${phase}`,
          phase
        });
        expect(job.isActive()).toBe(true);
      }
    });

    it('should return false for terminal phases', async () => {
      const terminalPhases = ['completed', 'failed', 'cancelled'] as const;

      for (const phase of terminalPhases) {
        const job = await SyncJob.create({
          userId: testUserId,
          sessionId: `terminal-${phase}`,
          phase
        });
        expect(job.isActive()).toBe(false);
      }
    });
  });

  describe('recalculateStats method', () => {
    it('should correctly count pending items', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-pending',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'pending', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'pending', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '3', status: 'completed', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      job.recalculateStats();

      expect(job.stats.total).toBe(3);
      expect(job.stats.pending).toBe(2);
      expect(job.stats.completed).toBe(1);
      expect(job.stats.processing).toBe(0);
      expect(job.stats.failed).toBe(0);
      expect(job.stats.skipped).toBe(0);
    });

    it('should correctly count processing items', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-processing',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'processing', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'processing', collectionStatus: 'wished', retryCount: 0 },
          { mfcId: '3', status: 'completed', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      job.recalculateStats();

      expect(job.stats.total).toBe(3);
      expect(job.stats.processing).toBe(2);
      expect(job.stats.completed).toBe(1);
    });

    it('should correctly count skipped items', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-skipped',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'skipped', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'skipped', collectionStatus: 'ordered', retryCount: 0 },
          { mfcId: '3', status: 'completed', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '4', status: 'failed', collectionStatus: 'owned', retryCount: 3 }
        ]
      });

      job.recalculateStats();

      expect(job.stats.total).toBe(4);
      expect(job.stats.skipped).toBe(2);
      expect(job.stats.completed).toBe(1);
      expect(job.stats.failed).toBe(1);
      expect(job.stats.pending).toBe(0);
      expect(job.stats.processing).toBe(0);
    });

    it('should correctly count all status types simultaneously', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-all-statuses',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'pending', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'processing', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '3', status: 'completed', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '4', status: 'failed', collectionStatus: 'owned', retryCount: 3 },
          { mfcId: '5', status: 'skipped', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      job.recalculateStats();

      expect(job.stats.total).toBe(5);
      expect(job.stats.pending).toBe(1);
      expect(job.stats.processing).toBe(1);
      expect(job.stats.completed).toBe(1);
      expect(job.stats.failed).toBe(1);
      expect(job.stats.skipped).toBe(1);
    });

    it('should mark job as completed when no pending or processing items remain', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-auto-complete',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'completed', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'failed', collectionStatus: 'owned', retryCount: 3 },
          { mfcId: '3', status: 'skipped', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      job.recalculateStats();

      expect(job.phase).toBe('completed');
      expect(job.completedAt).toBeDefined();
      expect(job.message).toContain('Sync complete');
      expect(job.message).toContain('1 enriched');
      expect(job.message).toContain('1 skipped');
      expect(job.message).toContain('1 failed');
    });

    it('should NOT mark job as completed when pending items remain', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'recalc-not-complete',
        phase: 'enriching',
        items: [
          { mfcId: '1', status: 'completed', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '2', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      job.recalculateStats();

      expect(job.phase).toBe('enriching');
      expect(job.completedAt).toBeUndefined();
    });
  });

  describe('updateItemStatus method', () => {
    it('should update item status and recalculate stats', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'update-status-test',
        phase: 'enriching',
        items: [
          { mfcId: '111', status: 'pending', collectionStatus: 'owned', retryCount: 0 },
          { mfcId: '222', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      await job.updateItemStatus('111', 'completed');

      const updated = await SyncJob.findOne({ sessionId: 'update-status-test' });
      const item = updated!.items.find(i => i.mfcId === '111');
      expect(item!.status).toBe('completed');
      expect(item!.completedAt).toBeDefined();
      expect(updated!.stats.completed).toBe(1);
      expect(updated!.stats.pending).toBe(1);
    });

    it('should increment retryCount on error', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'retry-count-test',
        phase: 'enriching',
        items: [
          { mfcId: '333', status: 'processing', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      await job.updateItemStatus('333', 'failed', 'Connection timeout');

      const updated = await SyncJob.findOne({ sessionId: 'retry-count-test' });
      const item = updated!.items.find(i => i.mfcId === '333');
      expect(item!.status).toBe('failed');
      expect(item!.retryCount).toBe(1);
      expect(item!.error).toBe('Connection timeout');
      expect(item!.completedAt).toBeDefined();
    });

    it('should set completedAt for skipped items', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'skipped-status-test',
        phase: 'enriching',
        items: [
          { mfcId: '444', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      await job.updateItemStatus('444', 'skipped');

      const updated = await SyncJob.findOne({ sessionId: 'skipped-status-test' });
      const item = updated!.items.find(i => i.mfcId === '444');
      expect(item!.status).toBe('skipped');
      expect(item!.completedAt).toBeDefined();
    });

    it('should handle non-existent item gracefully', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'nonexistent-item-test',
        phase: 'enriching',
        items: [
          { mfcId: '555', status: 'pending', collectionStatus: 'owned', retryCount: 0 }
        ]
      });

      // Should not throw when item is not found
      await job.updateItemStatus('999', 'completed');

      const updated = await SyncJob.findOne({ sessionId: 'nonexistent-item-test' });
      expect(updated!.items[0].status).toBe('pending');
    });
  });

  describe('Timestamps', () => {
    it('should automatically set createdAt and updatedAt', async () => {
      const job = await SyncJob.create({
        userId: testUserId,
        sessionId: 'timestamp-test',
        phase: 'validating'
      });

      expect(job.createdAt).toBeDefined();
      expect(job.updatedAt).toBeDefined();
      expect(job.createdAt).toBeInstanceOf(Date);
    });
  });
});
