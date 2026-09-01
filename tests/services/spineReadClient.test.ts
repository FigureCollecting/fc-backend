/**
 * SpineReadClient tests — against an IN-PROCESS SpineRead stub: a plain
 * node:http (HTTP/1.1) server + connectNodeAdapter, the same cleartext h1
 * shape the production spine serves. This ALSO regression-pins the
 * transport choice in src/services/spineReadClient.ts: if that module's
 * createConnectTransport were ever swapped for createGrpcTransport (which
 * needs h2), every call here would fail — a plain node:http server cannot
 * serve an h2/h2c client, it has no ALPN/h2c upgrade handling.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareResponseSchema,
  type CompareRequest as WireCompareRequest,
  type CompareResponse as WireCompareResponse,
} from '@figurecollecting/ingest-contract/read';
import {
  SpineReadClient,
  createSpineReadClientFromEnv,
  DEFAULT_COMPARE_TIMEOUT_MS,
} from '../../src/services/spineReadClient';

type StubImpl = (req: WireCompareRequest) => Promise<WireCompareResponse> | WireCompareResponse;

interface StubServer {
  baseUrl: string;
  captured: WireCompareRequest[];
  callCount: () => number;
  close: () => Promise<void>;
}

const FIXTURE_RESULT = {
  heads: [
    {
      head: 'head-1',
      perStore: [
        { store: 'mfc', offers: [{ price: { amount: '295', currency: 'JPY' } }] },
      ],
      editions: [],
    },
  ],
  related: [],
  coverage: {},
};

const okResponse = (resultJson: string = JSON.stringify(FIXTURE_RESULT)): WireCompareResponse =>
  create(CompareResponseSchema, { resultJson });

/** In-process SpineRead stub: plain node:http (h1), ephemeral port. */
async function startStub(impl: StubImpl): Promise<StubServer> {
  const captured: WireCompareRequest[] = [];
  let calls = 0;

  const routes = (router: ConnectRouter) => {
    router.service(SpineRead, {
      compare: async (req: WireCompareRequest) => {
        calls++;
        captured.push(req);
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
    captured,
    callCount: () => calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<Code | 'OK'> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return ConnectError.from(e).code;
  }
};

describe('SpineReadClient', () => {
  let stub: StubServer | null = null;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  it('sends gtin14 seed + now_iso and returns result_json verbatim, "295" quoted (no float coercion)', async () => {
    stub = await startStub(() => okResponse());
    const client = new SpineReadClient(stub.baseUrl, 5000);

    const response = await client.compare({ gtin14: '04570232591998' }, '2026-08-19T00:00:00Z');

    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0].seed.case).toBe('gtin14');
    expect(stub.captured[0].seed.value).toBe('04570232591998');
    expect(stub.captured[0].nowIso).toBe('2026-08-19T00:00:00Z');
    expect(response.resultJson).toContain('"295"');
    expect(response.resultJson).not.toContain(':295,');
    expect(response.resultJson).not.toContain(':295}');
  });

  it('sends headId seed on the seed oneof', async () => {
    stub = await startStub(() => okResponse());
    const client = new SpineReadClient(stub.baseUrl, 5000);

    await client.compare({ headId: '11111111-2222-3333-4444-555555555555' }, '2026-08-19T00:00:00Z');

    expect(stub.captured[0].seed.case).toBe('headId');
    expect(stub.captured[0].seed.value).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('surfaces InvalidArgument from the spine', async () => {
    stub = await startStub(() => {
      throw new ConnectError('seed must set exactly one of gtin14 or head_id', Code.InvalidArgument);
    });
    const client = new SpineReadClient(stub.baseUrl, 5000);

    await expect(codeOf(client.compare({ gtin14: '04570232591998' }, '2026-08-19T00:00:00Z'))).resolves.toBe(
      Code.InvalidArgument
    );
  });

  it('surfaces Unavailable from the spine', async () => {
    stub = await startStub(() => {
      throw new ConnectError('database unreachable', Code.Unavailable);
    });
    const client = new SpineReadClient(stub.baseUrl, 5000);

    await expect(codeOf(client.compare({ gtin14: '04570232591998' }, '2026-08-19T00:00:00Z'))).resolves.toBe(
      Code.Unavailable
    );
  });

  it('applies the per-call timeout and never hangs (DeadlineExceeded, not a stall)', async () => {
    stub = await startStub(async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return okResponse();
    });
    const client = new SpineReadClient(stub.baseUrl, 100);

    await expect(codeOf(client.compare({ gtin14: '04570232591998' }, '2026-08-19T00:00:00Z'))).resolves.toBe(
      Code.DeadlineExceeded
    );
  });

  describe('createSpineReadClientFromEnv', () => {
    it('returns null when SPINE_READ_URL is unset (degraded mode)', () => {
      expect(createSpineReadClientFromEnv({})).toBeNull();
      expect(createSpineReadClientFromEnv({ SPINE_READ_URL: '' })).toBeNull();
    });

    it('builds a client when SPINE_READ_URL is set', () => {
      const client = createSpineReadClientFromEnv({ SPINE_READ_URL: 'http://ingest-server.fc.svc.cluster.local:50051' });
      expect(client).toBeInstanceOf(SpineReadClient);
    });

    it('honors SPINE_READ_TIMEOUT_MS and falls back to the default when unset/invalid', async () => {
      stub = await startStub(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return okResponse();
      });
      const client = createSpineReadClientFromEnv({
        SPINE_READ_URL: stub.baseUrl,
        SPINE_READ_TIMEOUT_MS: '100',
      })!;

      await expect(codeOf(client.compare({ gtin14: '04570232591998' }, '2026-08-19T00:00:00Z'))).resolves.toBe(
        Code.DeadlineExceeded
      );
      expect(DEFAULT_COMPARE_TIMEOUT_MS).toBe(10_000);
    });
  });
});
