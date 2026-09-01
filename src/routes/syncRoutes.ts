/**
 * Sync Routes - Proxy to Scraper Service with Webhook + SSE Support
 *
 * These routes proxy MFC sync operations to the scraper service.
 * The backend acts as a gateway to:
 * 1. Centralize authentication
 * 2. Keep scraper service internal (not exposed to frontend directly)
 * 3. Ensure cookies are passed per-request (ephemeral, not stored)
 * 4. Receive webhooks from scraper on item completion
 * 5. Stream real-time progress to frontend via SSE
 */
import express, { Response } from 'express';
import crypto from 'crypto';
import { protect } from '../middleware/authMiddleware';
import rateLimit from 'express-rate-limit';
import { SyncJob, ISyncJob, SyncItemStatus, MfcList } from '../models';
import { syncLogger } from '../utils/logger';
import { applyScrapedData } from '../services/applyScrapedData';

const router = express.Router();

// General rate limiter for user-facing sync routes
// Webhook routes (/webhook/*) are exempt — they use HMAC signature auth
// and must handle high-throughput item-complete callbacks during sync
const generalSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/webhook/'),
});
router.use(generalSyncLimiter);

// Store for active SSE connections by sessionId
const sseConnections = new Map<string, Set<Response>>();

// Webhook secret for scraper→backend communication
// In production, this should be in environment variables
const WEBHOOK_SECRET = process.env.SCRAPER_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// Scraper service URL - in Docker it's 'scraper:3050', locally it's 'localhost:3080'
const SCRAPER_SERVICE_URL = process.env.SCRAPER_SERVICE_URL || 'http://localhost:3080';

// Stale session detection thresholds
const STALE_SESSION_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes for on-demand check
const STALE_CLEANUP_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes for periodic cleanup
const STALE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;   // Run cleanup every 5 minutes

/**
 * Mark a stale SyncJob as failed.
 * Used both by the active-job endpoint and the periodic cleanup.
 */
async function failStaleJob(job: ISyncJob): Promise<void> {
  job.phase = 'failed';
  job.message = 'Session timed out - no progress received';
  job.completedAt = new Date();
  await job.save();
  console.log(`[SYNC] Stale session cleaned up: sessionId=${job.sessionId}, lastUpdated=${job.updatedAt.toISOString()}`);
}

/**
 * Periodic cleanup: find and fail all SyncJobs that haven't been updated
 * within the cleanup threshold. Prevents zombie jobs from accumulating.
 */
async function cleanupStaleSessions(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_CLEANUP_THRESHOLD_MS);
    const staleJobs = await SyncJob.find({
      phase: { $nin: ['completed', 'failed', 'cancelled'] },
      updatedAt: { $lt: cutoff }
    });

    for (const job of staleJobs) {
      await failStaleJob(job);
    }

    if (staleJobs.length > 0) {
      console.log(`[SYNC] Periodic cleanup: failed ${staleJobs.length} stale session(s)`);
    }
  } catch (error: any) {
    console.error('[SYNC] Stale session cleanup error:', error.message);
  }
}

// Start periodic stale session cleanup (unref so it doesn't prevent process exit)
setInterval(cleanupStaleSessions, STALE_CLEANUP_INTERVAL_MS).unref();

