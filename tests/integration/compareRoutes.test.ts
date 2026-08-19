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
import type { AddressInfo, Socket } from 'node:net';
import request from 'supertest';
import mongoose from 'mongoose';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { SpineRead, CompareResponseSchema, type CompareRequest as WireCompareRequest, type CompareResponse as WireCompareResponse } from '@figurecollecting/ingest-contract/read';
import { createTestApp } from '../helpers/testApp';
import User from '../../src/models/User';
import { generateTestToken } from '../setup';

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
  close: () => Promise<void>;
}

async function startStub(impl: StubImpl): Promise<StubServer> {
  const routes = (router: ConnectRouter) => {
    router.service(SpineRead, { compare: async (req: WireCompareRequest) => impl(req) });
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
});
