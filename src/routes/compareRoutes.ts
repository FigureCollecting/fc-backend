/**
 * Compare Routes — SCREEN surface for the spine's read.v1 SpineRead.Compare
 * RPC (see src/services/spineReadClient.ts). THIN READ-THROUGH ONLY: no
 * buy/sell framing, no landed-cost, no comps (HELD for product vision).
 *
 * JWT-protected with the same `protect` middleware as the other protected
 * routes (e.g. lookupRoutes). now_iso is minted at THIS edge, per request —
 * the RPC never reads wall time server-side.
 */
import express, { Request, Response } from 'express';
import { protect } from '../middleware/authMiddleware';
import {
  createSpineReadClientFromEnv,
  Code,
  ConnectError,
  type CompareSeed,
} from '../services/spineReadClient';

const router = express.Router();

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
  return handleCompare(res, { gtin14 });
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
  return handleCompare(res, { headId });
});

/** Canonical gRPC status name (e.g. Code.InvalidArgument -> 'INVALID_ARGUMENT'),
 * consistent with this module's other SCREAMING_SNAKE codes. */
const grpcStatusName = (code: Code): string => Code[code].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

async function handleCompare(res: Response, seed: CompareSeed): Promise<Response> {
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

  try {
    const response = await client.compare(seed, nowIso);
    // resultJson is the spine's CompareResult as JSON TEXT (read.proto
    // FIDELITY DOCTRINE) — JSON.parse preserves every string amount
    // verbatim (a quoted "295" stays the JS string "295", never coerced to
    // a float). Spread verbatim into the response, plus the asOf echo.
    const result = JSON.parse(response.resultJson) as Record<string, unknown>;
    return res.status(200).json({ ...result, asOf: nowIso });
  } catch (err) {
    const connectError = ConnectError.from(err);
    if (connectError.code === Code.InvalidArgument) {
      return res.status(400).json({
        success: false,
        code: grpcStatusName(connectError.code),
        message: connectError.rawMessage,
      });
    }
    // Unavailable, DeadlineExceeded (the per-call timeout tripped — see
    // DEFAULT_COMPARE_TIMEOUT_MS), and any other infra-shaped fault -> 502
    // with the connect code surfaced. NEVER a hang: the client always
    // resolves or rejects within its timeout.
    return res.status(502).json({
      success: false,
      code: grpcStatusName(connectError.code),
      message: connectError.rawMessage,
    });
  }
}

export default router;
