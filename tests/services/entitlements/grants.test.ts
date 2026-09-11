/**
 * Entitlement GRANT resolution tests (D6 U6): the OpenFGA Check that decides
 * whether fc-backend mints an assertion at all.
 *
 * THE RULE UNDER TEST IS THE B1 FAIL-OPEN LESSON: any Check that does not come
 * back as an explicit `allowed: true` is a DENY. A 500, a refused connection, a
 * timeout, a body of the wrong shape, an unconfigured client — all of them end
 * in an empty grant list, no header, and a normal redacted read. There is no
 * error path that reaches the user, because a gate that fails loudly is a gate
 * that can be knocked over.
 *
 * Driven against a REAL in-process OpenFGA stub rather than a mocked axios, so
 * the request SHAPE (path, body, bearer) is pinned too — that shape is the part
 * that silently returns `allowed:false` forever if it is wrong.
 *
 * NO DATABASE, NO USER MODEL, NO FIXTURES BUT FAKES AND GENERATED KEYPAIRS.
 * This file ports to the Postgres-only backend unchanged, which is the point:
 * the module under test takes a subject STRING, so its suite never needs to
 * know how a subject is produced. Mapping a logged-in user to one is legacy
 * glue and is tested in tests/services/entitlementSubject.legacy.test.ts.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import {
  grantsForSubject,
  entitlementHeaderFor,
  entitlementGrantCounters,
  resetEntitlementGrantsForTest,
} from '../../../src/services/entitlements/grants';
import { resetEntitlementSigningForTest } from '../../../src/services/entitlements/assertion';
import { generateTestSigningKey, verifyEntitlementHeader } from '../../helpers/entitlementVerifier';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const OTHER_SUB = '11111111-2222-3333-4444-555555555555';
const STORE_ID = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const TOKEN = 'test-preshared-key-never-logged';

interface Captured {
  path: string;
  method: string;
  authorization?: string;
  body: any;
}

interface Stub {
  baseUrl: string;
  captured: Captured[];
  close: () => Promise<void>;
}

type Handler = (captured: Captured, res: http.ServerResponse) => void;

async function startFga(handler: Handler): Promise<Stub> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const entry: Captured = {
        path: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
        body,
      };
      captured.push(entry);
      handler(entry, res);
    });
  });
  const sockets = new Set<Socket>();
  server.on('connection', s => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const allowed = (value: boolean): Handler => (_c, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ allowed: value, resolution: '' }));
};

const ENV_KEYS = [
  'OPENFGA_API_URL',
  'OPENFGA_STORE_ID',
  'OPENFGA_API_TOKEN',
  'OPENFGA_MODEL_ID',
  'OPENFGA_APP_OBJECT',
  'OPENFGA_TIMEOUT_MS',
  'ENTITLEMENT_GRANT_CACHE_TTL_MS',
  'ENTITLEMENT_GRANT_ERROR_TTL_MS',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
] as const;

let saved: Record<string, string | undefined> = {};
let stub: Stub | null = null;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

const allLoggedText = (): string =>
  [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
    .map(args => args.map(String).join(' '))
    .join('\n');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  if (stub) {
    await stub.close();
    stub = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
});

const configure = (baseUrl: string, extra: Record<string, string> = {}): void => {
  process.env.OPENFGA_API_URL = baseUrl;
  process.env.OPENFGA_STORE_ID = STORE_ID;
  process.env.OPENFGA_API_TOKEN = TOKEN;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
};

describe('grantsForSubject — the Check', () => {
  it('returns the inventory_levels grant when OpenFGA allows', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(entitlementGrantCounters().allow).toBe(1);
  });

  it('sends the Check OpenFGA expects: POST /stores/<id>/check with the app-level tuple and a bearer', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    await grantsForSubject(SUB);

    expect(stub.captured).toHaveLength(1);
    const call = stub.captured[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/stores/${STORE_ID}/check`);
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    // The subject is `user:<authentik uuid>`; the relation and object are the
    // app-level pair from the B1 model — never a per-object feature join.
    expect(call.body.tuple_key).toEqual({
      user: `user:${SUB}`,
      relation: INVENTORY_LEVELS,
      object: 'app:figurecollecting',
    });
    expect(call.body.authorization_model_id).toBeUndefined();
  });

  it('pins the authorization model when one is configured', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl, { OPENFGA_MODEL_ID: '01KXA5NRMNY7C8MZETNYXQT1CJ' });

    await grantsForSubject(SUB);
    expect(stub.captured[0].body.authorization_model_id).toBe('01KXA5NRMNY7C8MZETNYXQT1CJ');
  });

  it('honours an overridden app object', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl, { OPENFGA_APP_OBJECT: 'app:staging' });

    await grantsForSubject(SUB);
    expect(stub.captured[0].body.tuple_key.object).toBe('app:staging');
  });

  it('returns no grants when OpenFGA denies', async () => {
    stub = await startFga(allowed(false));
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters().deny).toBe(1);
  });
});

describe('grantsForSubject — every failure is a DENY (the B1 fail-open lesson)', () => {
  it('denies on a 500 from OpenFGA', async () => {
    stub = await startFga((_c, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"code":"internal_error"}');
    });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters().error).toBe(1);
  });

  it('denies on a 401 — a bad preshared key must not open the gate', async () => {
    stub = await startFga((_c, res) => {
      res.writeHead(401);
      res.end('{"code":"unauthenticated"}');
    });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters().error).toBe(1);
  });

  it('denies when the connection is refused', async () => {
    // A port nothing listens on: start a stub, take its URL, then close it.
    const dead = await startFga(allowed(true));
    const deadUrl = dead.baseUrl;
    await dead.close();
    configure(deadUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters().error).toBe(1);
  });

  it('denies when the Check outruns its timeout', async () => {
    stub = await startFga(() => {
      /* never responds */
    });
    configure(stub.baseUrl, { OPENFGA_TIMEOUT_MS: '120' });

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters().error).toBe(1);
  });

  it.each([
    ['a body with no allowed field', '{"resolution":""}'],
    ['a truthy string instead of a boolean', '{"allowed":"true"}'],
    ['a non-object body', '"allowed"'],
    ['unparseable JSON', '{not json'],
  ])('denies on %s', async (_label, payload) => {
    stub = await startFga((_c, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
  });

  it.each([['empty', ''], ['blank', '  ']])('denies a %s subject without calling OpenFGA', async (_l, sub) => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    await expect(grantsForSubject(sub)).resolves.toEqual([]);
    expect(stub.captured).toHaveLength(0);
  });
});

