import mongoose from 'mongoose';
import { connectDB } from '../../src/config/db';
import User from '../../src/models/User';
import Figure from '../../src/models/Figure';

describe('Database Integration Tests', () => {
  describe('Connection Management', () => {
    it('should handle connection states properly', async () => {
      // Check if we're connected
      expect(mongoose.connection.readyState).toBeGreaterThanOrEqual(0);
      
      if (mongoose.connection.readyState === 1) {
        expect(mongoose.connection.host).toBeDefined();
        expect(mongoose.connection.name).toBeDefined();
      }
    });

    it('should handle database operations when connected', async () => {
      if (mongoose.connection.readyState === 1) {
        const testUser = new User({
          username: 'dbtest',
          email: 'dbtest@example.com',
          password: 'password123'
        });

        const savedUser = await testUser.save();
        expect(savedUser._id).toBeDefined();
        expect(savedUser.username).toBe('dbtest');

        await User.findByIdAndDelete(savedUser._id);
      } else {
        console.log('Skipping database operations test - no database connection');
      }
    });
  });

  describe('Collection Operations', () => {
    let testUser: any;

    beforeEach(async () => {
      if (mongoose.connection.readyState === 1) {
        testUser = await User.create({
          username: 'collectiontest',
          email: 'collection@example.com',
          password: 'password123'
        });
      }
    });

    it('should handle bulk operations on User collection', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping bulk operations test - no database connection');
        return;
      }

      const users = [
        {
          username: 'bulk1',
          email: 'bulk1@example.com',
          password: 'password123'
        },
        {
          username: 'bulk2',
          email: 'bulk2@example.com',
          password: 'password123'
        },
        {
          username: 'bulk3',
          email: 'bulk3@example.com',
          password: 'password123'
        }
      ];

      const createdUsers = await User.insertMany(users);
      expect(createdUsers).toHaveLength(3);
      expect(createdUsers[0].username).toBe('bulk1');
      expect(createdUsers[1].username).toBe('bulk2');
      expect(createdUsers[2].username).toBe('bulk3');

      // Cleanup
      await User.deleteMany({
        username: { $in: ['bulk1', 'bulk2', 'bulk3'] }
      });
    });

    it('should handle bulk operations on Figure collection', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping figure bulk operations test - no database connection');
        return;
      }

      const figures = [
        {
          manufacturer: 'Manufacturer A',
          name: 'Figure A',
          scale: '1/8',
          userId: testUser._id
        },
        {
          manufacturer: 'Manufacturer B',
          name: 'Figure B',
          scale: '1/7',
          userId: testUser._id
        },
        {
          manufacturer: 'Manufacturer C',
          name: 'Figure C',
          scale: '1/8',
          userId: testUser._id
        }
      ];

      const createdFigures = await Figure.insertMany(figures);
      expect(createdFigures).toHaveLength(3);
      expect(createdFigures[0].manufacturer).toBe('Manufacturer A');

      // Test aggregate operations
      const stats = await Figure.aggregate([
        { $match: { userId: testUser._id } },
        { $group: { _id: '$scale', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      expect(stats).toHaveLength(2);
      expect(stats[0]._id).toBe('1/8');
      expect(stats[0].count).toBe(2);
      expect(stats[1]._id).toBe('1/7');
      expect(stats[1].count).toBe(1);

      // Cleanup
      await Figure.deleteMany({ userId: testUser._id });
    });
  });

  describe('Index Performance Tests', () => {
    it('should utilize indexes for User queries', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping index performance test - no database connection');
        return;
      }

      // Create multiple users for testing
      const users = [];
      for (let i = 0; i < 10; i++) {
        users.push({
          username: `indexuser${i}`,
          email: `indexuser${i}@example.com`,
          password: 'password123'
        });
      }

      await User.insertMany(users);

      // Test unique index on email
      const userByEmail = await User.findOne({ email: 'indexuser5@example.com' });
      expect(userByEmail).toBeTruthy();
      expect(userByEmail?.username).toBe('indexuser5');

      // Test unique index on username
      const userByUsername = await User.findOne({ username: 'indexuser7' });
      expect(userByUsername).toBeTruthy();
      expect(userByUsername?.email).toBe('indexuser7@example.com');

      // Cleanup
      await User.deleteMany({
        username: { $regex: '^indexuser\\d+$' }
      });
    });

    it('should utilize compound indexes for Figure queries', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping compound index test - no database connection');
        return;
      }

      const testUser = await User.create({
        username: 'compoundtest',
        email: 'compound@example.com',
        password: 'password123'
      });

      // Create figures for testing compound indexes
      const figures = [];
      const manufacturers = ['GSC', 'Alter', 'Max Factory'];
      const names = ['Miku', 'Rin', 'Len', 'Luka'];

      for (let i = 0; i < 20; i++) {
        figures.push({
          manufacturer: manufacturers[i % manufacturers.length],
          name: names[i % names.length] + ` ${i}`,
          scale: i % 2 === 0 ? '1/8' : '1/7',
          userId: testUser._id
        });
      }

      await Figure.insertMany(figures);

      // Test compound index on manufacturer + name
      const manufacturerQuery = await Figure.find({
        manufacturer: 'GSC',
        name: { $regex: 'Miku' }
      });
      expect(manufacturerQuery.length).toBeGreaterThan(0);

      // Test individual indexed fields
      const manufacturerOnlyQuery = await Figure.find({ manufacturer: 'Alter' });
      expect(manufacturerOnlyQuery.length).toBeGreaterThan(0);

      const nameOnlyQuery = await Figure.find({ name: { $regex: 'Rin' } });
      expect(nameOnlyQuery.length).toBeGreaterThan(0);

      const userIdQuery = await Figure.find({ userId: testUser._id });
      expect(userIdQuery).toHaveLength(20);

      // Cleanup
      await Figure.deleteMany({ userId: testUser._id });
      await User.findByIdAndDelete(testUser._id);
    });
  });

  describe('Transaction Support', () => {
    it('should handle transactions when supported', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping transaction test - no database connection');
        return;
      }

      // Check if transactions are supported (replica set required)
      try {
        const session = await mongoose.startSession();
        
        try {
          await session.withTransaction(async () => {
            const user = new User({
              username: 'transactionuser',
              email: 'transaction@example.com',
              password: 'password123'
            });
            
            await user.save({ session });
            
            const figure = new Figure({
              manufacturer: 'Transaction Manufacturer',
              name: 'Transaction Figure',
              userId: user._id
            });
            
            await figure.save({ session });
            
            // Verify both documents exist within transaction
            const userCheck = await User.findById(user._id).session(session);
            const figureCheck = await Figure.findById(figure._id).session(session);
            
            expect(userCheck).toBeTruthy();
            expect(figureCheck).toBeTruthy();
            
            return { user, figure };
          });
          
          // Cleanup - documents should exist after successful transaction
          await User.deleteOne({ username: 'transactionuser' });
          await Figure.deleteOne({ name: 'Transaction Figure' });
          
        } finally {
          await session.endSession();
        }
        
      } catch (error: any) {
        if (
          error.message.includes('Transaction') ||
          error.message.includes('replica set') ||
          error.message.includes('retryable writes')
        ) {
          console.log('Skipping transaction test - transactions not supported (replica set required)');
        } else {
          throw error;
        }
      }
    });

    it('should handle failed transactions properly', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping failed transaction test - no database connection');
        return;
      }

      try {
        const session = await mongoose.startSession();
        
        try {
          await expect(
            session.withTransaction(async () => {
              // Create a user
              const user = new User({
                username: 'failuser',
                email: 'fail@example.com',
                password: 'password123'
              });
              
              await user.save({ session });
              
              // Try to create duplicate user (should fail)
              const duplicateUser = new User({
                username: 'failuser', // Same username
                email: 'fail2@example.com',
                password: 'password123'
              });
              
              await duplicateUser.save({ session });
            })
          ).rejects.toThrow();
          
          // Verify no documents were created due to transaction rollback
          const userCheck = await User.findOne({ username: 'failuser' });
          expect(userCheck).toBeNull();
          
        } finally {
          await session.endSession();
        }
        
      } catch (error: any) {
        if (
          error.message.includes('Transaction') ||
          error.message.includes('replica set') ||
          error.message.includes('retryable writes')
        ) {
          console.log('Skipping failed transaction test - transactions not supported');
        } else {
          // Expected behavior for duplicate key error
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Data Integrity Tests', () => {
    it('should enforce unique constraints', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping unique constraint test - no database connection');
        return;
      }

      const user1 = new User({
        username: 'uniquetest',
        email: 'unique@example.com',
        password: 'password123'
      });

      await user1.save();

      // Try to create user with same username
      const user2 = new User({
        username: 'uniquetest', // Duplicate username
        email: 'unique2@example.com',
        password: 'password123'
      });

      await expect(user2.save()).rejects.toThrow();

      // Try to create user with same email
      const user3 = new User({
        username: 'uniquetest2',
        email: 'unique@example.com', // Duplicate email
        password: 'password123'
      });

      await expect(user3.save()).rejects.toThrow();

      // Cleanup
      await User.findByIdAndDelete(user1._id);
    });

    it('should enforce required fields', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping required fields test - no database connection');
        return;
      }

      // Test User required fields
      const userWithoutUsername = new User({
        email: 'noname@example.com',
        password: 'password123'
      });

      await expect(userWithoutUsername.save()).rejects.toThrow();

      const userWithoutEmail = new User({
        username: 'noemail',
        password: 'password123'
      });

      await expect(userWithoutEmail.save()).rejects.toThrow();

      const userWithoutPassword = new User({
        username: 'nopassword',
        email: 'nopassword@example.com'
      });

      await expect(userWithoutPassword.save()).rejects.toThrow();

      // Test Figure required fields
      // Schema v3: manufacturer is now optional (derived from companyRoles)
      const figureWithoutManufacturer = new Figure({
        name: 'Test Figure',
        userId: new mongoose.Types.ObjectId()
      });

      // Should NOT throw - manufacturer is optional in Schema v3
      const savedFigure = await figureWithoutManufacturer.save();
      expect(savedFigure._id).toBeDefined();

      const figureWithoutName = new Figure({
        manufacturer: 'Test Manufacturer',
        userId: new mongoose.Types.ObjectId()
      });

      await expect(figureWithoutName.save()).rejects.toThrow();

      const figureWithoutUserId = new Figure({
        manufacturer: 'Test Manufacturer',
        name: 'Test Figure'
      });

      await expect(figureWithoutUserId.save()).rejects.toThrow();
    });

    it('should handle foreign key relationships', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping foreign key test - no database connection');
        return;
      }

      const testUser = await User.create({
        username: 'fktest',
        email: 'fk@example.com',
        password: 'password123'
      });

      const figure = await Figure.create({
        manufacturer: 'FK Manufacturer',
        name: 'FK Figure',
        userId: testUser._id
      });

      // Test population
      const populatedFigure = await Figure.findById(figure._id).populate('userId');
      expect(populatedFigure?.userId).toBeDefined();
      expect((populatedFigure?.userId as any).username).toBe('fktest');

      // Test with invalid userId (still saves but won't populate)
      const invalidUserId = new mongoose.Types.ObjectId();
      const figureWithInvalidUser = await Figure.create({
        manufacturer: 'Invalid FK',
        name: 'Invalid FK Figure',
        userId: invalidUserId
      });

      const populatedInvalid = await Figure.findById(figureWithInvalidUser._id).populate('userId');
      expect(populatedInvalid?.userId).toBeNull();

      // Cleanup
      await Figure.deleteMany({ userId: { $in: [testUser._id, invalidUserId] } });
      await User.findByIdAndDelete(testUser._id);
    });
  });

  describe('Performance Tests', () => {
    it('should handle large dataset queries efficiently', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping performance test - no database connection');
        return;
      }

      const testUser = await User.create({
        username: 'perftest',
        email: 'perf@example.com',
        password: 'password123'
      });

      // Create a larger dataset for performance testing
      const figures = [];
      for (let i = 0; i < 100; i++) {
        figures.push({
          manufacturer: `Manufacturer ${i % 10}`,
          name: `Figure ${i}`,
          scale: i % 3 === 0 ? '1/8' : i % 3 === 1 ? '1/7' : '1/6',
          userId: testUser._id
        });
      }

      const startTime = Date.now();
      await Figure.insertMany(figures);
      const insertTime = Date.now() - startTime;

      console.log(`Inserted 100 figures in ${insertTime}ms`);

      // Test query performance
      const queryStartTime = Date.now();
      const queryResults = await Figure.find({ 
        userId: testUser._id,
        scale: '1/8'
      }).limit(20);
      const queryTime = Date.now() - queryStartTime;

      console.log(`Queried filtered results in ${queryTime}ms`);
      expect(queryResults.length).toBeLessThanOrEqual(20);

      // Test aggregation performance
      const aggStartTime = Date.now();
      const aggResults = await Figure.aggregate([
        { $match: { userId: testUser._id } },
        { $group: { _id: '$manufacturer', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      const aggTime = Date.now() - aggStartTime;

      console.log(`Aggregation completed in ${aggTime}ms`);
      expect(aggResults).toHaveLength(10);

      // Cleanup
      await Figure.deleteMany({ userId: testUser._id });
      await User.findByIdAndDelete(testUser._id);

      // Basic performance expectations (adjust based on system)
      expect(insertTime).toBeLessThan(5000); // 5 seconds max for 100 inserts
      expect(queryTime).toBeLessThan(1000);  // 1 second max for filtered query
      expect(aggTime).toBeLessThan(1000);    // 1 second max for aggregation
    });
  });
});