// Rate limiting for sync operations (restrictive - these are heavy operations)
const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 sync operations per 15 minutes
  message: { success: false, message: 'Too many sync requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Separate rate limiter for validation (more lenient - lightweight operation)
const validationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // 60 validations per 15 minutes (allows for modal open/close testing)
  message: { success: false, message: 'Too many validation requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Helper to proxy requests to the scraper service
 * Cookies are passed per-request and not stored on scraper
 */
const proxyToScraper = async (
  endpoint: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>,
  userId?: string
) => {
  const url = `${SCRAPER_SERVICE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId && { 'X-User-Id': userId }),
    },
  };

  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.message || 'Scraper service error') as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return data;
};

/**
 * POST /sync/validate-cookies
 * Validate MFC session cookies before starting a sync
 * Cookies are passed in request body, used once, then discarded
 * Uses lighter rate limit than sync operations (validation is lightweight)
 */
router.post('/validate-cookies', protect, validationLimiter, async (req, res) => {
  try {
    const { cookies } = req.body;
    const userId = (req as any).user?.id;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'MFC cookies are required'
      });
    }

    const result = await proxyToScraper('/sync/validate-cookies', 'POST', { cookies }, userId);
    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] validate-cookies error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to validate cookies'
    });
  }
});

/**
 * POST /sync/parse-csv
 * Parse MFC CSV content without executing sync
 */
router.post('/parse-csv', protect, async (req, res) => {
  try {
    const { csvContent } = req.body;
    const userId = (req as any).user?.id;

    if (!csvContent) {
      return res.status(400).json({
        success: false,
        message: 'CSV content is required'
      });
    }

    const result = await proxyToScraper('/sync/parse-csv', 'POST', { csvContent }, userId);
    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] parse-csv error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to parse CSV'
    });
  }
});

/**
 * POST /sync/from-csv
 * Sync figures from user-provided CSV content
 * Cookies passed per-request for any NSFW items that need auth
 */
router.post('/from-csv', protect, syncLimiter, async (req, res) => {
  try {
    const { csvContent, cookies, sessionId } = req.body;
    const userId = (req as any).user?.id;

    if (!csvContent) {
      return res.status(400).json({
        success: false,
        message: 'CSV content is required'
      });
    }

    const result = await proxyToScraper('/sync/from-csv', 'POST', {
      csvContent,
      userId,
      cookies, // Ephemeral - used for this sync only
      sessionId
    }, userId);

    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] from-csv error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to sync from CSV'
    });
  }
});

/**
 * POST /sync/full
 * Full sync: validate cookies → export CSV from MFC → parse → queue
 * Cookies passed per-request
 *
 * This endpoint also passes webhook configuration to the scraper so it
 * can call back when items are processed. The backend then updates the
 * SyncJob and broadcasts via SSE.
 */
router.post('/full', protect, syncLimiter, async (req, res) => {
  try {
    const { cookies, sessionId, includeLists, skipCached, statusFilter } = req.body;
    const userId = (req as any).user?.id;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'MFC cookies are required for full sync'
      });
    }

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required for full sync'
      });
    }

    // Construct webhook URL for scraper callbacks
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5080';
    const webhookUrl = `${backendUrl}/sync/webhook`;

    const result = await proxyToScraper('/sync/full', 'POST', {
      cookies,
      userId,
      sessionId,
      includeLists,
      skipCached,
      statusFilter, // Filter by owned/ordered/wished
      // Pass webhook config for scraper to call back on item completion
      webhookUrl,
      webhookSecret: WEBHOOK_SECRET
    }, userId);

    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] full error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to execute full sync'
    });
  }
});

/**
 * GET /sync/status
 * Get current sync status for the user
 */
router.get('/status', protect, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    const result = await proxyToScraper(`/sync/status?userId=${userId}`, 'GET', undefined, userId);
    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] status error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to get sync status'
    });
  }
});

/**
 * GET /sync/queue-stats
 * Get detailed queue statistics
 */
router.get('/queue-stats', protect, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    const result = await proxyToScraper(`/sync/queue-stats?userId=${userId}`, 'GET', undefined, userId);
    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] queue-stats error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to get queue stats'
    });
  }
});

// ============================================================================
// WEBHOOK ENDPOINTS - Called by scraper service
// ============================================================================

/**
 * Verify webhook signature from scraper service.
 * Uses HMAC-SHA256 with shared secret.
 */
const verifyWebhookSignature = (signature: string | undefined, body: string): boolean => {
  if (!signature) return false;
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
};

/**
 * Broadcast SSE event to all connected clients for a sessionId.
 */
const broadcastToSession = (sessionId: string, event: string, data: unknown): void => {
  const connections = sseConnections.get(sessionId);
  if (!connections || connections.size === 0) return;

  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of connections) {
    try {
      res.write(message);
    } catch {
      // Connection closed, will be cleaned up on next heartbeat
    }
  }
};

/**
 * POST /sync/webhook/item-complete
 * Webhook called by scraper when an item finishes processing.
 * Updates SyncJob and broadcasts progress via SSE.
 */
router.post('/webhook/item-complete', async (req, res) => {
  try {
    // Verify webhook signature
    const signature = req.headers['x-webhook-signature'] as string;
    const rawBody = JSON.stringify(req.body);

    if (!verifyWebhookSignature(signature, rawBody)) {
      console.error('[WEBHOOK] Invalid signature');
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    const { sessionId, mfcId, status, error: itemError, scrapedData } = req.body as {
      sessionId: string;
      mfcId: string;
      status: SyncItemStatus;
      error?: string;
      scrapedData?: Record<string, unknown>;
    };

    if (!sessionId || !mfcId || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sessionId, mfcId, status'
      });
    }

    // Find and update the SyncJob
    const job = await SyncJob.findOne({ sessionId });
    if (!job) {
      console.error(`[WEBHOOK] SyncJob not found for session: ${JSON.stringify(sessionId)}`);
      return res.status(404).json({ success: false, message: 'SyncJob not found' });
    }

    // Log webhook received
    syncLogger.webhookReceived(sessionId, mfcId);

    // Update item status
    await job.updateItemStatus(mfcId, status, itemError);

    // If item completed successfully and has scraped data, save/update records
    if (status === 'completed' && scrapedData) {
      try {
        // Get the item from the job to find its collection status, activity order, and orphan flag
        const jobItem = job.items.find((i: { mfcId: string }) => i.mfcId === mfcId);

        // Delegate the DB-write effects (Figure upsert, MFCItem catalog upsert,
        // fire-and-forget search-index sync) to the unified applyScrapedData
        // function, shared with the future reprocess path.
        const { figure } = await applyScrapedData(mfcId, scrapedData, job.userId, {
          collectionStatus: jobItem?.collectionStatus || 'owned',
          mfcActivityOrder: jobItem?.mfcActivityOrder,
          isOrphan: jobItem?.isOrphan
        });

        if (figure) {
          syncLogger.itemSaved(sessionId, mfcId);
        }
      } catch (saveError: any) {
        console.error(`[WEBHOOK] Failed to save figure ${JSON.stringify(mfcId)}: ${JSON.stringify(saveError.message)}`);
        syncLogger.itemFailed(sessionId, mfcId, 'save_error', saveError.message);
        // Don't fail the webhook - the sync can continue
      }
    }

    // Broadcast progress update to connected SSE clients
    broadcastToSession(sessionId, 'item-update', {
      mfcId,
      status,
      error: itemError,
      stats: job.stats,
      phase: job.phase
    });

    // If job is complete, broadcast completion event and log
    if (job.phase === 'completed' || job.phase === 'failed') {
      syncLogger.jobComplete(sessionId, job.stats.completed, job.stats.failed, job.stats.total);
      broadcastToSession(sessionId, 'sync-complete', {
        phase: job.phase,
        stats: job.stats,
        message: job.message
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('[WEBHOOK] item-complete error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Webhook processing failed'
    });
  }
});

/**
 * POST /sync/webhook/phase-change
 * Webhook called by scraper when sync phase changes.
 */
router.post('/webhook/phase-change', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const rawBody = JSON.stringify(req.body);

    if (!verifyWebhookSignature(signature, rawBody)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    const { sessionId, phase, message, items } = req.body as {
      sessionId: string;
      phase: string;
      message?: string;
      items?: Array<{ mfcId: string; name?: string; collectionStatus: string; isNsfw?: boolean; mfcActivityOrder?: number; isOrphan?: boolean }>;
    };

    if (!sessionId || !phase) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sessionId, phase'
      });
    }

    const job = await SyncJob.findOne({ sessionId });
    if (!job) {
      return res.status(404).json({ success: false, message: 'SyncJob not found' });
    }

    // Terminal phases (completed, failed, cancelled) should only be set internally
    // by recalculateStats() when all items are done, or by the cancel endpoint.
    // Exception: accept 'completed' from scraper when there are no items to enrich
    // (e.g., lists-only sync where statusFilter is empty).
    const terminalPhases = ['completed', 'failed', 'cancelled'];
    if (terminalPhases.includes(phase)) {
      const hasNoItems = !job.items || job.items.length === 0;
      if (phase === 'completed' && hasNoItems) {
        // No items means recalculateStats() will never trigger completion.
        // Accept the scraper's completed phase directly.
        job.phase = 'completed';
        job.message = message || 'Sync complete';
        await job.save();

        syncLogger.phaseChange(sessionId, 'completed', 0, 0);
        broadcastToSession(sessionId, 'sync-complete', {
          phase: 'completed',
          message: job.message,
          stats: job.stats
        });

        return res.json({ success: true });
      }

      console.warn(`[WEBHOOK] Ignoring terminal phase ${JSON.stringify(phase)} from scraper - completion is determined by backend`);
      return res.json({ success: true, ignored: true });
    }

    // Update job phase (non-terminal phases only)
    job.phase = phase as any;
    if (message) job.message = message;

    // If items provided (during queueing phase), add them
    if (items && items.length > 0) {
      job.items = items.map(item => ({
        mfcId: item.mfcId,
        name: item.name,
        status: 'pending' as SyncItemStatus,
        collectionStatus: item.collectionStatus as 'owned' | 'wished' | 'ordered',
        mfcActivityOrder: item.mfcActivityOrder,
        isNsfw: item.isNsfw || false,
        isOrphan: item.isOrphan || false,
        retryCount: 0
      }));
      job.recalculateStats();
    }

    await job.save();

    // Log phase change
    syncLogger.phaseChange(sessionId, phase, job.stats?.completed, job.stats?.total);

    // Broadcast phase change
    broadcastToSession(sessionId, 'phase-change', {
      phase: job.phase,
      message: job.message,
      stats: job.stats
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error('[WEBHOOK] phase-change error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Webhook processing failed'
    });
  }
});

/**
 * POST /sync/webhook/lists-sync
 * Webhook called by scraper to sync user's MFC lists.
 * Upserts lists into MfcList collection using the userId from the SyncJob.
 */
router.post('/webhook/lists-sync', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const rawBody = JSON.stringify(req.body);

    if (!verifyWebhookSignature(signature, rawBody)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    const { sessionId, lists } = req.body as {
      sessionId: string;
      lists: Array<{
        mfcId: number;
        name: string;
        teaser?: string;
        description?: string;
        privacy?: string;
        iconUrl?: string;
        itemCount?: number;
        itemMfcIds?: number[];
        itemDetails?: Array<{ mfcId: number; name?: string; imageUrl?: string }>;
        mfcCreatedAt?: string;
      }>;
    };

    if (!sessionId || !lists || !Array.isArray(lists)) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sessionId, lists'
      });
    }

    // Look up SyncJob to get the userId
    const job = await SyncJob.findOne({ sessionId });
    if (!job) {
      return res.status(404).json({ success: false, message: 'SyncJob not found' });
    }

    const userId = job.userId;
    let upsertCount = 0;

    for (const listData of lists) {
      const { mfcId, ...rest } = listData;

      await MfcList.findOneAndUpdate(
        { userId, mfcId },
        {
          $set: {
            ...rest,
            userId,
            mfcId,
            itemCount: rest.itemMfcIds ? rest.itemMfcIds.length : (rest.itemCount || 0),
            lastSyncedAt: new Date()
          }
        },
        { upsert: true, new: true }
      );

      upsertCount++;
    }

    console.log(`[WEBHOOK] lists-sync: upserted ${upsertCount} lists for session ${JSON.stringify(sessionId)}`);

    return res.json({ success: true, upserted: upsertCount });
  } catch (error: any) {
    console.error('[WEBHOOK] lists-sync error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Webhook processing failed'
    });
  }
});

// ============================================================================
// SSE ENDPOINTS - Real-time streaming to frontend
// ============================================================================

/**
 * GET /sync/stream/:sessionId
 * Server-Sent Events stream for real-time sync progress.
 * Frontend connects to receive live updates.
 */
router.get('/stream/:sessionId', protect, async (req, res) => {
  const sessionId = req.params.sessionId as string;
  const userId = (req as any).user?.id;

  // Verify the user owns this sync job
  const job = await SyncJob.findOne({ sessionId, userId });
  if (!job) {
    return res.status(404).json({ success: false, message: 'SyncJob not found' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Add this connection to the session's connection set
  if (!sseConnections.has(sessionId)) {
    sseConnections.set(sessionId, new Set());
  }
  sseConnections.get(sessionId)!.add(res);

  console.log(`[SSE] Client connected for session ${JSON.stringify(sessionId)}`);

  // Send initial state
  const initialEvent = `event: connected\ndata: ${JSON.stringify({
    sessionId,
    phase: job.phase,
    stats: job.stats,
    message: job.message
  })}\n\n`;
  res.write(initialEvent);

  // Heartbeat to keep connection alive (every 30 seconds)
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected from session ${JSON.stringify(sessionId)}`);
    clearInterval(heartbeatInterval);
    const connections = sseConnections.get(sessionId);
    if (connections) {
      connections.delete(res);
      if (connections.size === 0) {
        sseConnections.delete(sessionId);
      }
    }
  });
});

