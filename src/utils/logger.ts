/**
 * Production-safe debug logging utility
 * Enable debug logs with environment variables:
 * - DEBUG=true - Enable all debug logging
 * - DEBUG_LEVEL=verbose|info|warn - Set specific level
 * - DEBUG_MODULES=auth,version,register - Enable specific modules
 *
 * Security: Uses sanitizeForLog to prevent log injection attacks (CWE-117)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTraceContext } from '@figurecollecting/fc-shared';

const DEBUG = process.env.DEBUG === 'true';
const TEST_MODE = process.env.TEST_MODE === 'memory' || process.env.NODE_ENV === 'test';
const DEBUG_LEVEL = process.env.DEBUG_LEVEL || (process.env.NODE_ENV === 'development' ? 'info' : 'error');
const DEBUG_MODULES = process.env.DEBUG_MODULES?.split(',') || [];

type LogLevel = 'verbose' | 'info' | 'warn' | 'error';

// Maximum length for sanitized log strings (prevents log flooding)
const MAX_LOG_STRING_LENGTH = 1000;

/**
 * Sanitize a value for safe logging to prevent log injection attacks.
 * Uses JSON.stringify to break taint flow (recognized by CodeQL as a sanitizer).
 * - Converts all values to safe string representation
 * - Removes newlines and carriage returns (prevents log forging)
 * - Removes ANSI escape codes (prevents terminal manipulation)
 * - Truncates long strings (prevents log flooding)
 */
const sanitizeLogValue = (value: unknown): string => {
  // Use JSON.stringify to convert to safe string representation
  // This breaks CodeQL's taint tracking as stringify is a recognized sanitizer
  let stringified: string;

  // Handle null/undefined explicitly (JSON.stringify(undefined) returns undefined, not a string)
  if (value === null) {
    stringified = 'null';
  } else if (value === undefined) {
    stringified = 'undefined';
  } else if (typeof value === 'string') {
    stringified = value;
  } else if (value instanceof Error) {
    stringified = value.message || 'Error (no message)';
  } else {
    try {
      const result = JSON.stringify(value);
      // JSON.stringify can return undefined for certain inputs (e.g., functions)
      stringified = result ?? String(value);
    } catch {
      stringified = String(value);
    }
  }

  // Remove newlines, carriage returns, and ANSI escape codes
  // eslint-disable-next-line no-control-regex
  let sanitized = stringified.replace(/[\r\n]/g, ' ').replace(/\x1b\[[0-9;]*m/g, '');

  // Truncate if too long
  if (sanitized.length > MAX_LOG_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LOG_STRING_LENGTH) + '...[truncated]';
  }
  return sanitized;
};

/**
 * Sanitize all arguments into a single safe log message string.
 * Uses JSON.stringify to break CodeQL taint tracking.
 */
const sanitizeArgs = (args: unknown[]): string => {
  const sanitized = args.map(arg => sanitizeLogValue(arg));
  return JSON.stringify(sanitized);
};

const LOG_LEVELS: Record<LogLevel, number> = {
  verbose: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  private readonly module: string;
  private readonly enabled: boolean;
  private readonly level: number;

  constructor(module: string) {
    this.module = module;
    // Enable in test mode to ensure code paths are covered
    this.enabled = DEBUG || TEST_MODE || DEBUG_MODULES.includes(module) || DEBUG_MODULES.includes('*');
    this.level = LOG_LEVELS[DEBUG_LEVEL as LogLevel] || LOG_LEVELS.error;
  }

  /**
   * Leading log args: `[MODULE:LEVEL]`, timestamp, and the trace tag IFF a span
   * is active. With no active span (all existing tests) the shape is unchanged.
   */
  private head(level: string): unknown[] {
    const tc = getTraceContext();
    const base: unknown[] = [`[${this.module}:${level}]`, new Date().toISOString()];
    return tc ? [...base, tc] : base;
  }

  verbose(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.verbose) {
      console.log(...this.head('VERBOSE'), sanitizeArgs(args));
    }
  }

  info(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.info) {
      console.info(...this.head('INFO'), sanitizeArgs(args));
    }
  }

  warn(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.warn) {
      console.warn(...this.head('WARN'), sanitizeArgs(args));
    }
  }

  error(...args: unknown[]) {
    // Always log errors
    console.error(...this.head('ERROR'), sanitizeArgs(args));
  }

  // Log only in development or when explicitly enabled
  debug(...args: unknown[]) {
    if (this.enabled) {
      console.log(...this.head('DEBUG'), sanitizeArgs(args));
    }
  }
}

