/**
 * Compare Routes — SCREEN surface for the spine's read.v1 SpineRead.Compare
 * RPC (see src/services/spineReadClient.ts). THIN READ-THROUGH ONLY: no
 * buy/sell framing, no landed-cost, no comps (HELD for product vision).
 *
 * JWT-protected with the same `protect` middleware as the other protected
 * routes (e.g. lookupRoutes). now_iso is minted at THIS edge, per request —
 * the RPC never reads wall time server-side.
 *
 * THE ENTITLEMENT GATE (D6 U6). The spine withholds per-store stock MAGNITUDES
 * from any caller that cannot prove an entitlement. fc-backend is the only
 * user-facing caller (lookup-caller-architecture, RATIFIED), so it is the only
 * party that knows WHO is asking: per request it resolves the user's Authentik
 * subject, runs an OpenFGA Check, and — only on an explicit allow — mints a
 * 60-second Ed25519 assertion for the spine to verify.
 *
 * NOTHING ABOUT THAT CHANGES THE RESPONSE CONTRACT. Denied, unlinked, OpenFGA
 * down, no signing key: every one of them sends no header and the read comes
 * back a normal 200 with the magnitudes absent and `coverage.redacted` naming
 * what was withheld. Availability, prices and every other fact are unaffected.
 * A gate that returned 403 here would tell an unentitled caller that a number
 * EXISTS, which is most of what the number was worth.
 */
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../middleware/authMiddleware';
import {
  createSpineReadClientFromEnv,
  Code,
  ConnectError,
  type CompareSeed,
} from '../services/spineReadClient';
import { entitlementHeaderFor } from '../services/entitlements';
import { resolveEntitlementSubject } from '../services/entitlementSubject.legacy';

const router = express.Router();

// Rate limiting (CodeQL js/missing-rate-limiting; ratified caller architecture
// assigns per-user rate-limiting to fc-backend). Mirrors figureRoutes.ts's
// figureApiLimiter convention exactly, including the test-env skip.
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'memory';
export const compareApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 0 : 200, // 0 = disabled in test
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
});
router.use(compareApiLimiter);

const GTIN14_RE = /^\d{14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(protect);

router.get('/by-gtin/:gtin14', async (req: Request, res: Response) => {
  // Express's ParamsDictionary types every value as string | string[] to
  // cover repeated-segment patterns; a single named segment like :gtin14
  // (no repetition) always yields a plain string at runtime.
  const gtin14 = req.params.gtin14 as string;
  if (!GTIN14_RE.test(gtin14)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_GTIN14',
      message: 'gtin14 must be exactly 14 digits',
    });
  }
  return handleCompare(req, res, { gtin14 });
});

router.get('/by-head/:headId', async (req: Request, res: Response) => {
  const headId = req.params.headId as string;
  if (!UUID_RE.test(headId)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_HEAD_ID',
      message: 'headId must be a UUID',
    });
  }
  return handleCompare(req, res, { headId });
});

/** Canonical gRPC status name (e.g. Code.InvalidArgument -> 'INVALID_ARGUMENT'),
 * consistent with this module's other SCREAMING_SNAKE codes. */
const grpcStatusName = (code: Code): string => Code[code].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/**
 * The assertion for this request, or null when there is nothing to assert.
 *
 * THESE SIX LINES ARE THE ENTIRE WIRING, and the only place the legacy app and
 * the portable module meet: turn our own user id into an Authentik uuid (glue,
 * src/services/entitlementSubject.legacy.ts — deleted on port), then hand that
 * uuid to the module (src/services/entitlements — copied verbatim on port).
 * Porting this function means replacing ONE line: wherever the Postgres-only
 * backend gets its Authentik subject from.
 *
 * NEVER REJECTS. Grant resolution is a security decision on a read path, and
 * the correct outcome of a broken decision is "show less", not "show an error"
 * — so an unexpected throw anywhere beneath this (the services themselves are
 * written not to throw, and tested for it) is caught here and becomes a
 * redacted read rather than a 500.
 */
