/**
 * THE MODULE'S PUBLIC SURFACE.
 *
 * A module whose whole promise is "copy this directory into another service"
 * has an API that is a contract, not an accident: the porting target imports
 * these names, and anything not on this list is an internal the next refactor
 * may move. Pinning the set here means widening it is a deliberate edit rather
 * than a side effect of exporting something for one test's convenience.
 */
import * as entitlements from '../../../src/services/entitlements';

const EXPECTED_SURFACE = [
  // the one call a host application needs
  'entitlementHeaderFor',
  // its two halves, exported for callers that want them separately
  'grantsForSubject',
  'mintEntitlementAssertion',
  // boot
  'initEntitlementSigning',
  // observability
  'entitlementGrantCounters',
  'entitlementMintCounters',
  // test seams
  'resetEntitlementGrantsForTest',
  'resetEntitlementSigningForTest',
].sort();

describe('src/services/entitlements public surface', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(entitlements).sort()).toEqual(EXPECTED_SURFACE);
  });

  it.each(EXPECTED_SURFACE)('%s is callable', name => {
    expect(typeof (entitlements as unknown as Record<string, unknown>)[name]).toBe('function');
  });
});
