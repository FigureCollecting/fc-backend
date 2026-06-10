import { shouldEnableTracing } from '../../src/tracing';

/**
 * Importing src/tracing runs its module side effect (startTracing), which is a
 * no-op here because jest sets NODE_ENV=test — so these tests exercise only the
 * pure gate decision, with no SDK started.
 */
describe('shouldEnableTracing', () => {
  it('is disabled under the test environment', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldEnableTracing({ TEST_MODE: 'memory' })).toBe(false);
  });

  it('never traces the suite even if explicitly enabled', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test', OTEL_TRACES_ENABLED: 'true' })).toBe(false);
    expect(shouldEnableTracing({ TEST_MODE: 'memory', OTEL_TRACES_ENABLED: 'true' })).toBe(false);
  });

  it('honors the explicit OTEL_TRACES_ENABLED override', () => {
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'true', NODE_ENV: 'production' })).toBe(true);
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false', NODE_ENV: 'development' })).toBe(false);
  });

  it('defaults on outside production, off in production', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldEnableTracing({})).toBe(true);
    expect(shouldEnableTracing({ NODE_ENV: 'production' })).toBe(false);
  });
});
