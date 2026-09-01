import mongoose from 'mongoose';
import UserFigure, { IUserFigure, IUserFigureData, CollectionStatus, FigureCondition } from '../../src/models/UserFigure';
import User from '../../src/models/User';
import MFCItem from '../../src/models/MFCItem';

describe('UserFigure Model', () => {
  let userId: mongoose.Types.ObjectId;
  let mfcItemId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    // Create test user
    const user = await User.create({
      email: 'testuser@example.com',
      password: 'hashedpassword123',
      username: 'testuser'
    });
    userId = user._id;

    // Create test MFCItem
    const mfcItem = await MFCItem.create({
      mfcId: 1,
      mfcUrl: 'https://myfigurecollection.net/item/1',
      name: 'Test Figure for UserFigure'
    });
    mfcItemId = mfcItem._id;
  });

  describe('Schema Validation', () => {
    it('should create a UserFigure with required fields', async () => {
      const userFigureData: Partial<IUserFigureData> = {
        userId,
        mfcItemId,
        collectionStatus: 'owned'
      };

      const userFigure = await UserFigure.create(userFigureData);

      expect(userFigure.userId.toString()).toBe(userId.toString());
      expect(userFigure.mfcItemId.toString()).toBe(mfcItemId.toString());
      expect(userFigure.collectionStatus).toBe('owned');
      expect(userFigure._id).toBeDefined();
    });

    it('should require userId field', async () => {
      const userFigureData = {
        mfcItemId,
        collectionStatus: 'owned' as const
      };

      await expect(UserFigure.create(userFigureData)).rejects.toThrow();
    });

    it('should require mfcItemId field', async () => {
      const userFigureData = {
        userId,
        collectionStatus: 'owned' as const
      };

      await expect(UserFigure.create(userFigureData)).rejects.toThrow();
    });

    it('should require collectionStatus field', async () => {
      const userFigureData = {
        userId,
        mfcItemId
      };

      await expect(UserFigure.create(userFigureData)).rejects.toThrow();
    });

    it('should only accept valid collectionStatus values', async () => {
      const userFigureData = {
        userId,
        mfcItemId,
        collectionStatus: 'invalid_status'
      };

      await expect(UserFigure.create(userFigureData as any)).rejects.toThrow();
    });

    it('should enforce unique userId+mfcItemId combination', async () => {
      const userFigureData: Partial<IUserFigureData> = {
        userId,
        mfcItemId,
        collectionStatus: 'owned'
      };

      await UserFigure.create(userFigureData);
      await expect(UserFigure.create({
        ...userFigureData,
        collectionStatus: 'wished'
      })).rejects.toThrow();
    });
  });

  describe('CollectionStatus enum', () => {
    it('should have all expected status values', () => {
      expect(CollectionStatus.OWNED).toBe('owned');
      expect(CollectionStatus.WISHED).toBe('wished');
      expect(CollectionStatus.ORDERED).toBe('ordered');
      expect(CollectionStatus.PREORDERED).toBe('preordered');
    });

    it('should accept all valid status values', async () => {
      // Create unique MFCItems for each test
      const statuses = ['owned', 'wished', 'ordered', 'preordered'] as const;

      for (let i = 0; i < statuses.length; i++) {
        const mfcItem = await MFCItem.create({
          mfcId: 10000 + i,
          mfcUrl: `https://myfigurecollection.net/item/${10000 + i}`,
          name: `Status Test Figure ${i}`
        });

        const userFigure = await UserFigure.create({
          userId,
          mfcItemId: mfcItem._id,
          collectionStatus: statuses[i]
        });

        expect(userFigure.collectionStatus).toBe(statuses[i]);
      }
    });
  });

  describe('Quantity Field', () => {
    it('should default quantity to 1', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 20001,
        mfcUrl: 'https://myfigurecollection.net/item/20001',
        name: 'Quantity Default Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      expect(userFigure.quantity).toBe(1);
    });

    it('should store custom quantity', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 20002,
        mfcUrl: 'https://myfigurecollection.net/item/20002',
        name: 'Quantity Custom Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        quantity: 3
      });

      expect(userFigure.quantity).toBe(3);
    });

    it('should require quantity to be at least 1', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 20003,
        mfcUrl: 'https://myfigurecollection.net/item/20003',
        name: 'Quantity Min Test'
      });

      await expect(UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        quantity: 0
      })).rejects.toThrow();
    });
  });

  describe('Purchase Information', () => {
    it('should store purchase price and currency', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 30001,
        mfcUrl: 'https://myfigurecollection.net/item/30001',
        name: 'Purchase Info Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        purchasePrice: 15000,
        purchaseCurrency: 'JPY'
      });

      expect(userFigure.purchasePrice).toBe(15000);
      expect(userFigure.purchaseCurrency).toBe('JPY');
    });

    it('should store purchase date', async () => {
      const purchaseDate = new Date('2024-01-15');
      const mfcItem = await MFCItem.create({
        mfcId: 30002,
        mfcUrl: 'https://myfigurecollection.net/item/30002',
        name: 'Purchase Date Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        purchaseDate
      });

      expect(userFigure.purchaseDate?.getTime()).toBe(purchaseDate.getTime());
    });

    it('should allow purchase info to be optional', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 30003,
        mfcUrl: 'https://myfigurecollection.net/item/30003',
        name: 'No Purchase Info Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      expect(userFigure.purchasePrice).toBeUndefined();
      expect(userFigure.purchaseCurrency).toBeUndefined();
      expect(userFigure.purchaseDate).toBeUndefined();
    });
  });

  describe('Notes and Custom Tags', () => {
    it('should store notes', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 40001,
        mfcUrl: 'https://myfigurecollection.net/item/40001',
        name: 'Notes Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        notes: 'Bought at Anime Expo 2024'
      });

      expect(userFigure.notes).toBe('Bought at Anime Expo 2024');
    });

    it('should store custom tags', async () => {
      const customTags = ['favorite', 'display-case-1', 'gift'];
      const mfcItem = await MFCItem.create({
        mfcId: 40002,
        mfcUrl: 'https://myfigurecollection.net/item/40002',
        name: 'Custom Tags Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        customTags
      });

      expect(userFigure.customTags).toEqual(customTags);
    });

    it('should default customTags to empty array', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 40003,
        mfcUrl: 'https://myfigurecollection.net/item/40003',
        name: 'Empty Tags Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      expect(userFigure.customTags).toEqual([]);
    });
  });

  describe('Rating Field', () => {
    it('should store rating between 1 and 5', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 50001,
        mfcUrl: 'https://myfigurecollection.net/item/50001',
        name: 'Rating Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        rating: 5
      });

      expect(userFigure.rating).toBe(5);
    });

    it('should reject rating below 1', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 50002,
        mfcUrl: 'https://myfigurecollection.net/item/50002',
        name: 'Rating Min Test'
      });

      await expect(UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        rating: 0
      })).rejects.toThrow();
    });

    it('should reject rating above 5', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 50003,
        mfcUrl: 'https://myfigurecollection.net/item/50003',
        name: 'Rating Max Test'
      });

      await expect(UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        rating: 6
      })).rejects.toThrow();
    });

    it('should allow rating to be optional', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 50004,
        mfcUrl: 'https://myfigurecollection.net/item/50004',
        name: 'No Rating Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      expect(userFigure.rating).toBeUndefined();
    });
  });

  describe('Condition Field', () => {
    it('should store condition value', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 60001,
        mfcUrl: 'https://myfigurecollection.net/item/60001',
        name: 'Condition Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        condition: 'mint'
      });

      expect(userFigure.condition).toBe('mint');
    });

    it('should accept all valid condition values', async () => {
      const conditions = ['mint', 'good', 'fair', 'poor'] as const;

      for (let i = 0; i < conditions.length; i++) {
        const mfcItem = await MFCItem.create({
          mfcId: 60010 + i,
          mfcUrl: `https://myfigurecollection.net/item/${60010 + i}`,
          name: `Condition ${conditions[i]} Test`
        });

        const userFigure = await UserFigure.create({
          userId,
          mfcItemId: mfcItem._id,
          collectionStatus: 'owned',
          condition: conditions[i]
        });

        expect(userFigure.condition).toBe(conditions[i]);
      }
    });

    it('should reject invalid condition value', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 60020,
        mfcUrl: 'https://myfigurecollection.net/item/60020',
        name: 'Invalid Condition Test'
      });

      await expect(UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned',
        condition: 'invalid' as any
      })).rejects.toThrow();
    });
  });

  describe('FigureCondition enum', () => {
    it('should have all expected condition values', () => {
      expect(FigureCondition.MINT).toBe('mint');
      expect(FigureCondition.GOOD).toBe('good');
      expect(FigureCondition.FAIR).toBe('fair');
      expect(FigureCondition.POOR).toBe('poor');
    });
  });

  describe('Population', () => {
    it('should populate mfcItemId reference', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 70001,
        mfcUrl: 'https://myfigurecollection.net/item/70001',
        name: 'Populate MFCItem Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      const populated = await UserFigure.findById(userFigure._id).populate('mfcItemId');
      expect((populated?.mfcItemId as any).name).toBe('Populate MFCItem Test');
      expect((populated?.mfcItemId as any).mfcId).toBe(70001);
    });

    it('should populate userId reference', async () => {
      // Create fresh user since afterEach clears all collections
      const freshUser = await User.create({
        email: 'freshuser@example.com',
        password: 'hashedpassword123',
        username: 'freshuser'
      });

      const mfcItem = await MFCItem.create({
        mfcId: 70002,
        mfcUrl: 'https://myfigurecollection.net/item/70002',
        name: 'Populate User Test'
      });

      const userFigure = await UserFigure.create({
        userId: freshUser._id,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      const populated = await UserFigure.findById(userFigure._id).populate('userId');
      expect((populated?.userId as any).email).toBe('freshuser@example.com');
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Create test data for queries
      const mfcItems = await MFCItem.create([
        { mfcId: 80001, mfcUrl: 'https://myfigurecollection.net/item/80001', name: 'Query Figure 1' },
        { mfcId: 80002, mfcUrl: 'https://myfigurecollection.net/item/80002', name: 'Query Figure 2' },
        { mfcId: 80003, mfcUrl: 'https://myfigurecollection.net/item/80003', name: 'Query Figure 3' }
      ]);

      await UserFigure.create([
        { userId, mfcItemId: mfcItems[0]._id, collectionStatus: 'owned', rating: 5 },
        { userId, mfcItemId: mfcItems[1]._id, collectionStatus: 'wished' },
        { userId, mfcItemId: mfcItems[2]._id, collectionStatus: 'owned', rating: 4 }
      ]);
    });

    it('should find user figures by userId', async () => {
      const figures = await UserFigure.find({ userId });
      expect(figures.length).toBeGreaterThanOrEqual(3);
    });

    it('should find user figures by collectionStatus', async () => {
      const owned = await UserFigure.find({ userId, collectionStatus: 'owned' });
      expect(owned.length).toBeGreaterThanOrEqual(2);
    });

    it('should find user figures with rating', async () => {
      const rated = await UserFigure.find({ userId, rating: { $exists: true } });
      expect(rated.length).toBeGreaterThanOrEqual(2);
    });

    it('should support sorting by rating', async () => {
      const sorted = await UserFigure.find({ userId, rating: { $exists: true } }).sort({ rating: -1 });
      expect(sorted.length).toBeGreaterThanOrEqual(2);
      if (sorted.length >= 2) {
        expect(sorted[0].rating).toBeGreaterThanOrEqual(sorted[1].rating!);
      }
    });
  });

  describe('Timestamps', () => {
    it('should automatically set createdAt and updatedAt', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 90001,
        mfcUrl: 'https://myfigurecollection.net/item/90001',
        name: 'Timestamp Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });

      expect(userFigure.createdAt).toBeDefined();
      expect(userFigure.updatedAt).toBeDefined();
      expect(userFigure.createdAt).toBeInstanceOf(Date);
    });

    it('should update updatedAt on save', async () => {
      const mfcItem = await MFCItem.create({
        mfcId: 90002,
        mfcUrl: 'https://myfigurecollection.net/item/90002',
        name: 'Update Timestamp Test'
      });

      const userFigure = await UserFigure.create({
        userId,
        mfcItemId: mfcItem._id,
        collectionStatus: 'owned'
      });
      const originalUpdatedAt = userFigure.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));

      userFigure.collectionStatus = 'wished';
      await userFigure.save();

      expect(userFigure.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });
});
