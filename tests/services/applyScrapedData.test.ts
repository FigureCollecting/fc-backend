/**
 * Unit tests for applyScrapedData - the unified Stage-B DB-write function
 * extracted from the webhook /sync/webhook/item-complete handler.
 *
 * This is a pure unit test: all Mongoose models and the search-index service
 * are mocked so we can assert on the exact upsert calls without touching the
 * database. (Integration coverage of the full webhook flow already exists in
 * tests/integration/syncRoutes.webhook*.test.ts and is unaffected by this
 * refactor - it exercises the same code through the real route + real DB.)
 */
import mongoose from 'mongoose';

jest.mock('../../src/models', () => ({
  Figure: { findOneAndUpdate: jest.fn() },
  MFCItem: { findOneAndUpdate: jest.fn() },
  Company: { findOneAndUpdate: jest.fn(), findOne: jest.fn() },
  Artist: { findOneAndUpdate: jest.fn() },
  RoleType: { findOne: jest.fn() }
}));

jest.mock('../../src/services/searchIndexService', () => ({
  upsertFigureSearchIndex: jest.fn()
}));

import { Figure, MFCItem, Company, Artist, RoleType } from '../../src/models';
import { upsertFigureSearchIndex } from '../../src/services/searchIndexService';
import { applyScrapedData } from '../../src/services/applyScrapedData';

const mockFigureFindOneAndUpdate = Figure.findOneAndUpdate as jest.Mock;
const mockMFCItemFindOneAndUpdate = MFCItem.findOneAndUpdate as jest.Mock;
const mockCompanyFindOneAndUpdate = Company.findOneAndUpdate as jest.Mock;
const mockCompanyFindOne = Company.findOne as jest.Mock;
const mockArtistFindOneAndUpdate = Artist.findOneAndUpdate as jest.Mock;
const mockRoleTypeFindOne = RoleType.findOne as jest.Mock;
const mockUpsertFigureSearchIndex = upsertFigureSearchIndex as jest.Mock;

