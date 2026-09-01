import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Import after mocking axios so the module under test picks up the mock.
import {
  ingestGalleryImages,
  getGallery,
  MediaManagerClientError
} from '../../src/services/mediaManagerClient';

const ORIGINAL_ENV = process.env;

describe('mediaManagerClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.MEDIA_MANAGER_URL;
    delete process.env.MEDIA_MANAGER_SERVICE_TOKEN;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('ingestGalleryImages', () => {
    it('POSTs to /galleries/ingest with the default URL when MEDIA_MANAGER_URL is unset', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', imagesQueued: 1, duplicatesSkipped: 0 }
      });

      await ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }]);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url] = mockedAxios.post.mock.calls[0];
      expect(url).toMatch(/^http:\/\/localhost:\d+\/galleries\/ingest$/);
    });

    it('POSTs to {MEDIA_MANAGER_URL}/galleries/ingest when the env var is set', async () => {
      process.env.MEDIA_MANAGER_URL = 'http://media-manager:8000';
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', imagesQueued: 1, duplicatesSkipped: 0 }
      });

      await ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }]);

      const [url] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('http://media-manager:8000/galleries/ingest');
    });

    it('builds the wire payload with camelCase fields, defaulting missing position to array index', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', imagesQueued: 3, duplicatesSkipped: 0 }
      });

      await ingestGalleryImages('fig-1', [
        { url: 'https://example.com/a.jpg' }, // no position -> should default to 0
        { url: 'https://example.com/b.jpg', position: 5, caption: 'front view' },
        { url: 'https://example.com/c.jpg' } // no position -> should default to 2
      ]);

      const [, body] = mockedAxios.post.mock.calls[0];
      expect(body).toEqual({
        figureId: 'fig-1',
        images: [
          { url: 'https://example.com/a.jpg', position: 0 },
          { url: 'https://example.com/b.jpg', position: 5, caption: 'front view' },
          { url: 'https://example.com/c.jpg', position: 2 }
        ]
      });
    });

    it('sends Content-Type header and a sane timeout, and omits Authorization when no token configured', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', imagesQueued: 1, duplicatesSkipped: 0 }
      });

      await ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }]);

      const [, , config] = mockedAxios.post.mock.calls[0];
      expect(config?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(typeof config?.timeout).toBe('number');
      expect(config?.timeout).toBeGreaterThan(0);
    });

    it('sends an Authorization Bearer header when MEDIA_MANAGER_SERVICE_TOKEN is configured', async () => {
      process.env.MEDIA_MANAGER_SERVICE_TOKEN = 'service-jwt-abc';
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', imagesQueued: 1, duplicatesSkipped: 0 }
      });

      await ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }]);

      const [, , config] = mockedAxios.post.mock.calls[0];
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer service-jwt-abc' });
    });

    it('returns the parsed {figureId, imagesQueued, duplicatesSkipped} response', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-9', imagesQueued: 2, duplicatesSkipped: 1 }
      });

      const result = await ingestGalleryImages('fig-9', [
        { url: 'https://example.com/a.jpg' },
        { url: 'https://example.com/b.jpg' }
      ]);

      expect(result).toEqual({ figureId: 'fig-9', imagesQueued: 2, duplicatesSkipped: 1 });
    });

    it('throws MediaManagerClientError with kind "timeout" when the request times out', async () => {
      const timeoutError: any = new Error('timeout of 15000ms exceeded');
      timeoutError.isAxiosError = true;
      timeoutError.code = 'ECONNABORTED';
      mockedAxios.post.mockRejectedValueOnce(timeoutError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      const promise = ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }]);
      await expect(promise).rejects.toBeInstanceOf(MediaManagerClientError);
      await expect(promise).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('throws MediaManagerClientError with kind "http" and the response status on a non-2xx response', async () => {
      const httpError: any = new Error('Request failed with status code 422');
      httpError.isAxiosError = true;
      httpError.response = { status: 422, data: { detail: 'validation error' } };
      mockedAxios.post.mockRejectedValueOnce(httpError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(
        ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }])
      ).rejects.toMatchObject({
        kind: 'http',
        status: 422
      });
    });

    it('throws MediaManagerClientError with kind "network" on connection refused', async () => {
      const networkError: any = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      networkError.isAxiosError = true;
      networkError.code = 'ECONNREFUSED';
      networkError.request = {};
      mockedAxios.post.mockRejectedValueOnce(networkError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(
        ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }])
      ).rejects.toMatchObject({
        kind: 'network'
      });
    });

    it('throws MediaManagerClientError with kind "unknown" on a non-axios error', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('something exploded'));
      mockedAxios.isAxiosError.mockReturnValueOnce(false);

      await expect(
        ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }])
      ).rejects.toMatchObject({
        kind: 'unknown'
      });
    });

    it('throws MediaManagerClientError with kind "unknown" on a malformed (schema-violating) response', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1' } // missing imagesQueued/duplicatesSkipped
      });

      await expect(
        ingestGalleryImages('fig-1', [{ url: 'https://example.com/a.jpg' }])
      ).rejects.toMatchObject({
        kind: 'unknown'
      });
    });
  });

  describe('getGallery', () => {
    it('GETs {MEDIA_MANAGER_URL}/galleries/{figureId}', async () => {
      process.env.MEDIA_MANAGER_URL = 'http://media-manager:8000';
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', images: [], count: 0 }
      });

      await getGallery('fig-1');

      const [url] = mockedAxios.get.mock.calls[0];
      expect(url).toBe('http://media-manager:8000/galleries/fig-1');
    });

    it('sends a sane timeout and omits Authorization when no token configured', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', images: [], count: 0 }
      });

      await getGallery('fig-1');

      const [, config] = mockedAxios.get.mock.calls[0];
      expect(typeof config?.timeout).toBe('number');
      expect(config?.timeout).toBeGreaterThan(0);
      expect(config?.headers).not.toHaveProperty('Authorization');
    });

    it('sends an Authorization Bearer header when MEDIA_MANAGER_SERVICE_TOKEN is configured', async () => {
      process.env.MEDIA_MANAGER_SERVICE_TOKEN = 'service-jwt-xyz';
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', images: [], count: 0 }
      });

      await getGallery('fig-1');

      const [, config] = mockedAxios.get.mock.calls[0];
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer service-jwt-xyz' });
    });

    it('returns the parsed {figureId, images, count} response on success', async () => {
      const images = [
        { id: 1, url: '/serve/1', position: 0, caption: 'front' },
        { id: 2, url: '/serve/2', position: 1 }
      ];
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1', images, count: 2 }
      });

      const result = await getGallery('fig-1');

      expect(result).toEqual({ figureId: 'fig-1', images, count: 2 });
    });

    it('throws MediaManagerClientError with kind "timeout" when the poll request times out', async () => {
      const timeoutError: any = new Error('timeout of 5000ms exceeded');
      timeoutError.isAxiosError = true;
      timeoutError.code = 'ECONNABORTED';
      mockedAxios.get.mockRejectedValueOnce(timeoutError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(getGallery('fig-1')).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('throws MediaManagerClientError with kind "http" and the response status on a non-2xx response', async () => {
      const httpError: any = new Error('Request failed with status code 404');
      httpError.isAxiosError = true;
      httpError.response = { status: 404, data: { detail: 'not found' } };
      mockedAxios.get.mockRejectedValueOnce(httpError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(getGallery('fig-1')).rejects.toMatchObject({ kind: 'http', status: 404 });
    });

    it('throws MediaManagerClientError with kind "network" on connection refused', async () => {
      const networkError: any = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      networkError.isAxiosError = true;
      networkError.code = 'ECONNREFUSED';
      networkError.request = {};
      mockedAxios.get.mockRejectedValueOnce(networkError);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(getGallery('fig-1')).rejects.toMatchObject({ kind: 'network' });
    });

    it('throws MediaManagerClientError with kind "unknown" on a non-axios error', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('something exploded'));
      mockedAxios.isAxiosError.mockReturnValueOnce(false);

      await expect(getGallery('fig-1')).rejects.toMatchObject({ kind: 'unknown' });
    });

    it('throws MediaManagerClientError with kind "unknown" on a malformed (schema-violating) response', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { figureId: 'fig-1' } // missing images/count
      });

      await expect(getGallery('fig-1')).rejects.toMatchObject({ kind: 'unknown' });
    });
  });

  describe('MediaManagerClientError', () => {
    it('is an instance of Error with a message, kind, and optional status', () => {
      const err = new MediaManagerClientError('boom', 'http', 500);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('boom');
      expect(err.kind).toBe('http');
      expect(err.status).toBe(500);
    });

    it('leaves status undefined for non-http kinds', () => {
      const err = new MediaManagerClientError('boom', 'network');
      expect(err.status).toBeUndefined();
    });
  });
});
