import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as https from 'https';

/**
 * Typed HTTP client for the image-manager microservice.
 *
 * Scope note: this module is intentionally NOT wired into any route/controller
 * yet. It exists purely as the typed client + tests for a later phase that
 * will route figure images through image-manager for matting/derived metadata.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Read env vars at call time (not module load) so tests can set/change them,
// mirroring the SCRAPER_SERVICE_URL pattern in figureController.ts.
const getImageManagerUrl = (): string =>
  process.env.IMAGE_MANAGER_URL || 'http://localhost:8000'; // NOSONAR - internal service URL from env

const getServiceToken = (): string | undefined => process.env.IMAGE_MANAGER_SERVICE_TOKEN;

// Ingest just enqueues a background job, so a generous timeout absorbs network
// hiccups without much cost. The poll GET is expected to be called repeatedly
// (Phase-4 poller), so it fails fast instead of stacking up slow requests.
const INGEST_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 5000;

/**
 * mTLS seam: today this just returns undefined, so axios falls back to its
 * default HTTP(S) behavior. Once mTLS is wired up (later phase), this factory
 * can construct an https.Agent loaded with a client cert/key/CA (paths from
 * env vars) and every call site below picks it up automatically.
 */
const buildHttpsAgent = (): https.Agent | undefined => undefined;

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getServiceToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ImageManagerErrorKind = 'timeout' | 'network' | 'http' | 'unknown';

export class ImageManagerClientError extends Error {
  readonly kind: ImageManagerErrorKind;
  readonly status?: number;

  constructor(message: string, kind: ImageManagerErrorKind, status?: number) {
    super(message);
    this.name = 'ImageManagerClientError';
    this.kind = kind;
    this.status = status;
  }
}

/** Classify any error thrown during a request and re-throw as ImageManagerClientError. Never lets a raw axios/network error escape. */
const handleRequestError = (error: unknown): never => {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      throw new ImageManagerClientError(`image-manager request timed out: ${error.message}`, 'timeout');
    }
    if (error.response) {
      throw new ImageManagerClientError(
        `image-manager returned HTTP ${error.response.status}`,
        'http',
        error.response.status
      );
    }
    throw new ImageManagerClientError(`image-manager network error: ${error.message}`, 'network');
  }

  const message = error instanceof Error ? error.message : String(error);
  throw new ImageManagerClientError(`image-manager client error: ${message}`, 'unknown');
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GalleryImageInput {
  url: string;
  position?: number;
  caption?: string;
}

interface GalleryImageWirePayload {
  url: string;
  position: number;
  caption?: string;
}

export interface IngestGalleryImagesResponse {
  figureId: string;
  imagesQueued: number;
  duplicatesSkipped: number;
}

export interface GalleryImage {
  id: number;
  url: string;
  position: number;
  caption?: string;
}

export interface GetGalleryResponse {
  figureId: string;
  images: GalleryImage[];
  count: number;
}

const isValidIngestResponse = (data: any): data is IngestGalleryImagesResponse =>
  !!data &&
  typeof data.figureId === 'string' &&
  typeof data.imagesQueued === 'number' &&
  typeof data.duplicatesSkipped === 'number';

const isValidGetGalleryResponse = (data: any): data is GetGalleryResponse =>
  !!data && typeof data.figureId === 'string' && Array.isArray(data.images) && typeof data.count === 'number';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * POST {IMAGE_MANAGER_URL}/galleries/ingest — queues the given images for
 * matting/processing. The server's `position` field is required, so a caller
 * omitting `position` gets it defaulted to the image's array index here.
 */
export async function ingestGalleryImages(
  figureId: string,
  images: GalleryImageInput[]
): Promise<IngestGalleryImagesResponse> {
  const payload = {
    figureId,
    images: images.map((image, index): GalleryImageWirePayload => {
      const wireImage: GalleryImageWirePayload = {
        url: image.url,
        position: image.position ?? index
      };
      if (image.caption !== undefined) {
        wireImage.caption = image.caption;
      }
      return wireImage;
    })
  };

  const config: AxiosRequestConfig = {
    headers: buildHeaders(),
    timeout: INGEST_TIMEOUT_MS,
    httpsAgent: buildHttpsAgent()
  };

  let response: AxiosResponse<IngestGalleryImagesResponse>;
  try {
    response = await axios.post<IngestGalleryImagesResponse>(
      `${getImageManagerUrl()}/galleries/ingest`,
      payload,
      config
    );
  } catch (error) {
    return handleRequestError(error);
  }

  if (!isValidIngestResponse(response.data)) {
    throw new ImageManagerClientError('image-manager returned a malformed ingest response', 'unknown');
  }

  return response.data;
}

/**
 * GET {IMAGE_MANAGER_URL}/galleries/{figureId} — fetches matted gallery
 * contents. Ingest is async, so a Phase-4 poller will call this repeatedly
 * until processing completes.
 */
export async function getGallery(figureId: string): Promise<GetGalleryResponse> {
  const config: AxiosRequestConfig = {
    headers: buildHeaders(),
    timeout: POLL_TIMEOUT_MS,
    httpsAgent: buildHttpsAgent()
  };

  let response: AxiosResponse<GetGalleryResponse>;
  try {
    response = await axios.get<GetGalleryResponse>(`${getImageManagerUrl()}/galleries/${figureId}`, config);
  } catch (error) {
    return handleRequestError(error);
  }

  if (!isValidGetGalleryResponse(response.data)) {
    throw new ImageManagerClientError('image-manager returned a malformed gallery response', 'unknown');
  }

  return response.data;
}