/**
 * GET /sync/active-job
 * Find the user's active sync job without knowing the session ID.
 * Used for session recovery after page refresh or SSE disconnection.
 */
router.get('/active-job', protect, async (req, res) => {
  try {
    const userId = (req as any).user?.id;

    // Find the most recent active job for this user
    // Active = not in terminal state (completed, failed, cancelled)
    const activeJob = await SyncJob.findOne({
      userId,
      phase: { $nin: ['completed', 'failed', 'cancelled'] }
    }).sort({ startedAt: -1 });

    if (!activeJob) {
      return res.json({
        success: true,
        hasActiveJob: false
      });
    }

    // Check if the job is stale (no updates for 10+ minutes)
    const timeSinceUpdate = Date.now() - activeJob.updatedAt.getTime();
    if (timeSinceUpdate > STALE_SESSION_THRESHOLD_MS) {
      await failStaleJob(activeJob);
      // Return as a completed (failed) job so the frontend can show the failure
      return res.json({
        success: true,
        hasActiveJob: false,
        job: {
          sessionId: activeJob.sessionId,
          phase: activeJob.phase,
          message: activeJob.message,
          stats: activeJob.stats,
          startedAt: activeJob.startedAt,
          completedAt: activeJob.completedAt
        }
      });
    }

    return res.json({
      success: true,
      hasActiveJob: true,
      job: {
        sessionId: activeJob.sessionId,
        phase: activeJob.phase,
        message: activeJob.message,
        stats: activeJob.stats,
        startedAt: activeJob.startedAt,
        completedAt: activeJob.completedAt
      }
    });
  } catch (error: any) {
    console.error('[SYNC] get active job error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to get active job'
    });
  }
});

