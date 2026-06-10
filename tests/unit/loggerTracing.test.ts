import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { createLogger } from '../../src/utils/logger';

/**
 * Proves the logger threads the ACTIVE span's traceId/spanId into each log line.
 * Uses a real AsyncLocalStorage context manager + a real wrapped span context
 * (no mocking of the logger), so this exercises the actual correlation path.
 */
describe('logger trace correlation', () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  const TRACE_ID = 'abcdef12345678901234567890abcdef';
  const SPAN_ID = 'fedcba0987654321';

  it('threads trace and span ids into the log line when a span is active', () => {
    const log = createLogger('OTEL');
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      log.error('boom');
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]).toContain(`trace=${TRACE_ID} span=${SPAN_ID}`);
  });

  it('leaves the log shape unchanged when no span is active', () => {
    const log = createLogger('OTEL');
    log.error('boom');

    const args = errSpy.mock.calls[0];
    // [OTEL:ERROR], timestamp, sanitized-json — exactly 3 args, no trace tag.
    expect(args).toHaveLength(3);
    expect(args.some((a: unknown) => typeof a === 'string' && a.startsWith('trace='))).toBe(false);
  });
});