describe('applyScrapedData', () => {
  const userId = new mongoose.Types.ObjectId();
  const mfcId = '12345';

  beforeEach(() => {
    jest.clearAllMocks();
    mockMFCItemFindOneAndUpdate.mockResolvedValue({ mfcId: 12345 });
    mockUpsertFigureSearchIndex.mockResolvedValue(undefined);
  });

  describe('Figure upsert', () => {
    it('upserts the Figure scoped to userId+mfcId with mapped scraped fields', async () => {
      const fakeFigure = { _id: new mongoose.Types.ObjectId(), mfcId: 12345 };
      mockFigureFindOneAndUpdate.mockResolvedValue(fakeFigure);

      const scrapedData = {
        name: 'Scraped Figure Name',
        manufacturer: 'Good Smile Company',
        scale: '1/7',
        imageUrl: 'https://example.com/figure.jpg',
        description: 'A beautiful figure',
        jan: '4580416940511'
      };

      const result = await applyScrapedData(mfcId, scrapedData, userId);

      expect(mockFigureFindOneAndUpdate).toHaveBeenCalledWith(
        { userId, mfcId: 12345 },
        {
          $set: expect.objectContaining({
            mfcId: 12345,
            mfcLink: 'https://myfigurecollection.net/item/12345',
            collectionStatus: 'owned',
            name: 'Scraped Figure Name',
            manufacturer: 'Good Smile Company',
            scale: '1/7',
            imageUrl: 'https://example.com/figure.jpg',
            description: 'A beautiful figure',
            jan: '4580416940511'
          }),
          $setOnInsert: { userId }
        },
        { upsert: true, new: true }
      );
      expect(result.figure).toBe(fakeFigure);
    });

    it('defaults collectionStatus to owned and applies mfcActivityOrder when provided', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X' }, userId, {
        collectionStatus: 'wished',
        mfcActivityOrder: 7
      });

      expect(mockFigureFindOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ collectionStatus: 'wished', mfcActivityOrder: 7 })
        }),
        expect.anything()
      );
    });

    it('skips the Figure upsert for orphan items but still upserts the MFCItem catalog', async () => {
      const result = await applyScrapedData(mfcId, { name: 'Orphan Item' }, userId, { isOrphan: true });

      expect(mockFigureFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockMFCItemFindOneAndUpdate).toHaveBeenCalled();
      expect(result.figure).toBeNull();
    });

    it('skips the Figure upsert when no userId is provided (future reprocess w/o user context)', async () => {
      const result = await applyScrapedData(mfcId, { name: 'No User' });

      expect(mockFigureFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockMFCItemFindOneAndUpdate).toHaveBeenCalled();
      expect(result.figure).toBeNull();
    });

    it('parses a dimensions string onto the Figure', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X', dimensions: '1/6, H=260mm' }, userId);

      expect(mockFigureFindOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ dimensions: { heightMm: 260, scaledHeight: '1/6' } })
        }),
        expect.anything()
      );
    });

    it('omits name/manufacturer/scale/etc when absent from a minimal scrapedData payload', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, {}, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.name).toBeUndefined();
      expect(call[1].$set.manufacturer).toBeUndefined();
      expect(call[1].$set.scale).toBeUndefined();
      expect(call[1].$set.imageUrl).toBeUndefined();
      expect(call[1].$set.description).toBeUndefined();
      expect(call[1].$set.jan).toBeUndefined();
    });

    it('ignores unparseable dimensions strings', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X', dimensions: 'nonsense' }, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.dimensions).toBeUndefined();
    });

    it('maps userScore and userWishRating onto rating/wishRating when numeric', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X', userScore: 8, userWishRating: 3 }, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.rating).toBe(8);
      expect(call[1].$set.wishRating).toBe(3);
    });

    it('omits rating/wishRating when userScore/userWishRating are absent', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X' }, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.rating).toBeUndefined();
      expect(call[1].$set.wishRating).toBeUndefined();
    });

    it('maps all Schema v3 individual MFC fields', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, {
        name: 'X',
        mfcTitle: 'Magical Mirai 2024 ver.',
        origin: 'Vocaloid',
        version: 'Magical Mirai 2024',
        category: 'Scale',
        classification: '1/7',
        materials: 'ABS&PVC',
        releases: [{ date: '2024-01-01', price: 15000, currency: 'JPY' }]
      }, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set).toEqual(expect.objectContaining({
        mfcTitle: 'Magical Mirai 2024 ver.',
        origin: 'Vocaloid',
        version: 'Magical Mirai 2024',
        category: 'Scale',
        classification: '1/7',
        materials: 'ABS&PVC',
        releases: [{ date: '2024-01-01', price: 15000, currency: 'JPY' }]
      }));
    });

    it('does not set tags when scrapedData.tags is not an array', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, { name: 'X', tags: 'not-an-array' }, userId);

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.tags).toBeUndefined();
    });
  });

  describe('company/artist role processing', () => {
    it('upserts a Company when the role type is known and links companyId/roleId', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
      const roleTypeId = new mongoose.Types.ObjectId();
      const companyId = new mongoose.Types.ObjectId();
      mockRoleTypeFindOne.mockResolvedValue({ _id: roleTypeId, name: 'Manufacturer' });
      mockCompanyFindOneAndUpdate.mockResolvedValue({ _id: companyId });

      await applyScrapedData(
        mfcId,
        { name: 'X', companies: [{ name: 'Good Smile Company', role: 'Manufacturer', mfcId: 123 }] },
        userId
      );

      expect(mockRoleTypeFindOne).toHaveBeenCalledWith({ name: 'Manufacturer', kind: 'company' });
      expect(mockCompanyFindOneAndUpdate).toHaveBeenCalled();
      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.companyRoles).toEqual([
        { companyName: 'Good Smile Company', roleName: 'Manufacturer', companyId, roleId: roleTypeId }
      ]);
      // Legacy manufacturer string derived from the first Manufacturer company
      expect(call[1].$set.manufacturer).toBe('Good Smile Company');
    });

    it('falls back to Company.findOne (no create) when the role type is unknown', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
      mockRoleTypeFindOne.mockResolvedValue(null);
      mockCompanyFindOne.mockResolvedValue(null);

      await applyScrapedData(
        mfcId,
        { name: 'X', companies: [{ name: 'Unknown Co', role: 'UnknownRole' }] },
        userId
      );

      expect(mockCompanyFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockCompanyFindOne).toHaveBeenCalledWith({ name: 'Unknown Co' });
      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.companyRoles).toEqual([{ companyName: 'Unknown Co', roleName: 'UnknownRole' }]);
    });

    it('upserts Artists and links artistId/roleId onto artistRoles', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
      const roleTypeId = new mongoose.Types.ObjectId();
      const artistId = new mongoose.Types.ObjectId();
      mockRoleTypeFindOne.mockResolvedValue({ _id: roleTypeId, name: 'Sculptor' });
      mockArtistFindOneAndUpdate.mockResolvedValue({ _id: artistId });

      await applyScrapedData(
        mfcId,
        { name: 'X', artists: [{ name: 'TERAOKA Takeyuki', role: 'Sculptor', mfcId: 789 }] },
        userId
      );

      expect(mockArtistFindOneAndUpdate).toHaveBeenCalled();
      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.artistRoles).toEqual([
        { artistId, artistName: 'TERAOKA Takeyuki', roleName: 'Sculptor', roleId: roleTypeId }
      ]);
    });

    it('omits roleId on artistRoles when the role type is unknown', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
      const artistId = new mongoose.Types.ObjectId();
      mockRoleTypeFindOne.mockResolvedValue(null);
      mockArtistFindOneAndUpdate.mockResolvedValue({ _id: artistId });

      await applyScrapedData(
        mfcId,
        { name: 'X', artists: [{ name: 'Unknown Artist', role: 'UnknownRole' }] },
        userId
      );

      const call = mockFigureFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.artistRoles).toEqual([
        { artistId, artistName: 'Unknown Artist', roleName: 'UnknownRole' }
      ]);
    });
  });

  describe('MFCItem catalog upsert', () => {
    it('upserts the shared MFCItem catalog entry with mapped fields for ALL items', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(
        mfcId,
        { name: 'X', scale: '1/7', imageUrl: 'https://example.com/x.jpg', tags: ['a'] },
        userId
      );

      expect(mockMFCItemFindOneAndUpdate).toHaveBeenCalledWith(
        { mfcId: 12345 },
        {
          $set: expect.objectContaining({
            mfcId: 12345,
            mfcUrl: 'https://myfigurecollection.net/item/12345',
            name: 'X',
            scale: '1/7',
            imageUrls: ['https://example.com/x.jpg'],
            tags: ['a']
          })
        },
        { upsert: true }
      );
    });

    it('maps communityStats and relatedItems onto the catalog entry when present', async () => {
      mockFigureFindOneAndUpdate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

      await applyScrapedData(mfcId, {
        name: 'X',
        communityStats: { ownedCount: 5, wishedCount: 2 },
        relatedItems: [{ mfcId: 999, relationType: 'variant' }]
      }, userId);

      const call = mockMFCItemFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.communityStats).toEqual({ ownedCount: 5, wishedCount: 2 });
      expect(call[1].$set.relatedItems).toEqual([{ mfcId: 999, relationType: 'variant' }]);
    });

    it('omits optional catalog fields entirely when absent from scrapedData', async () => {
      await applyScrapedData(mfcId, {}, userId, { isOrphan: true });

      const call = mockMFCItemFindOneAndUpdate.mock.calls[0];
      expect(call[1].$set.name).toBeUndefined();
      expect(call[1].$set.scale).toBeUndefined();
      expect(call[1].$set.imageUrls).toBeUndefined();
      expect(call[1].$set.tags).toBeUndefined();
      expect(call[1].$set.releases).toBeUndefined();
      expect(call[1].$set.companies).toBeUndefined();
      expect(call[1].$set.artists).toBeUndefined();
      expect(call[1].$set.dimensions).toBeUndefined();
      expect(call[1].$set.communityStats).toBeUndefined();
      expect(call[1].$set.relatedItems).toBeUndefined();
    });
  });

  describe('search-index sync (fire-and-forget)', () => {
    it('fires upsertFigureSearchIndex without awaiting/blocking on it', async () => {
      const fakeFigure = { _id: new mongoose.Types.ObjectId(), mfcId: 12345 };
      mockFigureFindOneAndUpdate.mockResolvedValue(fakeFigure);

      // Never resolves during this test - if applyScrapedData awaited this call,
      // the outer `await applyScrapedData(...)` below would hang and time out.
      let capturedReject: (err: Error) => void = () => {};
      mockUpsertFigureSearchIndex.mockImplementation(
        () => new Promise((_resolve, reject) => { capturedReject = reject; })
      );

      const result = await applyScrapedData(mfcId, { name: 'X' }, userId);

      expect(mockUpsertFigureSearchIndex).toHaveBeenCalledWith(fakeFigure);
      expect(result.figure).toBe(fakeFigure);

      // Clean up the dangling promise so it doesn't produce an unhandled rejection.
      capturedReject(new Error('search index down'));
    });

    it('does not skip search-index sync for orphan items (it only runs when a Figure was upserted)', async () => {
      await applyScrapedData(mfcId, { name: 'Orphan' }, userId, { isOrphan: true });
      expect(mockUpsertFigureSearchIndex).not.toHaveBeenCalled();
    });
  });
});