/**
 * GET /sync/job/:sessionId
 * Get current sync job state (for initial load or reconnection).
 */
router.get('/job/:sessionId', protect, async (req, res) => {
  try {
    const sessionId = req.params.sessionId as string;
    const userId = (req as any).user?.id;

    const job = await SyncJob.findOne({ sessionId, userId });
    if (!job) {
      return res.status(404).json({ success: false, message: 'SyncJob not found' });
    }

    return res.json({
      success: true,
      job: {
        sessionId: job.sessionId,
        phase: job.phase,
        message: job.message,
        stats: job.stats,
        startedAt: job.startedAt,
        completedAt: job.completedAt
      }
    });
  } catch (error: any) {
    console.error('[SYNC] get job error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to get sync job'
    });
  }
});

/**
 * POST /sync/job
 * Create a new sync job (called before starting sync).
 */
router.post('/job', protect, async (req, res) => {
  try {
    const { sessionId, includeLists, skipCached } = req.body;
    const userId = (req as any).user?.id;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required'
      });
    }

    // Check if a job already exists for this session
    const existingJob = await SyncJob.findOne({ sessionId });
    if (existingJob) {
      // Return existing job if still active
      if (existingJob.isActive()) {
        return res.json({
          success: true,
          job: existingJob,
          existing: true
        });
      }
      // Delete completed/failed job to start fresh
      await SyncJob.deleteOne({ sessionId });
    }

    // Create new sync job
    const job = await SyncJob.create({
      userId,
      sessionId,
      phase: 'validating',
      message: 'Starting sync...',
      includeLists: includeLists || ['owned', 'ordered', 'wished'],
      skipCached: skipCached || false
    });

    // Send webhook secret to be used by scraper
    // In production, this would be configured via environment variables
    return res.json({
      success: true,
      job: {
        sessionId: job.sessionId,
        phase: job.phase,
        message: job.message
      },
      webhookUrl: `${process.env.BACKEND_URL || 'http://localhost:5080'}/sync/webhook`,
      webhookSecret: WEBHOOK_SECRET
    });
  } catch (error: any) {
    console.error('[SYNC] create job error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create sync job'
    });
  }
});