describe('grantsForSubject — unconfigured', () => {
  it('denies with ONE warning and no network call when OpenFGA is not configured', async () => {
    // Two DISTINCT subjects, so neither is answered from the other's cache
    // entry: the point is that the warning is one-shot for the PROCESS, not
    // one per user, which is the difference between a line an operator reads
    // and a line an operator filters out.
    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    await expect(grantsForSubject(OTHER_SUB)).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(entitlementGrantCounters().unconfigured).toBe(2);
  });

  it('denies when the store id is missing even though the URL is set', async () => {
    stub = await startFga(allowed(true));
    process.env.OPENFGA_API_URL = stub.baseUrl;

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(stub.captured).toHaveLength(0);
  });
});

describe('grantsForSubject — caching keeps the hot read path off OpenFGA', () => {
  it('serves a repeat check for the same subject from cache', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 5_000);
    await grantsForSubject(SUB, 30_000);

    expect(stub.captured).toHaveLength(1);
    expect(entitlementGrantCounters().cache_hit).toBe(2);
  });

  it('re-checks once the TTL has passed', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 31_001);

    expect(stub.captured).toHaveLength(2);
  });

  it('caches denies too — a revoked user does not cost a Check per request', async () => {
    stub = await startFga(allowed(false));
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 2_000);

    expect(stub.captured).toHaveLength(1);
  });

  it('keys the cache per subject', async () => {
    stub = await startFga((c, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ allowed: c.body.tuple_key.user === `user:${SUB}` }));
    });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB, 1_000)).resolves.toEqual([INVENTORY_LEVELS]);
    await expect(grantsForSubject(OTHER_SUB, 1_000)).resolves.toEqual([]);
    await expect(grantsForSubject(SUB, 2_000)).resolves.toEqual([INVENTORY_LEVELS]);

    expect(stub.captured).toHaveLength(2);
  });

  it('caches an ERROR deny only briefly, so an OpenFGA blip does not pin a user out for the full TTL', async () => {
    let fail = true;
    stub = await startFga((_c, res) => {
      if (fail) {
        res.writeHead(500);
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"allowed":true}');
    });
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000', ENTITLEMENT_GRANT_ERROR_TTL_MS: '5000' });

    await expect(grantsForSubject(SUB, 1_000)).resolves.toEqual([]);
    // Inside the short error window: still denied, still no second call.
    await expect(grantsForSubject(SUB, 3_000)).resolves.toEqual([]);
    expect(stub.captured).toHaveLength(1);

    fail = false;
    // Past it, long before the success TTL would have expired.
    await expect(grantsForSubject(SUB, 7_000)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(stub.captured).toHaveLength(2);
  });

  it('collapses concurrent checks for one subject into a single upstream call', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    stub = await startFga((_c, res) => {
      void gate.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"allowed":true}');
      });
    });
    configure(stub.baseUrl);

    const all = Promise.all([
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
    ]);
    release!();
    const results = await all;

    expect(results.every(r => r.length === 1)).toBe(true);
    expect(stub.captured).toHaveLength(1);
  });
});

