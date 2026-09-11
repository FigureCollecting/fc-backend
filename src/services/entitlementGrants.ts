/**
 * entitlementGrants.ts — D6 U6: decide what a caller is entitled to see,
 * BEFORE anything is minted (spec §3(b), §3(d)).
 *
 * ONE QUESTION, ASKED OF OPENFGA: `Check(user:<authentik uuid>,
 * inventory_levels, app:figurecollecting)`. The relation is APP-LEVEL and the
 * object is the app — never a per-object feature join, which is the H-2 leak
 * the B1 model was reshaped to avoid (see fc-infra nodes/fc-ha-01/manifests/
 * b1-model.fga). The model defines the grant as an INTERSECTION with `member`,
 * so a stray direct tuple for a non-member confers nothing; that invariant is
 * the graph's to keep, and this module simply believes the answer.
 *
 * THE RULE THAT MATTERS: ANY CHECK THAT IS NOT AN EXPLICIT `allowed: true` IS
 * A DENY. A 500, a refused connection, a timeout, a body of an unexpected
 * shape, an unconfigured client, a user with no Authentik identity — all of
 * them return no grants. This is the B1 fail-open lesson written down: an
 * authorization model cannot express "an error means no", so the CALLER has to,
 * and the caller is this file. The graph's own suite asserts the positive
 * cases; this suite asserts the negative ones.
 *
 * DENIAL IS NOT AN ERROR ANYWHERE ABOVE THIS LINE. A denied caller gets a
 * normal 200 whose stock magnitudes are simply absent, marked by
 * `coverage.redacted`. Nothing here throws, and nothing here changes a status
 * code: a gate that answers differently when it fails is an existence oracle,
 * and one that 500s is a gate an attacker can knock over to make the system
 * choose between broken and open.
 *
 * WHY A CACHE. This sits on the read hot path, and OpenFGA is a cross-cluster
 * hop (it lives on the auth node, not beside fc-backend). A short per-subject
 * TTL keeps a page of comparisons down to one Check. The cost is propagation
 * delay on a grant or a revoke, bounded by the TTL and already bounded by the
 * assertion's own 60-second lifetime — the same order of magnitude, so the
 * cache does not meaningfully widen the window that already exists.
 *
 * WHY ERRORS GET THEIR OWN, SHORTER TTL. Caching an error-deny for the full
 * window would turn a momentary OpenFGA blip into minutes of silently missing
 * numbers; not caching it at all would point a retry storm at the service that
 * is already unwell. A few seconds is the compromise: the storm is damped, and
 * recovery is quick.
 */
import axios from 'axios';
import mongoose from 'mongoose';
import { INVENTORY_LEVELS, type EntitlementName } from '@figurecollecting/ingest-contract/entitlement';
import User from '../models/User';

/** Nothing granted. A frozen shared value so a caller cannot mutate the denial. */
const NO_GRANTS: readonly EntitlementName[] = Object.freeze([]);
const INVENTORY_GRANT: readonly EntitlementName[] = Object.freeze([INVENTORY_LEVELS]);

