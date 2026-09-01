/**
 * Spine read client — Connect client for read.v1 SpineRead.Compare
 * (@figurecollecting/ingest-contract/read). This is fc-backend's SCREEN
 * surface for the spine's derived comparison view: fc-backend is the SINGLE
 * user-facing caller (lookup-caller-architecture, RATIFIED) — the frontend
 * never talks to the spine directly.
 *
 * SCOPE (this increment): THIN READ-THROUGH ONLY. NO buy/sell framing, NO
 * landed-cost, NO comps — those are HELD for the product vision. Callers get
 * neutral observations out (the spine's CompareResult, opaque JSON, passed
 * through verbatim).
 *
 * TRANSPORT (load-bearing — DO NOT CHANGE without re-validating the meshed
 * hop end-to-end): createConnectTransport({ baseUrl, httpVersion: '1.1' })
 * from @connectrpc/connect-node. The spine's ingest-server serves the
 * Connect protocol over cleartext HTTP/1.1 (Linkerd meshes h1 natively, no
 * appProtocol hint or opaque-port tuning needed). This RPC is UNARY, so
 * HTTP/2 buys nothing here. createGrpcTransport requires h2 and FAILS
 * against this server — mirrors scraper/src/services/ingestEmitter.ts's
 * TRANSPORT note for the sibling ingest RPC verbatim.
 */
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareRequestSchema,
  type CompareResponse,
} from '@figurecollecting/ingest-contract/read';

/** Per-call deadline. The spine's read RPC has no deadline of its own — a
 * caller-side timeout is the only thing standing between us and a hang. */
export const DEFAULT_COMPARE_TIMEOUT_MS = 10_000;

export type CompareSeed = { gtin14: string } | { headId: string };

export class SpineReadClient {
  private readonly client: Client<typeof SpineRead>;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_COMPARE_TIMEOUT_MS) {
    // Connect over HTTP/1.1 — see the TRANSPORT note above. NEVER
    // createGrpcTransport here.
    const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' });
    this.client = createClient(SpineRead, transport);
    this.timeoutMs = timeoutMs;
  }

  /**
   * Call SpineRead.Compare. `nowIso` is minted by the caller (this module
   * never reads wall time itself) — the RPC never reads wall time
   * server-side either (read.proto FIDELITY DOCTRINE): every verdict must
   * be reproducible from (gathered signals, cfg, now_iso).
   */
  async compare(seed: CompareSeed, nowIso: string): Promise<CompareResponse> {
    const request = create(CompareRequestSchema, {
      seed:
        'gtin14' in seed
          ? { case: 'gtin14' as const, value: seed.gtin14 }
          : { case: 'headId' as const, value: seed.headId },
      nowIso,
    });
    return this.client.compare(request, { timeoutMs: this.timeoutMs });
  }
}

/**
 * Build the client from SPINE_READ_URL. Unset/empty -> null: this is the
 * DEGRADED MODE seam (fc-backend prod still runs on Coolify pre-k3s-cutover,
 * where the cluster-internal spine service is unreachable) — callers must
 * treat null as "do not attempt a call" and surface 503
 * SPINE_READ_UNCONFIGURED without ever constructing a transport.
 */
export function createSpineReadClientFromEnv(env: NodeJS.ProcessEnv = process.env): SpineReadClient | null {
  const baseUrl = env.SPINE_READ_URL;
  if (!baseUrl) return null;

  const timeoutMs = env.SPINE_READ_TIMEOUT_MS ? Number(env.SPINE_READ_TIMEOUT_MS) : undefined;
  return new SpineReadClient(
    baseUrl,
    timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined
  );
}

export { Code, ConnectError };
