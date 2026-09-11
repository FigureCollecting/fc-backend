/**
 * Integration tests for Compare Routes (SCREEN surface for read.v1
 * SpineRead.Compare). Runs supertest against the real Express app wired
 * through createTestApp(), talking to an IN-PROCESS SpineRead stub — a
 * plain node:http (HTTP/1.1) server + connectNodeAdapter, exactly the
 * cleartext shape the production spine serves. Regression-pins the
 * spineReadClient's h1 transport choice end-to-end through the route: if
 * that transport were ever swapped to createGrpcTransport (needs h2), every
 * "happy path" case here would fail against this h1 stub.
 */
import * as http from 'node:http';
import type * as httpTypes from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import request from 'supertest';
import mongoose from 'mongoose';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { SpineRead, CompareResponseSchema, type CompareRequest as WireCompareRequest, type CompareResponse as WireCompareResponse } from '@figurecollecting/ingest-contract/read';
import { ENTITLEMENTS_HEADER, INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import { createTestApp } from '../helpers/testApp';
import User from '../../src/models/User';
import { generateTestToken } from '../setup';
import { generateTestSigningKey, verifyEntitlementHeader } from '../helpers/entitlementVerifier';
import * as grantsModule from '../../src/services/entitlementGrants';
import { assertionFor } from '../../src/routes/compareRoutes';
import { resetEntitlementGrantsForTest } from '../../src/services/entitlementGrants';
import { resetEntitlementSigningForTest } from '../../src/services/entitlementAssertion';

const app = createTestApp();

const VALID_GTIN14 = '04570232591998';
const VALID_HEAD_ID = '11111111-2222-3333-4444-555555555555';

const FIXTURE_RESULT = {
  heads: [
    {
      head: 'head-1',
      perStore: [{ store: 'mfc', offers: [{ price: { amount: '295', currency: 'JPY' } }] }],
      editions: [],
    },
  ],
  related: [],
  coverage: {},
};

type StubImpl = (req: WireCompareRequest) => Promise<WireCompareResponse> | WireCompareResponse;

interface StubServer {
  baseUrl: string;
  /** Request metadata the spine stub saw, one entry per call. */
  capturedHeaders: Headers[];
  close: () => Promise<void>;
}

async function startStub(impl: StubImpl): Promise<StubServer> {
  const capturedHeaders: Headers[] = [];
  const routes = (router: ConnectRouter) => {
    router.service(SpineRead, {
      compare: async (req: WireCompareRequest, ctx: { requestHeader: Headers }) => {
        capturedHeaders.push(ctx.requestHeader);
        return impl(req);
      },
    });
  };
  const server = http.createServer(connectNodeAdapter({ routes }));
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    capturedHeaders,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('Compare Routes', () => {
  let authToken: string;
  const fixedUserId = new mongoose.Types.ObjectId('000000000000000000000789');
  let stub: StubServer | null = null;
  const ORIGINAL_SPINE_READ_URL = process.env.SPINE_READ_URL;

  beforeEach(async () => {
    await User.create({
      _id: fixedUserId,
      username: 'compareTestUser',
      email: 'compare@test.com',
      password: 'password123',
    });
    authToken = generateTestToken(fixedUserId.toString());
  });

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
    if (ORIGINAL_SPINE_READ_URL === undefined) {
      delete process.env.SPINE_READ_URL;
    } else {
      process.env.SPINE_READ_URL = ORIGINAL_SPINE_READ_URL;
    }
  });

  describe('happy path', () => {
    it('GET /compare/by-gtin/:gtin14 returns the CompareResult verbatim plus asOf, "295" quoted (no float coercion)', async () => {
      stub = await startStub(() => create(CompareResponseSchema, { resultJson: JSON.stringify(FIXTURE_RESULT) }));
      process.env.SPINE_READ_URL = stub.baseUrl;

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.heads).toHaveLength(1);
      expect(res.body.heads[0].perStore[0].offers[0].price.amount).toBe('295');
      expect(typeof res.body.asOf).toBe('string');
      // Raw wire text must spell the amount as a quoted JSON string, never a bare number.
      expect(res.text).toContain('"295"');
      expect(res.text).not.toContain(':295,');
      expect(res.text).not.toContain(':295}');
    });

    it('GET /compare/by-head/:headId returns the CompareResult verbatim', async () => {
      let capturedSeed: WireCompareRequest['seed'] | undefined;
      stub = await startStub(req => {
        capturedSeed = req.seed;
        return create(CompareResponseSchema, { resultJson: JSON.stringify(FIXTURE_RESULT) });
      });
      process.env.SPINE_READ_URL = stub.baseUrl;

      const res = await request(app)
        .get(`/compare/by-head/${VALID_HEAD_ID}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.heads).toHaveLength(1);
      expect(capturedSeed?.case).toBe('headId');
      expect(capturedSeed?.value).toBe(VALID_HEAD_ID);
    });
  });

  describe('auth', () => {
    it('401 when unauthenticated', async () => {
      const res = await request(app).get(`/compare/by-gtin/${VALID_GTIN14}`);
      expect(res.status).toBe(401);
    });
  });

  describe('input validation', () => {
    it('400 for a gtin14 that is not 14 digits', async () => {
      const res = await request(app)
        .get('/compare/by-gtin/123')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_GTIN14');
    });

    it('400 for a headId that is not a UUID', async () => {
      const res = await request(app)
        .get('/compare/by-head/not-a-uuid')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_HEAD_ID');
    });
  });

  describe('degraded mode', () => {
    it('503 SPINE_READ_UNCONFIGURED when SPINE_READ_URL is unset, without attempting a call', async () => {
      delete process.env.SPINE_READ_URL;

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SPINE_READ_UNCONFIGURED');
    });
  });

  describe('RPC error mapping', () => {
    it('502 with the connect code surfaced on Unavailable', async () => {
      stub = await startStub(() => {
        throw new ConnectError('spine unavailable', Code.Unavailable);
      });
      process.env.SPINE_READ_URL = stub.baseUrl;

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('UNAVAILABLE');
    });

    it('400 when the spine itself rejects with InvalidArgument', async () => {
      stub = await startStub(() => {
        throw new ConnectError('seed must set exactly one of gtin14 or head_id', Code.InvalidArgument);
      });
      process.env.SPINE_READ_URL = stub.baseUrl;

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('error message safety (no internal leakage)', () => {
    it('502 without leaking the internal spine host/port on a connection-level failure (ECONNREFUSED)', async () => {
      // Nothing listens on 127.0.0.1:1 (a privileged port) -> immediate
      // ECONNREFUSED at the transport level, wrapped by ConnectError.from
      // into a raw Node error message that embeds the literal host:port.
      // That raw message must NEVER reach the authenticated caller.
      process.env.SPINE_READ_URL = 'http://127.0.0.1:1';
      process.env.SPINE_READ_TIMEOUT_MS = '2000';

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(502);
      expect(res.body.message).not.toMatch(/127\.0\.0\.1/);
      expect(res.body.message).not.toMatch(/ECONNREFUSED/i);

      delete process.env.SPINE_READ_TIMEOUT_MS;
    }, 15000);

    it('502 BAD_UPSTREAM_RESPONSE without leaking the JSON parser message when resultJson is malformed', async () => {
      stub = await startStub(() => create(CompareResponseSchema, { resultJson: '{not valid json' }));
      process.env.SPINE_READ_URL = stub.baseUrl;

      const res = await request(app)
        .get(`/compare/by-gtin/${VALID_GTIN14}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('BAD_UPSTREAM_RESPONSE');
      expect(res.body.message).not.toMatch(/JSON/i);
      expect(res.body.message).not.toMatch(/position/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (CodeQL js/missing-rate-limiting): the limiter must be wired
// into the router stack BEFORE protect. Wiring assertion (the limiter itself
// is test-env-skipped per repo convention, like figureRoutes) — this fails if
// the middleware is ever removed or reordered behind auth.
// ---------------------------------------------------------------------------
describe('rate limiting wiring', () => {
  it('mounts compareApiLimiter as the first layer, ahead of protect', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/routes/compareRoutes');
    const router = mod.default;
    const stack: Array<{ handle: { name: string } }> = router.stack;
    const names = stack.map((l) => l.handle.name);
    const limiterIdx = stack.findIndex((l) => l.handle === mod.compareApiLimiter);
    const protectIdx = names.indexOf('protect');
    expect(limiterIdx).toBeGreaterThanOrEqual(0);
    expect(protectIdx).toBeGreaterThan(limiterIdx);
  });
});

/**
 * D6 U6 — the entitlement gate END TO END through the route: an OpenFGA Check,
 * an Ed25519 assertion minted from its outcome, and the `fc-entitlements`
 * header on the SpineRead call. Both dependencies are REAL in-process servers
 * (a Connect spine stub and an HTTP OpenFGA stub), so the header either arrives
 * on the wire or it does not — there is no mock to agree with itself.
 *
 * EVERY CASE BELOW IS A 200. The difference between entitled and not is which
 * values the spine puts in the body, never a status code, never an error: a
 * gate that answers differently when it refuses is an existence oracle.
 */
describe('Compare Routes — entitlement assertion (D6 U6)', () => {
  const ROSS_UUID = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
  const STORE_ID = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
  const FGA_TOKEN = 'preshared-never-logged';

  const entitledUserId = new mongoose.Types.ObjectId('0000000000000000000005a1');
  const unlinkedUserId = new mongoose.Types.ObjectId('0000000000000000000005a2');

  interface FgaStub {
    baseUrl: string;
    captured: any[];
    close: () => Promise<void>;
  }

  async function startFga(respond: (res: httpTypes.ServerResponse) => void): Promise<FgaStub> {
    const captured: any[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        try {
          captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          captured.push(null);
        }
        respond(res);
      });
    });
    const sockets = new Set<Socket>();
    server.on('connection', sk => {
      sockets.add(sk);
      sk.once('close', () => sockets.delete(sk));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      captured,
      close: async () => {
        for (const sk of sockets) sk.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  }

  const fgaAllows = (allowed: boolean) => (res: httpTypes.ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ allowed }));
  };
  const fgaBroken = (res: httpTypes.ServerResponse): void => {
    res.writeHead(500);
    res.end('{"code":"internal_error"}');
  };

  const ENV_KEYS = [
    'SPINE_READ_URL',
    'OPENFGA_API_URL',
    'OPENFGA_STORE_ID',
    'OPENFGA_API_TOKEN',
    'ENTITLEMENT_SIGNING_KEY_PEM',
    'ENTITLEMENT_SIGNING_KID',
  ] as const;

  let savedEnv: Record<string, string | undefined> = {};
  let spine: StubServer | null = null;
  let fga: FgaStub | null = null;
  let keypair: ReturnType<typeof generateTestSigningKey>;
  let entitledToken: string;
  let unlinkedToken: string;
  let consoleOutput: string[] = [];
  let spies: jest.SpyInstance[] = [];

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    resetEntitlementGrantsForTest();
    resetEntitlementSigningForTest();

    keypair = generateTestSigningKey('ent-test-2026-09');
    process.env.ENTITLEMENT_SIGNING_KEY_PEM = keypair.privatePem;
    process.env.ENTITLEMENT_SIGNING_KID = keypair.kid;
    process.env.OPENFGA_STORE_ID = STORE_ID;
    process.env.OPENFGA_API_TOKEN = FGA_TOKEN;

    await User.create({
      _id: entitledUserId,
      username: 'linkedCompareUser',
      email: 'linked-compare@test.com',
      password: 'password123',
      authentikId: ROSS_UUID,
    });
    await User.create({
      _id: unlinkedUserId,
      username: 'unlinkedCompareUser',
      email: 'unlinked-compare@test.com',
      password: 'password123',
    });
    entitledToken = generateTestToken(entitledUserId.toString());
    unlinkedToken = generateTestToken(unlinkedUserId.toString());

    consoleOutput = [];
    spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map(String).join(' '));
      })
    );
  });

  afterEach(async () => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    if (spine) {
      await spine.close();
      spine = null;
    }
    if (fga) {
      await fga.close();
      fga = null;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    }
    resetEntitlementGrantsForTest();
    resetEntitlementSigningForTest();
  });

  /** Stand up both stubs and point the app at them. */
  async function wire(fgaResponder: (res: httpTypes.ServerResponse) => void, resultJson = JSON.stringify(FIXTURE_RESULT)): Promise<void> {
    spine = await startStub(() => create(CompareResponseSchema, { resultJson }));
    fga = await startFga(fgaResponder);
    process.env.SPINE_READ_URL = spine.baseUrl;
    process.env.OPENFGA_API_URL = fga.baseUrl;
  }

  const get = (token: string) =>
    request(app).get(`/compare/by-gtin/${VALID_GTIN14}`).set('Authorization', `Bearer ${token}`);

  const sentAssertion = (): string | null => spine!.capturedHeaders[0]?.get(ENTITLEMENTS_HEADER) ?? null;

  it('mints an assertion the spine verifier accepts when the Check allows', async () => {
    await wire(fgaAllows(true));

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    const assertion = sentAssertion();
    expect(assertion).not.toBeNull();

    const verified = verifyEntitlementHeader(assertion, keypair.keys);
    expect(verified.outcome).toBe('granted');
    expect(verified.sub).toBe(ROSS_UUID);
    expect([...verified.grants]).toEqual([INVENTORY_LEVELS]);

    // And the Check that authorised it asked the app-level question.
    expect(fga!.captured[0].tuple_key).toEqual({
      user: `user:${ROSS_UUID}`,
      relation: INVENTORY_LEVELS,
      object: 'app:figurecollecting',
    });
  });

  it('sends NO header when the Check denies — and still answers 200', async () => {
    await wire(fgaAllows(false));

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    expect(spine!.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
  });

  it('sends NO header when the Check ERRORS — the B1 fail-open lesson, end to end', async () => {
    await wire(fgaBroken);

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    expect(spine!.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
  });

  it('sends NO header, and runs NO Check, for a user with no Authentik identity', async () => {
    await wire(fgaAllows(true));

    const res = await get(unlinkedToken);

    expect(res.status).toBe(200);
    expect(spine!.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
    expect(fga!.captured).toHaveLength(0);
  });

  it('sends NO header when no signing key is configured, even for an entitled user', async () => {
    delete process.env.ENTITLEMENT_SIGNING_KEY_PEM;
    delete process.env.ENTITLEMENT_SIGNING_KID;
    resetEntitlementSigningForTest();
    await wire(fgaAllows(true));

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    expect(spine!.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
  });

  it('sends NO header when OpenFGA is not configured at all', async () => {
    spine = await startStub(() => create(CompareResponseSchema, { resultJson: JSON.stringify(FIXTURE_RESULT) }));
    process.env.SPINE_READ_URL = spine.baseUrl;
    delete process.env.OPENFGA_API_URL;

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    expect(spine.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
  });

  it('never logs the assertion or the OpenFGA preshared key', async () => {
    await wire(fgaAllows(true));

    await get(entitledToken);

    const assertion = sentAssertion() as string;
    const text = consoleOutput.join('\n');
    expect(text).not.toContain(assertion);
    expect(text).not.toContain(FGA_TOKEN);
    expect(text).not.toContain('PRIVATE KEY');
  });

  it('surfaces coverage.redacted so the client can tell "withheld" from "never observed"', async () => {
    const redacted = {
      ...FIXTURE_RESULT,
      coverage: { redacted: [INVENTORY_LEVELS], storesSeen: 1 },
    };
    await wire(fgaAllows(false), JSON.stringify(redacted));

    const res = await get(entitledToken);

    expect(res.status).toBe(200);
    // Passthrough is verbatim: the marker the spine set must reach the UI
    // untouched, or every unentitled surface renders a confident zero.
    expect(res.body.coverage.redacted).toEqual([INVENTORY_LEVELS]);
    expect(res.body.coverage.storesSeen).toBe(1);
  });

  it('reuses one Check across repeated reads by the same user', async () => {
    await wire(fgaAllows(true));

    await get(entitledToken);
    await get(entitledToken);
    await get(entitledToken);

    expect(fga!.captured).toHaveLength(1);
    expect(spine!.capturedHeaders).toHaveLength(3);
    for (const headers of spine!.capturedHeaders) {
      expect(headers.has(ENTITLEMENTS_HEADER)).toBe(true);
    }
  });

  it('mints nothing for a request with no authenticated user', async () => {
    // Unreachable through the route (`protect` runs first), which is exactly
    // why it is asserted directly: the helper's contract is "no user, no
    // assertion", and nothing else here would notice if that changed.
    await expect(assertionFor(undefined)).resolves.toBeNull();
  });

  it('serves a redacted read rather than a 500 when grant resolution throws unexpectedly', async () => {
    await wire(fgaAllows(true));
    const boom = jest
      .spyOn(grantsModule, 'entitlementsForUser')
      .mockRejectedValue(new Error('authz substrate exploded'));
    try {
      const res = await get(entitledToken);

      expect(res.status).toBe(200);
      expect(spine!.capturedHeaders[0].has(ENTITLEMENTS_HEADER)).toBe(false);
    } finally {
      boom.mockRestore();
    }
  });
});