export async function assertionFor(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const subject = await resolveEntitlementSubject(userId);
    if (subject === null) return null;
    return await entitlementHeaderFor(subject);
  } catch (err) {
    console.error('[COMPARE] entitlement resolution failed — reading without an assertion:', (err as Error).message);
    return null;
  }
}

async function handleCompare(req: Request, res: Response, seed: CompareSeed): Promise<Response> {
  // Read env at call time (not module load) so degraded mode reacts to env
  // changes without a restart — mirrors mediaManagerClient.ts's pattern.
  const client = createSpineReadClientFromEnv();
  if (!client) {
    // SPINE_READ_URL unset (e.g. fc-backend prod on Coolify pre-k3s-cutover,
    // where the cluster-internal spine service is unreachable) -> 503
    // WITHOUT attempting a call.
    return res.status(503).json({ success: false, code: 'SPINE_READ_UNCONFIGURED' });
  }

  // Minted HERE, per request — the RPC never reads wall time server-side.
  const nowIso = new Date().toISOString();

  // Resolved AFTER the degraded-mode check: there is no point asking OpenFGA
  // who someone is when the read cannot happen at all.
  const assertion = await assertionFor(req.user?.id);

  let response;
  try {
    response = await client.compare(seed, nowIso, assertion);
  } catch (err) {
    const connectError = ConnectError.from(err);
    // Log server-side ONLY: connectError.rawMessage may be a genuine
    // RPC-level message from the spine, but it may also be the message of
    // a raw Node network error (ECONNREFUSED/ENOTFOUND/etc.) that
    // ConnectError.from() wraps verbatim — which embeds the literal
    // internal SPINE_READ_URL host:port. Never put rawMessage in the
    // response body for anything but a deliberate spine-side
    // InvalidArgument rejection.
    console.error('[COMPARE] spine RPC failed:', grpcStatusName(connectError.code), connectError.rawMessage);
    if (connectError.code === Code.InvalidArgument) {
      return res.status(400).json({
        success: false,
        code: grpcStatusName(connectError.code),
        message: connectError.rawMessage,
      });
    }
    // Unavailable, DeadlineExceeded (the per-call timeout tripped — see
    // DEFAULT_COMPARE_TIMEOUT_MS), and any other infra-shaped fault -> 502
    // with the connect code surfaced but a fixed, safe message. NEVER a
    // hang: the client always resolves or rejects within its timeout.
    return res.status(502).json({
      success: false,
      code: grpcStatusName(connectError.code),
      message: 'upstream spine RPC failed',
    });
  }

  // resultJson is the spine's CompareResult as JSON TEXT (read.proto
  // FIDELITY DOCTRINE) — JSON.parse preserves every string amount
  // verbatim (a quoted "295" stays the JS string "295", never coerced to
  // a float). Spread verbatim into the response, plus the asOf echo.
  //
  // VERBATIM INCLUDES `coverage.redacted`: it is the ONLY thing that lets the
  // UI tell "this store publishes no stock count" from "you may not see this
  // store's stock count". Filter it out and every unentitled surface renders a
  // confident zero, which is a false negative rather than a blank.
  //
  // Parsed in its OWN try/catch, separate from the RPC call above: a
  // parse failure here is a LOCAL deserialization bug (malformed
  // resultJson from the spine), not an RPC fault, and must never be
  // conflated with the ConnectError codes/handling above nor leak the
  // parser's raw message (which can echo fragments of the upstream
  // payload back to the caller).
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(response.resultJson) as Record<string, unknown>;
  } catch (err) {
    console.error('[COMPARE] malformed resultJson from spine:', (err as Error).message);
    return res.status(502).json({
      success: false,
      code: 'BAD_UPSTREAM_RESPONSE',
      message: 'spine returned a malformed result',
    });
  }
  return res.status(200).json({ ...result, asOf: nowIso });
}

export default router;
