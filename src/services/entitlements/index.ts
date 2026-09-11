/**
 * src/services/entitlements — THE PORTABLE ENTITLEMENT MODULE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DIRECTORY IS SELF-CONTAINED AND PORTS VERBATIM.
 *
 * It imports node builtins, `axios`, and `@figurecollecting/ingest-contract`.
 * NOTHING ELSE — no database driver, no ORM, no user model, no application
 * config, no logger of this app's. It is a directory copy away from running in
 * the Postgres-only fc-backend, and `entitlements-portability.test.ts` fails the
 * build if that stops being true.
 *
 * WHY THE LINE IS DRAWN HERE. The one thing that genuinely differs between the
 * backend this runs in today and the one it is destined for is HOW A LOGGED-IN
 * USER BECOMES AN AUTHENTIK UUID. Today that is a lookup against a Mongo user
 * document; in the Postgres-only backend it is something else, quite possibly
 * the session subject itself. Everything downstream of that uuid — the Check,
 * the cache, the signature, the header — is identical in both. So the uuid is
 * the seam, and this module starts on the far side of it: it accepts a subject
 * STRING and never asks where it came from.
 *
 * WHAT LIVES OUTSIDE, AND MUST BE REWRITTEN OR DELETED WHEN PORTING:
 *   src/services/entitlementSubject.legacy.ts   the Mongo lookup (DELETE)
 *   src/models/User.ts `authentikId`            the field it reads (DELETE)
 *   src/routes/compareRoutes.ts                 ~6 lines of wiring (REWRITE)
 *   src/index.ts                                1 bootstrap call (REWRITE)
 * The header-attaching client, src/services/spineReadClient.ts, is portable as
 * it stands; it is outside this directory only because it predates it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * USAGE, whole:
 *
 *   import { entitlementHeaderFor, initEntitlementSigning } from './services/entitlements';
 *
 *   initEntitlementSigning();                       // once, at boot
 *   const assertion = await entitlementHeaderFor(authentikUuid);
 *   await spineRead.compare(seed, nowIso, assertion);   // null => no header
 *
 * THE SUBJECT IS AN AUTHENTIK USER UUID and the module enforces it — see
 * ./subject.ts. `isEntitlementSubject` is exported so a host application can
 * check its own identity source against the same rule instead of discovering
 * the mismatch as numbers that quietly fail to appear.
 */
export {
  entitlementHeaderFor,
  grantsForSubject,
  entitlementGrantCounters,
  resetEntitlementGrantsForTest,
} from './grants';

export { isEntitlementSubject, ENTITLEMENT_SUBJECT_PATTERN } from './subject';

export {
  mintEntitlementAssertion,
  initEntitlementSigning,
  entitlementMintCounters,
  resetEntitlementSigningForTest,
  type MintRequest,
} from './assertion';