/**
 * DELETE /sync/job/:sessionId
 * Cancel an active sync job.
 */
router.delete('/job/:sessionId', protect, async (req, res) => {
  try {
    const sessionId = req.params.sessionId as string;
    const userId = (req as any).user?.id;

    const job = await SyncJob.findOne({ sessionId, userId });
    if (!job) {
      return res.status(404).json({ success: false, message: 'SyncJob not found' });
    }

    if (!job.isActive()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel a completed job'
      });
    }

    // Tell the scraper to cancel all pending items for this session
    try {
      await proxyToScraper(`/sync/sessions/${sessionId}`, 'DELETE', undefined, userId);
      console.log(`[SYNC] Notified scraper to cancel session ${JSON.stringify(sessionId)}`);
    } catch (scraperError: any) {
      // Don't fail if scraper is unavailable - still mark job as cancelled
      console.warn(`[SYNC] Failed to notify scraper of cancellation: ${JSON.stringify(scraperError.message)}`);
    }

    job.phase = 'cancelled';
    job.message = 'Sync cancelled by user';
    job.completedAt = new Date();
    await job.save();

    // Broadcast cancellation with preserved stats
    broadcastToSession(sessionId, 'sync-complete', {
      phase: 'cancelled',
      stats: job.stats,  // Preserve completed/failed counts for UI display
      message: job.message
    });

    // Close all SSE connections for this session
    const connections = sseConnections.get(sessionId);
    if (connections) {
      for (const connRes of connections) {
        try {
          connRes.end();
        } catch {
          // Ignore already closed connections
        }
      }
      sseConnections.delete(sessionId);
    }

    return res.json({ success: true, message: 'Sync cancelled' });
  } catch (error: any) {
    console.error('[SYNC] cancel job error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel sync job'
    });
  }
});

// ============================================================================
// PUBLIC CONFIGURATION ENDPOINTS
// ============================================================================

/**
 * GET /sync/mfc/cookie-allowlist
 * Returns the list of allowed MFC cookies from the scraper.
 * Public endpoint - no auth required (it's just configuration).
 * Used by frontend to generate dynamic cookie extraction scripts.
 */
router.get('/mfc/cookie-allowlist', async (req, res) => {
  try {
    const result = await proxyToScraper('/mfc/cookie-allowlist', 'GET');
    return res.json(result);
  } catch (error: any) {
    console.error('[SYNC] cookie-allowlist error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to get cookie allowlist'
    });
  }
});

// Export webhook secret getter for testing/configuration
export const getWebhookSecret = () => WEBHOOK_SECRET;

export default router;
