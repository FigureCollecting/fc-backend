/**
 * OpenTelemetry tracing bootstrap.
 *
 * MUST be imported before any instrumented module (express, mongoose, http) so
 * auto-instrumentation can patch them — `src/index.ts` imports this on its first
 * line.
 *
 * Behaviour is env-gated and SAFE BY DEFAULT:
 *   - disabled entirely under test (NODE_ENV=test / TEST_MODE=memory) so
 *     auto-instrumentation never interferes with the suite;
 *   - on outside production (benefit early in dev), opt-in for production — set
 *     OTEL_TRACES_ENABLED=true (or =false to force off anywhere);
 *   - spans are EXPORTED only when OTEL_EXPORTER_OTLP_ENDPOINT is set. With no
 *     endpoint, spans are still created (so the traceId flows into every log
 *     line) but nothing is shipped — no collector required, no connection errors.
 *
 * This is the "instrument now, ship dark, flip on a collector later" split: the
 * day a Tempo/OTLP endpoint exists, set the env var and full traces flow with no
 * code change.
 */
import dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

/**
 * Pure decision: should the tracing SDK start for this environment?
 * Exported so the gate logic can be tested without side effects.
 */
export function shouldEnableTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  // Never under tests — auto-instrumentation would interfere with the suite.
  if (env.NODE_ENV === 'test' || env.TEST_MODE === 'memory') return false;
  // Explicit override always wins.
  if (env.OTEL_TRACES_ENABLED === 'true') return true;
  if (env.OTEL_TRACES_ENABLED === 'false') return false;
  // Default: on in dev (benefit early), opt-in for production (DoD caution).
  return env.NODE_ENV !== 'production';
}

let sdk: NodeSDK | undefined;

/**
 * Start the tracing SDK if the environment calls for it. Idempotent.
 * Returns the SDK instance (or undefined when tracing is disabled).
 */
export function startTracing(env: NodeJS.ProcessEnv = process.env): NodeSDK | undefined {
  if (sdk || !shouldEnableTracing(env)) return sdk;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // No collector configured -> create spans (traceId for logs) but export nothing.
  if (!endpoint && !env.OTEL_TRACES_EXPORTER) {
    process.env.OTEL_TRACES_EXPORTER = 'none';
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'fc-backend',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'dev',
    }),
    // When an endpoint is set, OTLPTraceExporter reads it from the environment.
    traceExporter: endpoint ? new OTLPTraceExporter() : undefined,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[TRACING] OpenTelemetry started for fc-backend (export: ${endpoint || 'none'})`);

  const shutdown = (): void => {
    const current = sdk;
    if (!current) return;
    sdk = undefined;
    current.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return sdk;
}

// Auto-start on import — this module exists to be imported first for its side effect.
startTracing();
