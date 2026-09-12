/**
 * entitlementSubject.legacy.ts — LEGACY GLUE. NOT PART OF THE PORTABLE MODULE.
 *
 * DELETE THIS FILE WHEN PORTING to the Postgres-only fc-backend, along with the
 * `authentikId` field on src/models/User.ts that it reads. Its whole job is to
 * answer one question in terms this Mongo-backed app can answer it:
 *
 *     given the id in our own JWT, what is this person's Authentik uuid?
 *
 * In the Postgres-only backend the answer comes from somewhere else entirely —
 * quite possibly the session subject itself, with no lookup at all. That is
 * precisely why it is here and not inside src/services/entitlements, which
 * accepts a subject string and never asks where it came from.
 *
 * WHY THE MAPPING EXISTS AT ALL. This service authenticates with its own JWT
 * over Mongo user documents, so `req.user.id` is a Mongo ObjectId. The estate's
 * authorization graph keys every subject by Authentik uuid: that is what
 * fc-infra's grant script writes, and what the assertion's `sub` must carry.
 * The two are unrelated identifiers, and OpenFGA resolves neither — it stores
 * whatever string it is given, so handing it a Mongo id would look like a
 * working Check while answering for a user that does not exist in the graph.
 *
 * NO LINK MEANS NO SUBJECT MEANS DENY, and deliberately WITHOUT asking OpenFGA.
 */
import mongoose from 'mongoose';
import User from '../models/User';

/**
 * OpenFGA stores a subject string VERBATIM and never resolves it: a wrong-shaped
 * subject is not an error, it is a grant for a user that will never exist. Same
 * guard as fc-infra tools/entitlements/grant-inventory-levels.sh, so the two
 * sides cannot disagree about what a subject looks like.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The Authentik uuid for one fc-backend user, or `null` if there is none.
 *
 * NEVER REJECTS: a sick database denies the entitlement, it does not turn a
 * read into a 500.
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
