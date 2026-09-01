import mongoose from 'mongoose';
import SearchIndex, { ISearchIndex, ISearchIndexData, EntityType } from '../../src/models/SearchIndex';
import MFCItem from '../../src/models/MFCItem';
import Company from '../../src/models/Company';
import Artist from '../../src/models/Artist';
import RoleType, { seedRoleTypes } from '../../src/models/RoleType';

describe('SearchIndex Model', () => {
  let mfcItemId: mongoose.Types.ObjectId;
  let companyId: mongoose.Types.ObjectId;
  let artistId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    // Seed role types for company creation
    await seedRoleTypes();
    const manufacturerRole = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });

    // Create test entities
    const mfcItem = await MFCItem.create({
      mfcId: 1,
      mfcUrl: 'https://myfigurecollection.net/item/1',
      name: 'Saber Artoria Pendragon'
    });
    mfcItemId = mfcItem._id;

    const company = await Company.create({
      name: 'Good Smile Company',
      category: 'company',
      subType: manufacturerRole!._id
    });
    companyId = company._id;

    const artist = await Artist.create({
      name: 'Takashi Takeuchi'
    });
    artistId = artist._id;
  });

  describe('Schema Validation', () => {
    it('should create a SearchIndex entry with required fields', async () => {
      const searchData: Partial<ISearchIndexData> = {
        entityType: 'figure',
        entityId: mfcItemId,
        searchText: 'Saber Artoria Pendragon Fate Grand Order',
        nameSearchable: 'saber artoria pendragon'
      };

      const searchEntry = await SearchIndex.create(searchData);

      expect(searchEntry.entityType).toBe('figure');
      expect(searchEntry.entityId.toString()).toBe(mfcItemId.toString());
      expect(searchEntry.searchText).toBe('Saber Artoria Pendragon Fate Grand Order');
      expect(searchEntry.nameSearchable).toBe('saber artoria pendragon');
      expect(searchEntry._id).toBeDefined();
    });

    it('should require entityType field', async () => {
      const searchData = {
        entityId: mfcItemId,
        searchText: 'Test search text',
        nameSearchable: 'test'
      };

      await expect(SearchIndex.create(searchData)).rejects.toThrow();
    });

    it('should require entityId field', async () => {
      const searchData = {
        entityType: 'figure' as const,
        searchText: 'Test search text',
        nameSearchable: 'test'
      };

      await expect(SearchIndex.create(searchData)).rejects.toThrow();
    });

    it('should require searchText field', async () => {
      const searchData = {
        entityType: 'figure' as const,
        entityId: mfcItemId,
        nameSearchable: 'test'
      };

      await expect(SearchIndex.create(searchData)).rejects.toThrow();
    });

    it('should require nameSearchable field', async () => {
      const searchData = {
        entityType: 'figure' as const,
        entityId: mfcItemId,
        searchText: 'Test search text'
      };

      await expect(SearchIndex.create(searchData)).rejects.toThrow();
    });

    it('should only accept valid entityType values', async () => {
      const searchData = {
        entityType: 'invalid_type',
        entityId: mfcItemId,
        searchText: 'Test',
        nameSearchable: 'test'
      };

      await expect(SearchIndex.create(searchData as any)).rejects.toThrow();
    });

    it('should enforce unique entityType+entityId combination', async () => {
      const searchData: Partial<ISearchIndexData> = {
        entityType: 'figure',
        entityId: mfcItemId,
        searchText: 'First entry',
        nameSearchable: 'first'
      };

      await SearchIndex.create(searchData);
      await expect(SearchIndex.create({
        ...searchData,
        searchText: 'Second entry'
      })).rejects.toThrow();
    });
  });

  describe('EntityType enum', () => {
    it('should have all expected entity type values', () => {
      expect(EntityType.FIGURE).toBe('figure');
      expect(EntityType.COMPANY).toBe('company');
      expect(EntityType.ARTIST).toBe('artist');
    });

    it('should accept all valid entity types', async () => {
      // Re-seed since afterEach clears collections
      await seedRoleTypes();
      const manufacturerRole = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });

      // Create fresh entities for this test
      const freshMfcItem = await MFCItem.create({
        mfcId: 10001,
        mfcUrl: 'https://myfigurecollection.net/item/10001',
        name: 'Entity Type Test Figure'
      });

      const freshCompany = await Company.create({
        name: 'Entity Type Test Company',
        category: 'company',
        subType: manufacturerRole!._id
      });

      const freshArtist = await Artist.create({
        name: 'Entity Type Test Artist'
      });

      const entries = await SearchIndex.create([
        { entityType: 'figure', entityId: freshMfcItem._id, searchText: 'figure test', nameSearchable: 'figure' },
        { entityType: 'company', entityId: freshCompany._id, searchText: 'company test', nameSearchable: 'company' },
        { entityType: 'artist', entityId: freshArtist._id, searchText: 'artist test', nameSearchable: 'artist' }
      ]);

      expect(entries.length).toBe(3);
      expect(entries.map(e => e.entityType).sort()).toEqual(['artist', 'company', 'figure']);
    });
  });

  describe('Tags Field', () => {
    it('should store tags array', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 20001,
        mfcUrl: 'https://myfigurecollection.net/item/20001',
        name: 'Tags Test Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Tagged figure',
        nameSearchable: 'tagged figure',
        tags: ['fate', 'saber', 'scale', '1/7']
      });

      expect(searchEntry.tags).toEqual(['fate', 'saber', 'scale', '1/7']);
    });

    it('should default tags to empty array', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 20002,
        mfcUrl: 'https://myfigurecollection.net/item/20002',
        name: 'No Tags Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'No tags figure',
        nameSearchable: 'no tags figure'
      });

      expect(searchEntry.tags).toEqual([]);
    });
  });

  describe('Popularity Field', () => {
    it('should store popularity score', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 30001,
        mfcUrl: 'https://myfigurecollection.net/item/30001',
        name: 'Popular Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Popular figure',
        nameSearchable: 'popular figure',
        popularity: 1500
      });

      expect(searchEntry.popularity).toBe(1500);
    });

    it('should allow popularity to be optional', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 30002,
        mfcUrl: 'https://myfigurecollection.net/item/30002',
        name: 'No Popularity Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'No popularity figure',
        nameSearchable: 'no popularity figure'
      });

      expect(searchEntry.popularity).toBeUndefined();
    });

    it('should default popularity to 0 when specified', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 30003,
        mfcUrl: 'https://myfigurecollection.net/item/30003',
        name: 'Zero Popularity Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Zero popularity figure',
        nameSearchable: 'zero popularity figure',
        popularity: 0
      });

      expect(searchEntry.popularity).toBe(0);
    });
  });

  describe('MfcId Field', () => {
    it('should store mfcId for figures', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 40001,
        mfcUrl: 'https://myfigurecollection.net/item/40001',
        name: 'MfcId Test Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'MfcId test figure',
        nameSearchable: 'mfcid test figure',
        mfcId: 40001
      });

      expect(searchEntry.mfcId).toBe(40001);
    });

    it('should allow mfcId to be optional', async () => {
      const artist = await Artist.create({
        name: 'No MfcId Artist'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'artist',
        entityId: artist._id,
        searchText: 'No mfcId artist',
        nameSearchable: 'no mfcid artist'
      });

      expect(searchEntry.mfcId).toBeUndefined();
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Create test search data
      const mfcItems = await MFCItem.create([
        { mfcId: 50001, mfcUrl: 'https://myfigurecollection.net/item/50001', name: 'Query Figure Alpha' },
        { mfcId: 50002, mfcUrl: 'https://myfigurecollection.net/item/50002', name: 'Query Figure Beta' },
        { mfcId: 50003, mfcUrl: 'https://myfigurecollection.net/item/50003', name: 'Query Figure Gamma' }
      ]);

      const artists = await Artist.create([
        { name: 'Query Artist One' },
        { name: 'Query Artist Two' }
      ]);

      await SearchIndex.create([
        { entityType: 'figure', entityId: mfcItems[0]._id, searchText: 'Query Figure Alpha Fate', nameSearchable: 'query figure alpha', tags: ['fate'], popularity: 100 },
        { entityType: 'figure', entityId: mfcItems[1]._id, searchText: 'Query Figure Beta Vocaloid', nameSearchable: 'query figure beta', tags: ['vocaloid'], popularity: 200 },
        { entityType: 'figure', entityId: mfcItems[2]._id, searchText: 'Query Figure Gamma Fate', nameSearchable: 'query figure gamma', tags: ['fate'], popularity: 150 },
        { entityType: 'artist', entityId: artists[0]._id, searchText: 'Query Artist One', nameSearchable: 'query artist one', popularity: 50 },
        { entityType: 'artist', entityId: artists[1]._id, searchText: 'Query Artist Two', nameSearchable: 'query artist two', popularity: 75 }
      ]);
    });

    it('should find entries by entityType', async () => {
      const figures = await SearchIndex.find({ entityType: 'figure' });
      expect(figures.length).toBeGreaterThanOrEqual(3);
    });

    it('should find entries by tag', async () => {
      const fateEntries = await SearchIndex.find({ tags: 'fate' });
      expect(fateEntries.length).toBeGreaterThanOrEqual(2);
    });

    it('should support text search on searchText', async () => {
      const results = await SearchIndex.find({ searchText: /Query Figure/ });
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('should support sorting by popularity', async () => {
      const sorted = await SearchIndex.find({ entityType: 'figure' }).sort({ popularity: -1 });
      expect(sorted.length).toBeGreaterThanOrEqual(3);
      if (sorted.length >= 2) {
        expect(sorted[0].popularity).toBeGreaterThanOrEqual(sorted[1].popularity!);
      }
    });

    it('should support filtering by multiple criteria', async () => {
      const results = await SearchIndex.find({
        entityType: 'figure',
        tags: 'fate',
        popularity: { $gte: 100 }
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Upsert Operations', () => {
    it('should support upsert for updating search entries', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 60001,
        mfcUrl: 'https://myfigurecollection.net/item/60001',
        name: 'Upsert Test Figure'
      });

      // First upsert - creates
      await SearchIndex.findOneAndUpdate(
        { entityType: 'figure', entityId: mfcItem._id },
        {
          $set: {
            searchText: 'Upsert test figure initial',
            nameSearchable: 'upsert test figure',
            popularity: 100
          }
        },
        { upsert: true, new: true }
      );

      let entry = await SearchIndex.findOne({ entityType: 'figure', entityId: mfcItem._id });
      expect(entry?.searchText).toBe('Upsert test figure initial');
      expect(entry?.popularity).toBe(100);

      // Second upsert - updates
      await SearchIndex.findOneAndUpdate(
        { entityType: 'figure', entityId: mfcItem._id },
        {
          $set: {
            searchText: 'Upsert test figure updated',
            popularity: 200
          }
        },
        { upsert: true, new: true }
      );

      entry = await SearchIndex.findOne({ entityType: 'figure', entityId: mfcItem._id });
      expect(entry?.searchText).toBe('Upsert test figure updated');
      expect(entry?.popularity).toBe(200);
    });
  });

  describe('Bulk Operations', () => {
    it('should support bulk insertion', async () => {
      const mfcItems = await MFCItem.create([
        { mfcId: 70001, mfcUrl: 'https://myfigurecollection.net/item/70001', name: 'Bulk Figure 1' },
        { mfcId: 70002, mfcUrl: 'https://myfigurecollection.net/item/70002', name: 'Bulk Figure 2' },
        { mfcId: 70003, mfcUrl: 'https://myfigurecollection.net/item/70003', name: 'Bulk Figure 3' }
      ]);

      const entries = await SearchIndex.insertMany(mfcItems.map((item, i) => ({
        entityType: 'figure' as const,
        entityId: item._id,
        searchText: `Bulk figure ${i + 1}`,
        nameSearchable: `bulk figure ${i + 1}`
      })));

      expect(entries.length).toBe(3);
    });

    it('should support bulk deletion', async () => {
      const mfcItems = await MFCItem.create([
        { mfcId: 80001, mfcUrl: 'https://myfigurecollection.net/item/80001', name: 'Delete Figure 1' },
        { mfcId: 80002, mfcUrl: 'https://myfigurecollection.net/item/80002', name: 'Delete Figure 2' }
      ]);

      await SearchIndex.create([
        { entityType: 'figure', entityId: mfcItems[0]._id, searchText: 'Delete figure 1', nameSearchable: 'delete figure 1' },
        { entityType: 'figure', entityId: mfcItems[1]._id, searchText: 'Delete figure 2', nameSearchable: 'delete figure 2' }
      ]);

      const deleteResult = await SearchIndex.deleteMany({
        entityId: { $in: mfcItems.map(i => i._id) }
      });

      expect(deleteResult.deletedCount).toBe(2);
    });
  });

  describe('entityTypeRef virtual', () => {
    it('should return Figure for figure entity type', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 95001,
        mfcUrl: 'https://myfigurecollection.net/item/95001',
        name: 'Virtual Ref Test Figure'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Virtual ref test figure',
        nameSearchable: 'virtual ref test figure'
      });

      expect((searchEntry as any).entityTypeRef).toBe('Figure');
    });

    it('should return Company for company entity type', async () => {
      await seedRoleTypes();
      const manufacturerRole = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });

      const company = await Company.create({
        name: 'Virtual Ref Test Company',
        category: 'company',
        subType: manufacturerRole!._id
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'company',
        entityId: company._id,
        searchText: 'Virtual ref test company',
        nameSearchable: 'virtual ref test company'
      });

      expect((searchEntry as any).entityTypeRef).toBe('Company');
    });

    it('should return Artist for artist entity type', async () => {
      const artist = await Artist.create({
        name: 'Virtual Ref Test Artist'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'artist',
        entityId: artist._id,
        searchText: 'Virtual ref test artist',
        nameSearchable: 'virtual ref test artist'
      });

      expect((searchEntry as any).entityTypeRef).toBe('Artist');
    });
  });

  describe('Timestamps', () => {
    it('should automatically set createdAt and updatedAt', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 90001,
        mfcUrl: 'https://myfigurecollection.net/item/90001',
        name: 'Timestamp Test'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Timestamp test',
        nameSearchable: 'timestamp test'
      });

      expect(searchEntry.createdAt).toBeDefined();
      expect(searchEntry.updatedAt).toBeDefined();
      expect(searchEntry.createdAt).toBeInstanceOf(Date);
    });

    it('should update updatedAt on save', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 90002,
        mfcUrl: 'https://myfigurecollection.net/item/90002',
        name: 'Update Timestamp Test'
      });

      const searchEntry = await SearchIndex.create({
        entityType: 'figure',
        entityId: mfcItem._id,
        searchText: 'Update timestamp test',
        nameSearchable: 'update timestamp test'
      });
      const originalUpdatedAt = searchEntry.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));

      searchEntry.searchText = 'Updated search text';
      await searchEntry.save();

      expect(searchEntry.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });
});
