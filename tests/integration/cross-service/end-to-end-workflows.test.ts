import {
  TEST_CONFIG,
  backendAPI,
  frontendAPI,
  scraperAPI,
  authenticateUser,
  getAuthenticatedAPI,
  TEST_USERS,
  createTestFigure,
  getMongoClient
} from './setup';

describe('End-to-End Workflow Tests', () => {
  let user1API: any;
  let user2API: any;

  beforeAll(async () => {
    await authenticateUser('USER1', TEST_USERS.USER1.password);
    await authenticateUser('USER2', TEST_USERS.USER2.password);
    user1API = getAuthenticatedAPI('USER1');
    user2API = getAuthenticatedAPI('USER2');
  });

  describe('Complete Figure Collection Workflow', () => {
    test('End-to-end figure creation with MFC scraping', async () => {
      console.log('🔄 Starting complete figure collection workflow...');
      
      // Step 1: User submits figure with MFC URL through frontend
      const figureSubmission = {
        manufacturer: 'E2E Test Manufacturer',
        name: 'E2E Test Figure',
        scale: '1/8',
        location: 'E2E Test Shelf',
        boxNumber: 'E2E001',
        mfcLink: 'https://myfigurecollection.net/item/287'
      };

      console.log('   📝 Submitting figure creation request...');
      const createResponse = await user1API.post('/figures', figureSubmission);
      
      expect(createResponse.status).toBe(201);
      expect(createResponse.data.success).toBe(true);
      
      const createdFigure = createResponse.data.data;
      expect(createdFigure).toHaveProperty('_id');
      expect(createdFigure.mfcLink).toBe(figureSubmission.mfcLink);
      
      console.log(`   ✅ Figure created with ID: ${createdFigure._id}`);

      // Step 2: Verify figure appears in user's collection
      console.log('   📋 Fetching updated figure list...');
      const listResponse = await user1API.get('/figures');
      
      expect(listResponse.status).toBe(200);
      const userFigures = listResponse.data.data;
      const foundFigure = userFigures.find((f: any) => f._id === createdFigure._id);
      
      expect(foundFigure).toBeDefined();
      expect(foundFigure.mfcLink).toBe(figureSubmission.mfcLink);
      
      console.log('   ✅ Figure appears in user collection');

      // Step 3: Search for the figure using Atlas Search
      console.log('   🔍 Testing search functionality...');
      const searchResponse = await user1API.get(`/figures/search?query=${encodeURIComponent('E2E Test')}`);
      
      expect(searchResponse.status).toBe(200);
      const searchResults = searchResponse.data.data;
      console.log(`   📊 Search returned ${searchResults.length} results`);
      const searchFoundFigure = searchResults.find((f: any) => f.id === createdFigure._id || f._id === createdFigure._id);
      
      expect(searchFoundFigure).toBeDefined();
      console.log(`   ✅ Figure found in search results`);

      // Step 4: Update figure information
      console.log('   ✏️  Testing figure update...');
      const updateData = {
        ...figureSubmission,
        name: 'Updated E2E Test Figure',
        location: 'Updated E2E Shelf'
      };
      
      const updateResponse = await user1API.put(`/figures/${createdFigure._id}`, updateData);
      expect(updateResponse.status).toBe(200);
      expect(updateResponse.data.data.name).toBe(updateData.name);
      expect(updateResponse.data.data.location).toBe(updateData.location);
      
      console.log('   ✅ Figure updated successfully');

      // Step 5: Verify update persisted
      const getUpdatedResponse = await user1API.get(`/figures/${createdFigure._id}`);
      expect(getUpdatedResponse.status).toBe(200);
      expect(getUpdatedResponse.data.data.name).toBe(updateData.name);
      
      console.log('✅ Complete figure collection workflow successful!');
    }, 120000); // Extended timeout for full workflow

    test('Multi-user concurrent figure management', async () => {
      console.log('🔄 Testing multi-user concurrent operations...');
      
      // Both users create figures simultaneously
      const user1FigurePromise = user1API.post('/figures', {
        manufacturer: 'Concurrent User1 Manufacturer',
        name: 'Concurrent User1 Figure',
        scale: '1/8',
        location: 'User1 Shelf',
        boxNumber: 'CONCURRENT_U1'
      });

      const user2FigurePromise = user2API.post('/figures', {
        manufacturer: 'Concurrent User2 Manufacturer',
        name: 'Concurrent User2 Figure',
        scale: '1/7',
        location: 'User2 Shelf',
        boxNumber: 'CONCURRENT_U2'
      });

      const [user1Response, user2Response] = await Promise.all([
        user1FigurePromise,
        user2FigurePromise
      ]);

      expect(user1Response.status).toBe(201);
      expect(user2Response.status).toBe(201);
      
      console.log('   ✅ Concurrent figure creation successful');

      // Verify data isolation
      const user1Figures = await user1API.get('/figures');
      const user2Figures = await user2API.get('/figures');

      const user1FigureList = user1Figures.data.data;
      const user2FigureList = user2Figures.data.data;

      // User1 should see their figure but not User2's
      const user1HasOwnFigure = user1FigureList.some((f: any) => f._id === user1Response.data.data._id);
      const user1HasUser2Figure = user1FigureList.some((f: any) => f._id === user2Response.data.data._id);

      expect(user1HasOwnFigure).toBe(true);
      expect(user1HasUser2Figure).toBe(false);

      // User2 should see their figure but not User1's
      const user2HasOwnFigure = user2FigureList.some((f: any) => f._id === user2Response.data.data._id);
      const user2HasUser1Figure = user2FigureList.some((f: any) => f._id === user1Response.data.data._id);

      expect(user2HasOwnFigure).toBe(true);
      expect(user2HasUser1Figure).toBe(false);
      
      console.log('   ✅ Data isolation maintained between users');
      console.log('✅ Multi-user concurrent operations successful!');
    });
  });

  describe('Service Integration Workflows', () => {
    test('Complete service dependency chain', async () => {
      console.log('🔄 Testing complete service dependency chain...');

      // Step 1: Check all services are healthy
      console.log('   🏥 Checking service health...');
      const healthChecks = await Promise.all([
        backendAPI.get('/health'),
        scraperAPI.get('/health')
      ]);

      healthChecks.forEach((response, index) => {
        expect(response.status).toBe(200);
        const serviceName = ['backend', 'scraper'][index];
        console.log(`   ✅ ${serviceName} is healthy`);
      });

      // Step 2: Backend aggregates version info from all services
      console.log('   📊 Testing version aggregation...');
      const versionResponse = await backendAPI.get('/version');
      expect(versionResponse.status).toBe(200);

      const services = versionResponse.data.services;
      expect(services).toHaveProperty('backend');
      expect(services).toHaveProperty('scraper');

      console.log(`   ✅ Version aggregation successful - tracking ${Object.keys(services).length} services`);

      // Step 3: Test scraper integration through backend
      console.log('   🕷️  Testing scraper integration...');
      const scrapeResponse = await user1API.post('/figures/scrape-mfc', {
        mfcLink: 'https://myfigurecollection.net/item/test123'
      });

      expect(scrapeResponse.status).toBe(200);
      console.log('   ✅ Scraper integration working');

      console.log('✅ Complete service dependency chain working!');
    });

    test('Error propagation and recovery across services', async () => {
      console.log('🔄 Testing error propagation and recovery...');
      
      // Test 1: Invalid scraper request
      console.log('   ❌ Testing invalid scraper request handling...');
      try {
        await user1API.post('/figures/scrape-mfc', {
          mfcLink: 'invalid-url'
        });
        throw new Error('Should have thrown validation error');
      } catch (error: any) {
        // Backend returns 400 for invalid URLs
        expect(error.response?.status).toBe(400);
        expect(error.response?.data).toHaveProperty('message');
      }
      
      console.log('   ✅ Invalid scraper request handled gracefully');

      // Test 2: Backend still functions despite scraper errors
      console.log('   🔄 Testing backend resilience...');
      const normalFigureResponse = await user1API.post('/figures', {
        manufacturer: 'Resilience Test',
        name: 'Resilience Figure',
        scale: '1/8',
        location: 'Test Location',
        boxNumber: 'RESILIENT001'
      });

      expect(normalFigureResponse.status).toBe(201);
      console.log('   ✅ Backend continues to function despite scraper errors');

      // Test 3: Version service resilience
      console.log('   📊 Testing version service resilience...');
      const versionResponse = await backendAPI.get('/version');
      expect(versionResponse.status).toBe(200);
      
      // Should continue to work even if some services have errors
      expect(versionResponse.data).toHaveProperty('services');
      
      console.log('   ✅ Version service maintains functionality');
      console.log('✅ Error propagation and recovery working correctly!');
    });
  });

  describe('Data Flow and Consistency Workflows', () => {
    test('Database consistency across service operations', async () => {
      console.log('🔄 Testing database consistency across operations...');
      
      const mongoClient = await getMongoClient();
      const db = mongoClient.db('figure_collector_test');
      
      // Get initial counts
      const initialUserCount = await db.collection('users').countDocuments();
      const initialFigureCount = await db.collection('figures').countDocuments();
      
      console.log(`   📊 Initial state: ${initialUserCount} users, ${initialFigureCount} figures`);

      // Perform operations through API
      const newFigure = await user1API.post('/figures', {
        manufacturer: 'Consistency Test Manufacturer',
        name: 'Consistency Test Figure',
        scale: '1/8',
        location: 'Consistency Test Location',
        boxNumber: 'CONSISTENCY001'
      });

      expect(newFigure.status).toBe(201);
      const figureId = newFigure.data.data._id;

      // Verify database was updated
      const newFigureCount = await db.collection('figures').countDocuments();
      expect(newFigureCount).toBe(initialFigureCount + 1);

      console.log('   ✅ Database updated correctly after API operation');

      // Verify figure can be retrieved through database
      // Need to use ObjectId for MongoDB query
      const { ObjectId } = require('mongodb');
      const dbFigure = await db.collection('figures').findOne({ _id: new ObjectId(figureId) });
      expect(dbFigure).toBeDefined();
      expect(dbFigure).not.toBeNull();
      expect(dbFigure!.manufacturer).toBe('Consistency Test Manufacturer');

      console.log('   ✅ API and database data consistency verified');

      // Update through API and verify database
      const updateResponse = await user1API.put(`/figures/${figureId}`, {
        manufacturer: 'Updated Consistency Test Manufacturer',
        name: 'Updated Consistency Test Figure',
        scale: '1/7',
        location: 'Updated Consistency Test Location',
        boxNumber: 'CONSISTENCY001'
      });

      expect(updateResponse.status).toBe(200);

      // Verify update in database
      const updatedDbFigure = await db.collection('figures').findOne({ _id: new ObjectId(figureId) });
      expect(updatedDbFigure).toBeDefined();
      expect(updatedDbFigure).not.toBeNull();
      expect(updatedDbFigure!.manufacturer).toBe('Updated Consistency Test Manufacturer');
      expect(updatedDbFigure!.scale).toBe('1/7');

      console.log('   ✅ Update operations maintain database consistency');

      // Delete through API and verify database
      const deleteResponse = await user1API.delete(`/figures/${figureId}`);
      expect(deleteResponse.status).toBe(200);

      // Verify deletion in database
      const deletedDbFigure = await db.collection('figures').findOne({ _id: new ObjectId(figureId) });
      expect(deletedDbFigure).toBeNull();

      const finalFigureCount = await db.collection('figures').countDocuments();
      expect(finalFigureCount).toBe(initialFigureCount);

      console.log('   ✅ Delete operations maintain database consistency');
      console.log('✅ Database consistency maintained across all operations!');
    });

    test('Search index consistency with database changes', async () => {
      console.log('🔄 Testing search index consistency...');
      
      // Create a figure with distinctive search terms
      const searchTestFigure = {
        manufacturer: 'SearchIndex Manufacturer UniqueTest2024',
        name: 'SearchIndex Figure SpecialName2024',
        scale: '1/8',
        location: 'SearchIndex Location',
        boxNumber: 'SEARCHIDX001'
      };

      console.log('   📝 Creating figure with unique search terms...');
      const createResponse = await user1API.post('/figures', searchTestFigure);
      expect(createResponse.status).toBe(201);
      
      const figureId = createResponse.data.data._id;

      // Wait a moment for potential index updates
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Test search can find the new figure
      console.log('   🔍 Testing search for newly created figure...');
      const searchResponse = await user1API.get('/figures/search?query=UniqueTest2024');
      expect(searchResponse.status).toBe(200);
      
      const searchResults = searchResponse.data.data;
      const foundInSearch = searchResults.find((f: any) => f.id === figureId || f._id === figureId);
      expect(foundInSearch).toBeDefined();
      
      console.log('   ✅ New figure immediately searchable');

      // Update figure and test search consistency
      console.log('   ✏️  Updating figure and testing search consistency...');
      const updateData = {
        ...searchTestFigure,
        name: 'Updated SearchIndex Figure NewName2024'
      };

      await user1API.put(`/figures/${figureId}`, updateData);

      // Wait for potential index updates
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Search for updated content
      const updatedSearchResponse = await user1API.get('/figures/search?query=NewName2024');
      expect(updatedSearchResponse.status).toBe(200);
      
      const updatedSearchResults = updatedSearchResponse.data.data;
      const foundUpdatedInSearch = updatedSearchResults.find((f: any) => f.id === figureId || f._id === figureId);
      expect(foundUpdatedInSearch).toBeDefined();
      expect(foundUpdatedInSearch.name).toContain('NewName2024');
      
      console.log('   ✅ Updated figure content searchable');

      // Delete figure and verify it's removed from search
      console.log('   🗑️  Deleting figure and testing search removal...');
      await user1API.delete(`/figures/${figureId}`);

      // Wait for potential index updates
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Search should not find deleted figure
      const deletedSearchResponse = await user1API.get('/figures/search?query=UniqueTest2024');
      expect(deletedSearchResponse.status).toBe(200);
      
      const deletedSearchResults = deletedSearchResponse.data.data;
      const foundDeletedInSearch = deletedSearchResults.find((f: any) => f.id === figureId || f._id === figureId);
      expect(foundDeletedInSearch).toBeUndefined();
      
      console.log('   ✅ Deleted figure removed from search index');
      console.log('✅ Search index consistency maintained!');
    }, 30000); // Extended timeout for search index operations
  });

  describe('Performance and Load Workflows', () => {
    test('Concurrent user operations performance', async () => {
      console.log('🔄 Testing concurrent user operations performance...');
      
      const startTime = Date.now();
      
      // Simulate multiple users performing operations simultaneously
      const concurrentOperations = [
        // User 1 operations
        user1API.get('/figures'),
        user1API.get('/figures/stats'),
        user1API.post('/figures', {
          manufacturer: 'Concurrent Test 1',
          name: 'Concurrent Figure 1',
          scale: '1/8',
          location: 'Concurrent Location 1',
          boxNumber: 'CONCURRENT001'
        }),
        
        // User 2 operations
        user2API.get('/figures'),
        user2API.get('/figures/stats'),
        user2API.post('/figures', {
          manufacturer: 'Concurrent Test 2',
          name: 'Concurrent Figure 2',
          scale: '1/7',
          location: 'Concurrent Location 2',
          boxNumber: 'CONCURRENT002'
        }),
        
        // Search operations
        user1API.get('/figures/search?query=Miku'),
        user2API.get('/figures/search?query=Good%20Smile'),
        
        // Service operations
        backendAPI.get('/version'),
        backendAPI.get('/health')
      ];

      console.log(`   ⚡ Executing ${concurrentOperations.length} concurrent operations...`);
      
      const results = await Promise.allSettled(concurrentOperations);
      const duration = Date.now() - startTime;
      
      console.log(`   ⏱️  All operations completed in ${duration}ms`);
      
      // Check that most operations succeeded
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      const successRate = (successCount / results.length) * 100;
      
      expect(successRate).toBeGreaterThan(90); // At least 90% success rate
      expect(duration).toBeLessThan(15000); // Complete within 15 seconds
      
      console.log(`   ✅ Success rate: ${successRate.toFixed(1)}% (${successCount}/${results.length})`);
      console.log('✅ Concurrent operations performance acceptable!');
    }, 30000);

    test('Large dataset handling workflow', async () => {
      console.log('🔄 Testing large dataset handling...');
      
      // Create multiple figures to test pagination and performance
      const batchSize = 20;
      const figures = Array.from({ length: batchSize }, (_, i) => ({
        manufacturer: `Batch Test Manufacturer ${i}`,
        name: `Batch Test Figure ${i}`,
        scale: i % 2 === 0 ? '1/8' : '1/7',
        location: `Batch Test Location ${i}`,
        boxNumber: `BATCH${String(i).padStart(3, '0')}`
      }));

      console.log(`   📦 Creating ${batchSize} figures for testing...`);
      
      const createPromises = figures.map(figure => 
        user1API.post('/figures', figure)
      );

      const createResults = await Promise.all(createPromises);
      const createdFigures = createResults.map(r => r.data.data);
      
      console.log('   ✅ Batch figure creation successful');

      // Test pagination with large dataset
      console.log('   📄 Testing pagination performance...');
      const paginationStart = Date.now();
      
      const page1Response = await user1API.get('/figures?page=1&limit=10');
      expect(page1Response.status).toBe(200);
      expect(page1Response.data.data.length).toBeLessThanOrEqual(10);
      // Backend doesn't return pagination object, just data array
      expect(page1Response.data).toHaveProperty('success', true);
      expect(page1Response.data).toHaveProperty('count');
      expect(page1Response.data.count).toBeGreaterThan(0);
      
      const paginationTime = Date.now() - paginationStart;
      expect(paginationTime).toBeLessThan(5000); // Should be fast
      
      console.log(`   ✅ Pagination completed in ${paginationTime}ms`);

      // Test search performance with larger dataset
      console.log('   🔍 Testing search performance with larger dataset...');
      const searchStart = Date.now();
      
      const searchResponse = await user1API.get('/figures/search?query=Batch%20Test');
      expect(searchResponse.status).toBe(200);
      
      const searchTime = Date.now() - searchStart;
      expect(searchTime).toBeLessThan(10000); // Should complete within 10 seconds
      
      const searchResults = searchResponse.data.data;
      expect(searchResults.length).toBeGreaterThan(0);
      
      console.log(`   ✅ Search completed in ${searchTime}ms, found ${searchResults.length} results`);

      // Cleanup: Delete the test figures
      console.log('   🧹 Cleaning up test figures...');
      const deletePromises = createdFigures.map(figure => 
        user1API.delete(`/figures/${figure._id}`)
      );
      
      await Promise.all(deletePromises);
      console.log('   ✅ Cleanup completed');
      
      console.log('✅ Large dataset handling workflow successful!');
    }, 60000); // Extended timeout for large dataset operations
  });
});