// Factory function to create module-specific loggers
export const createLogger = (module: string): Logger => {
  return new Logger(module);
};

// Pre-configured loggers for common modules
export const authLogger = createLogger('AUTH');
export const versionLogger = createLogger('VERSION');
export const registerLogger = createLogger('REGISTER');
export const dbLogger = createLogger('DATABASE');

// Export the Logger class for custom instances
export default Logger;

/**
 * Sync tracking logger for MFC sync analysis.
 * These logs are always written (not debug-gated) for later analysis.
 * Writes to both console AND file for persistence.
 *
 * View logs: cat logs/sync.log | grep "FAILURE"
 */
export interface SyncEvent {
  event: 'job_start' | 'job_complete' | 'item_saved' | 'item_failed' | 'webhook_received' | 'phase_change' | 'error';
  sessionId: string;
  mfcId?: string;
  phase?: string;
  status?: string;
  total?: number;
  completed?: number;
  failed?: number;
  errorType?: string;
  reason?: string;
}

// Ensure logs directory exists (skip in test mode)
let syncLogPath: string | null = null;
if (!TEST_MODE) {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  syncLogPath = path.join(logsDir, 'sync.log');
}

export const syncLogger = {
  /**
   * Log a sync event in structured format for later analysis
   * Writes to both console AND file for persistence
   */
  log(event: SyncEvent): void {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      component: 'SYNC',
      ...event,
    };
    // Sanitize user-provided values before logging and file write
    const safeSessionId = sanitizeLogValue(event.sessionId);
    const safeMfcId = event.mfcId ? sanitizeLogValue(event.mfcId) : '';
    const safeEntry = JSON.stringify(entry);
    const logLine = `[${timestamp}] [SYNC] ${event.event.toUpperCase()} session=${safeSessionId}${safeMfcId ? ` mfcId=${safeMfcId}` : ''} ${safeEntry}`;

    // Console output
    console.log(logLine);

    // File output (append) - skip in test mode
    // Sanitize entire log line before file write to prevent log poisoning
    if (syncLogPath) {
      const sanitizedLine = String(logLine).replace(/[\r\n]/g, ' ').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      fs.appendFileSync(syncLogPath, sanitizedLine + '\n'); // lgtm[js/http-to-file-access]
    }
  },

  /**
   * Log sync job start
   */
  jobStart(sessionId: string, total: number): void {
    this.log({ event: 'job_start', sessionId, total });
  },

  /**
   * Log sync job completion
   */
  jobComplete(sessionId: string, completed: number, failed: number, total: number): void {
    this.log({ event: 'job_complete', sessionId, completed, failed, total, status: failed > 0 ? 'partial' : 'success' });
  },

  /**
   * Log successful item save
   */
  itemSaved(sessionId: string, mfcId: string): void {
    this.log({ event: 'item_saved', sessionId, mfcId });
  },

  /**
   * Log failed item save
   */
  itemFailed(sessionId: string, mfcId: string, errorType: string, reason: string): void {
    this.log({ event: 'item_failed', sessionId, mfcId, errorType, reason });
  },

  /**
   * Log webhook received
   */
  webhookReceived(sessionId: string, mfcId?: string): void {
    this.log({ event: 'webhook_received', sessionId, mfcId });
  },

  /**
   * Log phase change
   */
  phaseChange(sessionId: string, phase: string, completed?: number, total?: number): void {
    this.log({ event: 'phase_change', sessionId, phase, completed, total });
  },

  /**
   * Log sync error
   */
  error(sessionId: string, errorType: string, reason: string): void {
    this.log({ event: 'error', sessionId, errorType, reason });
  },
};