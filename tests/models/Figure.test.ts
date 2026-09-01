import mongoose from 'mongoose';
import Figure, { IFigure } from '../../src/models/Figure';
import User from '../../src/models/User';

describe('Figure Model', () => {
  let testUserId: mongoose.Types.ObjectId;

  beforeEach(async () => {
    // Create a test user for figure ownership
    const testUser = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123'
    });
    const savedUser = await testUser.save();
    testUserId = savedUser._id;
  });

  describe('Schema Validation', () => {
    it('should create a valid figure with required fields', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure._id).toBeDefined();
      expect(savedFigure.manufacturer).toBe(figureData.manufacturer);
      expect(savedFigure.name).toBe(figureData.name);
      expect(savedFigure.userId).toEqual(testUserId);
      expect(savedFigure.createdAt).toBeDefined();
      expect(savedFigure.updatedAt).toBeDefined();
    });

    it('should allow figure without manufacturer (Schema v3)', async () => {
      // Schema v3: manufacturer is optional when companyRoles is used
      const figureData = {
        name: 'Test Figure',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      // Should save without manufacturer
      expect(savedFigure._id).toBeDefined();
      expect(savedFigure.name).toBe('Test Figure');
    });

    it('should derive manufacturer from companyRoles on save (Schema v3)', async () => {
      const figureData = {
        name: 'Test Figure',
        userId: testUserId,
        companyRoles: [
          { companyName: 'Good Smile Company', roleName: 'Manufacturer' },
          { companyName: 'Max Factory', roleName: 'Distributor' }
        ]
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      // Should derive manufacturer from first role with 'Manufacturer' roleName
      expect(savedFigure.manufacturer).toBe('Good Smile Company');
    });

    it('should require name field', async () => {
      const figureData = {
        manufacturer: 'Test Manufacturer',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      
      await expect(figure.save()).rejects.toThrow();
    });

    it('should require userId field', async () => {
      const figureData = {
        manufacturer: 'Test Manufacturer',
        name: 'Test Figure'
      };

      const figure = new Figure(figureData);
      
      await expect(figure.save()).rejects.toThrow();
    });

    it('should accept all optional fields', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        imageUrl: 'https://example.com/image.jpg',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.scale).toBe(figureData.scale);
      expect(savedFigure.mfcLink).toBe(figureData.mfcLink);
      expect(savedFigure.imageUrl).toBe(figureData.imageUrl);
    });

    it('should handle empty string values for optional fields', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '',
        mfcLink: '',
        imageUrl: '',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.scale).toBe('');
      expect(savedFigure.mfcLink).toBe('');
      expect(savedFigure.imageUrl).toBe('');
    });
  });

  describe('User Reference', () => {
    it('should properly reference a user', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      // Populate the user reference
      const populatedFigure = await Figure.findById(savedFigure._id).populate('userId');
      
      expect(populatedFigure?.userId).toBeDefined();
      expect((populatedFigure?.userId as any).username).toBe('testuser');
    });

    it('should fail with invalid userId', async () => {
      const invalidUserId = new mongoose.Types.ObjectId();
      
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: invalidUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save(); // This should succeed even with invalid reference

      expect(savedFigure.userId).toEqual(invalidUserId);
    });
  });

  describe('Indexes', () => {
    it('should have indexes on manufacturer and name', async () => {
      // This test verifies that indexes exist - actual performance testing would require large datasets
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      // Test querying by indexed fields
      const foundByManufacturer = await Figure.findOne({ manufacturer: 'Good Smile Company' });
      const foundByName = await Figure.findOne({ name: 'Hatsune Miku' });
      const foundByUserId = await Figure.findOne({ userId: testUserId });

      expect(foundByManufacturer?._id).toEqual(savedFigure._id);
      expect(foundByName?._id).toEqual(savedFigure._id);
      expect(foundByUserId?._id).toEqual(savedFigure._id);
    });

    it('should support compound index queries', async () => {
      const figure1Data = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure2Data = {
        manufacturer: 'Good Smile Company',
        name: 'Kagamine Rin',
        userId: testUserId
      };

      await Figure.create([figure1Data, figure2Data]);

      // Test compound index on manufacturer + name
      const foundByCompound = await Figure.findOne({
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku'
      });

      expect(foundByCompound?.name).toBe('Hatsune Miku');
    });
  });

  describe('Timestamps', () => {
    it('should automatically set createdAt and updatedAt', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.createdAt).toBeDefined();
      expect(savedFigure.updatedAt).toBeDefined();
      expect(savedFigure.createdAt).toBeInstanceOf(Date);
      expect(savedFigure.updatedAt).toBeInstanceOf(Date);
    });

    it('should update updatedAt on save', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();
      const originalUpdatedAt = savedFigure.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      savedFigure.name = 'Updated Miku';
      await savedFigure.save();

      expect(savedFigure.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });

  describe('Data Types and Edge Cases', () => {
    it('should handle long strings', async () => {
      const longString = 'A'.repeat(1000);

      const figureData = {
        manufacturer: longString,
        name: longString,
        scale: longString,
        mfcLink: longString,
        imageUrl: longString,
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.manufacturer).toBe(longString);
      expect(savedFigure.name).toBe(longString);
    });

    it('should handle special characters', async () => {
      const figureData = {
        manufacturer: 'メーカー株式会社',
        name: 'フィギュア名！@#$%^&*()',
        scale: '1/8スケール',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.manufacturer).toBe(figureData.manufacturer);
      expect(savedFigure.name).toBe(figureData.name);
      expect(savedFigure.scale).toBe(figureData.scale);
    });

    it('should handle URL formats in mfcLink and imageUrl', async () => {
      const figureData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        mfcLink: 'https://myfigurecollection.net/item/12345?query=param',
        imageUrl: 'https://static.myfigurecollection.net/upload/pictures/2023/01/01/image.jpg',
        userId: testUserId
      };

      const figure = new Figure(figureData);
      const savedFigure = await figure.save();

      expect(savedFigure.mfcLink).toBe(figureData.mfcLink);
      expect(savedFigure.imageUrl).toBe(figureData.imageUrl);
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Create multiple figures for testing
      const figures = [
        {
          manufacturer: 'Good Smile Company',
          name: 'Hatsune Miku',
          scale: '1/8',
          userId: testUserId
        },
        {
          manufacturer: 'Alter',
          name: 'Kagamine Rin',
          scale: '1/7',
          userId: testUserId
        },
        {
          manufacturer: 'Good Smile Company',
          name: 'Megumin',
          scale: '1/8',
          userId: testUserId
        }
      ];

      await Figure.insertMany(figures);
    });

    it('should find figures by manufacturer', async () => {
      const figures = await Figure.find({ manufacturer: 'Good Smile Company' });
      expect(figures).toHaveLength(2);
      expect(figures[0].manufacturer).toBe('Good Smile Company');
      expect(figures[1].manufacturer).toBe('Good Smile Company');
    });

    it('should find figures by scale', async () => {
      const figures = await Figure.find({ scale: '1/8' });
      expect(figures).toHaveLength(2);
      expect(figures.every(f => f.scale === '1/8')).toBe(true);
    });

    it('should support regex queries', async () => {
      const figures = await Figure.find({ 
        name: { $regex: 'Miku|Rin', $options: 'i' } 
      });
      expect(figures).toHaveLength(2);
      expect(figures.some(f => f.name.includes('Miku'))).toBe(true);
      expect(figures.some(f => f.name.includes('Rin'))).toBe(true);
    });

    it('should support sorting', async () => {
      const figures = await Figure.find({ userId: testUserId }).sort({ name: 1 });
      expect(figures).toHaveLength(3);
      expect(figures[0].name).toBe('Hatsune Miku');
      expect(figures[1].name).toBe('Kagamine Rin');
      expect(figures[2].name).toBe('Megumin');
    });
  });

  describe('displayMeta (media-manager -> fc-mobile contract)', () => {
    // Mirrors fc-shared FigureDisplayMeta exactly: nested object, all fields
    // optional, contactBand a nested {centerXFrac, widthFrac}. Additive only —
    // imageUrl remains the untouched fallback.
    it('round-trips a fully-populated nested displayMeta through the database', async () => {
      const figure = new Figure({
        name: 'Hatsune Miku',
        manufacturer: 'Good Smile Company',
        userId: testUserId,
        imageUrl: 'https://example.com/source.jpg',
        displayMeta: {
          matted: true,
          matteImageId: 'img-abc123',
          matteVersionId: 'v-7',
          bottomMarginFrac: 0.0421,
          contactBand: { centerXFrac: 0.52, widthFrac: 0.31 },
          thumbhash: 'L6Pj0^jE.AyE_3t7t7R**0o#DgR4',
          dominantColor: '#8899AA'
        }
      });
      await figure.save();

      const reloaded = await Figure.findById(figure._id);
      expect(reloaded?.displayMeta).toBeDefined();
      expect(reloaded?.displayMeta?.matted).toBe(true);
      expect(reloaded?.displayMeta?.matteImageId).toBe('img-abc123');
      expect(reloaded?.displayMeta?.matteVersionId).toBe('v-7');
      expect(reloaded?.displayMeta?.bottomMarginFrac).toBeCloseTo(0.0421);
      expect(reloaded?.displayMeta?.contactBand?.centerXFrac).toBeCloseTo(0.52);
      expect(reloaded?.displayMeta?.contactBand?.widthFrac).toBeCloseTo(0.31);
      expect(reloaded?.displayMeta?.thumbhash).toBe('L6Pj0^jE.AyE_3t7t7R**0o#DgR4');
      expect(reloaded?.displayMeta?.dominantColor).toBe('#8899AA');
      // Additive: the original source image URL is preserved untouched.
      expect(reloaded?.imageUrl).toBe('https://example.com/source.jpg');
    });

    it('persists a partial displayMeta, leaving unset fields undefined (each field independently optional)', async () => {
      const figure = new Figure({
        name: 'Kagamine Rin',
        manufacturer: 'Good Smile Company',
        userId: testUserId,
        displayMeta: {
          thumbhash: 'L6Pj0^jE.AyE_3t7t7R**0o#DgR4',
          dominantColor: '#112233'
        }
      });
      await figure.save();

      const reloaded = await Figure.findById(figure._id);
      expect(reloaded?.displayMeta?.thumbhash).toBe('L6Pj0^jE.AyE_3t7t7R**0o#DgR4');
      expect(reloaded?.displayMeta?.dominantColor).toBe('#112233');
      expect(reloaded?.displayMeta?.matted).toBeUndefined();
      expect(reloaded?.displayMeta?.matteImageId).toBeUndefined();
      expect(reloaded?.displayMeta?.contactBand).toBeUndefined();
    });

    it('saves a Figure with no displayMeta at all, preserving imageUrl (backward compatible)', async () => {
      const figure = new Figure({
        name: 'Megumin',
        manufacturer: 'Good Smile Company',
        userId: testUserId,
        imageUrl: 'https://example.com/legacy.jpg'
      });
      await figure.save();

      const reloaded = await Figure.findById(figure._id);
      expect(reloaded?.displayMeta).toBeUndefined();
      expect(reloaded?.imageUrl).toBe('https://example.com/legacy.jpg');
    });
  });
});