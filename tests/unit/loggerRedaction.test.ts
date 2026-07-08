import { createLogger } from '../../src/utils/logger';
import { RedactingSpanExporter } from '../../src/tracing';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

/**
 * Proves fc-shared redaction is wired into both sinks:
 *  - the logger redacts secrets/PII from log args before the existing
 *    CWE-117 string sanitization runs, and
 *  - RedactingSpanExporter scrubs span attributes before the delegate exports.
 */
describe('logger secret/PII redaction', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('redacts a secret-bearing object and a Bearer token string to [REDACTED]', () => {
    const log = createLogger('SECRETS');
    log.error({ password: 'x', user: 'bob' }, 'Bearer abcdefghij');

    // The sanitized JSON payload is the last arg of the single error call.
    const call = errSpy.mock.calls[0];
    const payload = call[call.length - 1] as string;

    expect(payload).toContain('[REDACTED]');
    // Secret values are gone; the non-secret field survives.
    expect(payload).not.toContain('"password":"x"');
    expect(payload).not.toContain('abcdefghij');
    expect(payload).toContain('bob');
  });
});

describe('RedactingSpanExporter', () => {
  it('scrubs span attributes before the delegate receives them', () => {
    let received: ReadableSpan[] | undefined;
    const delegate: SpanExporter = {
      export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
        received = spans;
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
    };

    const exporter = new RedactingSpanExporter(delegate);
    const fakeSpan = {
      attributes: { authorization: 'Bearer secret-token', 'http.method': 'GET' },
    } as unknown as ReadableSpan;

    let result: ExportResult | undefined;
    exporter.export([fakeSpan], (r) => {
      result = r;
    });

    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    expect(received).toHaveLength(1);
    const attrs = received![0].attributes as Record<string, unknown>;
    expect(attrs.authorization).toBe('[REDACTED]');
    // Non-sensitive attributes pass through untouched.
    expect(attrs['http.method']).toBe('GET');
  });
});