/** The app object the entitlement hangs off. Overridable so a staging tenant is a config change. */
const DEFAULT_APP_OBJECT = 'app:figurecollecting';
/** Long enough to take the hot path off OpenFGA, short enough that a revoke lands promptly. */
const DEFAULT_CACHE_TTL_MS = 30_000;
/** A failed Check is remembered only briefly — see the header note. */
const DEFAULT_ERROR_TTL_MS = 5_000;
/** Tight by intent: this is a blocking hop inside a user-facing read. */
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * OpenFGA stores a subject string VERBATIM and never resolves it: a wrong-shaped
 * subject is not an error, it is a grant for a user that will never exist. Same
 * guard as fc-infra tools/entitlements/grant-inventory-levels.sh, so the two
 * sides cannot disagree about what a subject looks like.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface CacheEntry {
  grants: readonly EntitlementName[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<readonly EntitlementName[]>>();
const counters = new Map<string, number>();
let warnedUnconfigured = false;

const bump = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

/** Snapshot: `allow`, `deny`, `error`, `unconfigured`, `no_subject`, `cache_hit`, `coalesced`. */
export const entitlementGrantCounters = (): Readonly<Record<string, number>> => Object.fromEntries(counters);

/** Test seam: drop the cache, the in-flight map, the counters and the one-shot warning. */
export const resetEntitlementGrantsForTest = (): void => {
  cache.clear();
  inflight.clear();
  counters.clear();
  warnedUnconfigured = false;
};

const num = (raw: string | undefined, fallback: number): number => {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/**
 * Ask OpenFGA. Resolves to `true` ONLY on an explicit `allowed: true`;
 * everything else resolves to `false` and is counted as an error rather than a
 * deny, so an operator can tell a revoked user apart from a sick dependency.
 */
async function check(subject: string, env: NodeJS.ProcessEnv): Promise<{ allowed: boolean; errored: boolean }> {
  const apiUrl = env.OPENFGA_API_URL?.trim();
  const storeId = env.OPENFGA_STORE_ID?.trim();
  if (!apiUrl || !storeId) {
    bump('unconfigured');
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        '[ENTITLEMENT] OpenFGA is not configured (OPENFGA_API_URL / OPENFGA_STORE_ID) — every entitlement check denies and spine reads come back redacted. Expected until the authz substrate is wired.'
      );
    }
    return { allowed: false, errored: false };
  }

  const body: Record<string, unknown> = {
    tuple_key: {
      user: `user:${subject}`,
      relation: INVENTORY_LEVELS,
      object: env.OPENFGA_APP_OBJECT?.trim() || DEFAULT_APP_OBJECT,
    },
  };
  // Pinning the model id makes the answer reproducible across a model rollout;
  // without it OpenFGA evaluates against whatever the latest model is.
  const modelId = env.OPENFGA_MODEL_ID?.trim();
  if (modelId) body.authorization_model_id = modelId;

  const token = env.OPENFGA_API_TOKEN?.trim();
  try {
    const response = await axios.post(`${apiUrl.replace(/\/+$/, '')}/stores/${storeId}/check`, body, {
      timeout: num(env.OPENFGA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const data: unknown = response.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      // A 200 carrying something that is not a Check response is a wire-level
      // surprise, not a decision. Treated as a fault so it shows up as one.
      console.error('[ENTITLEMENT] OpenFGA Check returned an unexpected body shape — denying');
      return { allowed: false, errored: true };
    }
    const allowed = (data as { allowed?: unknown }).allowed;
    if (typeof allowed !== 'boolean') {
      console.error('[ENTITLEMENT] OpenFGA Check response has no boolean `allowed` — denying');
      return { allowed: false, errored: true };
    }
    return { allowed, errored: false };
  } catch (err) {
    // The message ONLY. An axios error carries the full request config,
    // headers included, so anything broader than this prints the preshared key.
    console.error('[ENTITLEMENT] OpenFGA Check failed — denying:', (err as Error).message);
    return { allowed: false, errored: true };
  }
}

/**
 * What this subject may see. `nowMs` is injected so cache expiry is testable
 * without sleeping.
 */
export async function grantsForSubject(
  subject: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly EntitlementName[]> {
  if (subject.trim() === '') {
    bump('no_subject');
    return NO_GRANTS;
  }

  const hit = cache.get(subject);
  if (hit !== undefined && nowMs < hit.expiresAt) {
    bump('cache_hit');
    return hit.grants;
  }

  // One Check per subject in flight. Without this, a cold cache under load
  // sends OpenFGA one request per concurrent read for the SAME answer.
  const pending = inflight.get(subject);
  if (pending !== undefined) {
    bump('coalesced');
    return pending;
  }

  const run = (async (): Promise<readonly EntitlementName[]> => {
    const { allowed, errored } = await check(subject, env);
    const grants = allowed ? INVENTORY_GRANT : NO_GRANTS;
    bump(errored ? 'error' : allowed ? 'allow' : 'deny');
    const ttl = errored
      ? num(env.ENTITLEMENT_GRANT_ERROR_TTL_MS, DEFAULT_ERROR_TTL_MS)
      : num(env.ENTITLEMENT_GRANT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
    cache.set(subject, { grants, expiresAt: nowMs + ttl });
    return grants;
  })();

  inflight.set(subject, run);
  try {
    return await run;
  } finally {
    inflight.delete(subject);
  }
}

/**
 * The OpenFGA subject for one fc-backend user, or `null` if there is none.
 *
 * WHY THIS IS NOT THE MONGO _id. OpenFGA's subjects are Authentik user uuids —
 * that is what fc-infra's grant script writes and what the assertion's `sub`
 * must carry. fc-backend's own user identity is a Mongo ObjectId, so a user is
 * entitleable only once the two are linked, which is what `authentikId` on the
 * User model records. Until Authentik is the login for this service that field
 * is set for the handful of accounts that need it (the owner's first grant);
 * afterwards it is populated at sign-in.
 *
 * NO LINK MEANS NO SUBJECT MEANS DENY — and deliberately WITHOUT asking
 * OpenFGA: sending the Mongo id as a subject would look like a working check
 * and quietly answer for a user that does not exist in the graph.
 */
export async function resolveEntitlementSubject(userId: string): Promise<string | null> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;
  try {
    const user = await User.findById(userId).select('authentikId').lean<{ authentikId?: string } | null>();
    const authentikId = user?.authentikId?.trim();
    if (!authentikId || !UUID_RE.test(authentikId)) return null;
    return authentikId;
  } catch (err) {
    console.error('[ENTITLEMENT] could not resolve the entitlement subject — denying:', (err as Error).message);
    return null;
  }
}

export interface UserEntitlements {
  /** The OpenFGA/assertion subject, or `null` when this user has no Authentik identity. */
  sub: string | null;
  /** What the Check said they hold. Always empty when `sub` is null. */
  ent: readonly EntitlementName[];
}

/**
 * What this fc-backend user may see, and the subject the answer was reached
 * for. The route's entry point.
 *
 * It returns BOTH because the assertion has to name the same subject the Check
 * was run for. Handing back only the grants would force the caller to resolve
 * the identity a second time, and two independent resolutions of "who is this"
 * are two chances to sign a grant that was checked for somebody else.
 */
export async function entitlementsForUser(
  userId: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<UserEntitlements> {
  const sub = await resolveEntitlementSubject(userId);
  if (sub === null) {
    bump('no_subject');
    return { sub: null, ent: NO_GRANTS };
  }
  return { sub, ent: await grantsForSubject(sub, nowMs, env) };
}