describe('secret hygiene', () => {
  it('never logs the preshared key, even when the Check fails', async () => {
    stub = await startFga((_c, res) => {
      res.writeHead(500);
      res.end('{"code":"internal_error"}');
    });
    configure(stub.baseUrl);

    await grantsForSubject(SUB);
    expect(allLoggedText()).not.toContain(TOKEN);
  });
});


describe('entitlementHeaderFor — the module in one call', () => {
  const KID = 'ent-test-2026-09';

  const withKey = (): ReturnType<typeof generateTestSigningKey> => {
    const kp = generateTestSigningKey(KID);
    process.env.ENTITLEMENT_SIGNING_KEY_PEM = kp.privatePem;
    process.env.ENTITLEMENT_SIGNING_KID = KID;
    return kp;
  };

  it('checks, then signs: the header verifies and names the subject it was checked for', async () => {
    const kp = withKey();
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    const header = await entitlementHeaderFor(SUB);

    const verified = verifyEntitlementHeader(header, kp.keys);
    expect(verified.outcome).toBe('granted');
    expect(verified.sub).toBe(SUB);
    expect([...verified.grants]).toEqual([INVENTORY_LEVELS]);
    // The subject signed is the subject checked — not one resolved twice.
    expect(stub.captured[0].body.tuple_key.user).toBe(`user:${SUB}`);
  });

  it('returns null when the Check denies', async () => {
    withKey();
    stub = await startFga(allowed(false));
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it('returns null when the Check errors', async () => {
    withKey();
    stub = await startFga((_c, res) => {
      res.writeHead(500);
      res.end('{}');
    });
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it('returns null when there is no signing key, even on an allow', async () => {
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it.each([['empty', ''], ['blank', '   ']])('returns null for a %s subject, without calling OpenFGA', async (_l, sub) => {
    withKey();
    stub = await startFga(allowed(true));
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(sub)).resolves.toBeNull();
    expect(stub.captured).toHaveLength(0);
  });
});
