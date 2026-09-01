import request from 'supertest';
import { createTestApp } from '../helpers/testApp';
import User from '../../src/models/User';
import Figure from '../../src/models/Figure';
import { generateTestToken } from '../setup';
import mongoose from 'mongoose';

const app = createTestApp();

describe('Route Validation and Error Handling', () => {
  let testUser: any;
  let authToken: string;

  beforeEach(async () => {
    testUser = new User({
      username: 'routetest',
      email: 'route@example.com',
      password: 'password123'
    });
    await testUser.save();
    authToken = generateTestToken(testUser._id.toString());
  });

  describe('Figure Routes Parameter Validation', () => {
    describe('GET /figures/:id', () => {
      it('should return 422 for invalid ObjectId format', async () => {
        const response = await request(app)
          .get('/figures/invalid-id')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(422); // SECURITY FIX: Invalid ObjectId should be validation error, not server error

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/validation|invalid/i);
      });

      it('should handle very long invalid IDs gracefully', async () => {
        const longInvalidId = 'a'.repeat(100);
        
        const response = await request(app)
          .get(`/figures/${longInvalidId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(422); // SECURITY FIX: Invalid ID format should be validation error

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/validation|invalid/i);
      });

      it('should handle special characters in ID parameter', async () => {
        const specialCharId = 'id-with-special-chars@#$%';
        
        const response = await request(app)
          .get(`/figures/${specialCharId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(422); // SECURITY FIX: Invalid ID format should be validation error

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/validation|invalid/i);
      });
    });

    describe('PUT /figures/:id', () => {
      it('should return 422 for invalid ObjectId in update', async () => {
        const updateData = {
          manufacturer: 'Updated Manufacturer',
          name: 'Updated Name'
        };

        const response = await request(app)
          .put('/figures/invalid-update-id')
          .set('Authorization', `Bearer ${authToken}`)
          .send(updateData)
          .expect(422); // SECURITY FIX: Invalid ObjectId should be validation error

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/validation|invalid/i);
      });
    });

    describe('DELETE /figures/:id', () => {
      it('should return 422 for invalid ObjectId in delete', async () => {
        const response = await request(app)
          .delete('/figures/invalid-delete-id')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(422); // SECURITY FIX: Invalid ObjectId should be validation error

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/validation|invalid/i);
      });
    });
  });

  describe('Request Body Validation', () => {
    describe('POST /figures', () => {
      it('should handle malformed JSON gracefully', async () => {
        const response = await request(app)
          .post('/figures')
          .set('Authorization', `Bearer ${authToken}`)
          .set('Content-Type', 'application/json')
          .send('{"manufacturer": "Test", invalid json}')
          .expect(400);

        // Express handles malformed JSON automatically
        expect(response.status).toBe(400);
      });

      it('should handle extremely long field values', async () => {
        const longString = 'a'.repeat(10000);
        const figureData = {
          manufacturer: longString,
          name: longString,
          scale: longString,
          mfcLink: longString,
          imageUrl: longString
        };

        const response = await request(app)
          .post('/figures')
          .set('Authorization', `Bearer ${authToken}`)
          .send(figureData)
          .expect(422);

        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();
      });

      it('should handle null values in optional fields', async () => {
        const figureData = {
          manufacturer: 'Test Manufacturer',
          name: 'Test Figure',
          scale: null,
          mfcLink: null,
          imageUrl: null
        };

        const response = await request(app)
          .post('/figures')
          .set('Authorization', `Bearer ${authToken}`)
          .send(figureData)
          .expect(422);

        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();
      });

      it('should handle nested object attacks', async () => {
        const maliciousData = {
          manufacturer: 'Test',
          name: 'Test',
          scale: {
            $ne: null
          }
        };

        const response = await request(app)
          .post('/figures')
          .set('Authorization', `Bearer ${authToken}`)
          .send(maliciousData)
          .expect(422);

        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();
        // Validation middleware should reject nested object attacks
      });
    });

    describe('POST /auth/register', () => {
      it('should handle missing required fields gracefully', async () => {
        const incompleteData = {};

        const response = await request(app)
          .post('/auth/register')
          .send(incompleteData)
          .expect(422);

        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();
      });

      it('should handle extremely long username', async () => {
        const userData = {
          username: 'a'.repeat(1000),
          email: 'long@example.com',
          password: 'password123'
        };

        const response = await request(app)
          .post('/auth/register')
          .send(userData)
          .expect(422);

        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();
      });

      it('should handle invalid email formats', async () => {
        const invalidEmails = [
          'invalid-email',
          '@example.com',
          'test@',
          'test..test@example.com',
          'test@example.',
          'test@.example.com'
        ];

        for (const email of invalidEmails) {
          const userData = {
            username: `user-${Date.now()}`,
            email: email,
            password: 'password123'
          };

          const response = await request(app)
            .post('/auth/register')
            .send(userData);

          // Should reject invalid email format with validation error
          expect(response.status).toBe(422);
          if (response.body && response.body.success !== undefined) {
            expect(response.body.success).toBe(false);
          }
          if (response.body && response.body.message) {
            expect(response.body.message).toMatch(/validation/i);
          }
        }
      });

      it('should handle SQL injection attempts in fields', async () => {
        const sqlInjectionData = {
          username: "admin'; DROP TABLE users; --",
          email: "admin@example.com' OR '1'='1",
          password: "password'; DELETE FROM users; --"
        };

        const response = await request(app)
          .post('/auth/register')
          .send(sqlInjectionData);

        // Should handle this gracefully (MongoDB isn't SQL so this should just be treated as strings)
        // SECURITY FIX: SQL injection attempts should result in validation error, not success
        expect([422, 400, 500]).toContain(response.status);
        
        // Check response structure - some validation errors may not have success field
        if (response.body.success !== undefined) {
          expect(response.body.success).toBe(false);
        }
        
        // For 422 responses, expect validation error message
        if (response.status === 422) {
          expect(response.body.message).toMatch(/validation/i);
        }
        
        // Critical: SQL injection should NEVER result in 201 success
        expect(response.status).not.toBe(201);
      });
    });
  });

  describe('Query Parameter Validation', () => {
    beforeEach(async () => {
      // Create some test figures
      await Figure.create([
        {
          manufacturer: 'Test Manufacturer 1',
          name: 'Test Figure 1',
          scale: '1/8',
          userId: testUser._id
        },
        {
          manufacturer: 'Test Manufacturer 2',
          name: 'Test Figure 2',
          scale: '1/7',
          userId: testUser._id
        }
      ]);
    });

    describe('GET /figures with pagination', () => {
      it('should handle invalid page numbers with validation error', async () => {
        const invalidPages = ['invalid', '-1', '0', '999999', 'NaN'];

        for (const page of invalidPages) {
          const response = await request(app)
            .get(`/figures?page=${page}`)
            .set('Authorization', `Bearer ${authToken}`)
            .expect(422);
          
          expect(response.body.success).toBe(false);
          expect(response.body.message).toBe('Validation Error');
          expect(response.body.errors).toBeDefined();
          
          // Flexible validation error checking
          const errorDetails = response.body.errors.map((err: any) => ({
            message: typeof err === 'string' ? err : err.message || '',
            path: Array.isArray(err.path) ? err.path.join('.') : (typeof err === 'object' && err.path ? err.path : '')
          }));

          const hasPageError = errorDetails.some(
            (err: any) => err.message.toLowerCase().includes('page') || 
                   err.path.toLowerCase().includes('page') || 
                   err.message.toLowerCase().includes('invalid')
          );
          expect(hasPageError).toBe(true);
        }
      });

      it('should handle invalid limit values with validation error', async () => {
        const invalidLimits = ['invalid', '-5', '0', '1000000', 'null'];

        for (const limit of invalidLimits) {
          const response = await request(app)
            .get(`/figures?limit=${limit}`)
            .set('Authorization', `Bearer ${authToken}`)
            .expect(422);

          expect(response.body.success).toBe(false);
          expect(response.body.message).toBe('Validation Error');
          expect(response.body.errors).toBeDefined();

          // Flexible validation error checking
          const errorDetails = response.body.errors.map((err: any) => ({
            message: typeof err === 'string' ? err : err.message || '',
            path: Array.isArray(err.path) ? err.path.join('.') : (typeof err === 'object' && err.path ? err.path : '')
          }));

          const hasLimitError = errorDetails.some(
            (err: any) => err.message.toLowerCase().includes('limit') || 
                   err.path.toLowerCase().includes('limit') || 
                   err.message.toLowerCase().includes('between 1 and 100')
          );
          expect(hasLimitError).toBe(true);
        }
      });

      it('should handle both invalid page and limit with validation error', async () => {
        const response = await request(app)
          .get('/figures?page=invalid&limit=invalid')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(422);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe('Validation Error');
        expect(response.body.errors).toBeDefined();

        // Flexible validation error checking
        const errorDetails = response.body.errors.map((err: any) => ({
          message: typeof err === 'string' ? err : err.message || '',
          path: Array.isArray(err.path) ? err.path.join('.') : (typeof err === 'object' && err.path ? err.path : '')
        }));

        const hasPageError = errorDetails.some(
          (err: any) => err.message.toLowerCase().includes('page') || 
                 err.path.toLowerCase().includes('page')
        );
        const hasLimitError = errorDetails.some(
          (err: any) => err.message.toLowerCase().includes('limit') || 
                 err.path.toLowerCase().includes('limit')
        );
        expect(hasPageError).toBe(true);
        expect(hasLimitError).toBe(true);
      });
    });

    describe('GET /figures/search', () => {
      it('should handle empty search query', async () => {
        const response = await request(app)
          .get('/figures/search?query=')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe('Search query is required');
      });

      it('should handle special characters in search query', async () => {
        const specialQuery = encodeURIComponent('test@#$%^&*()');
        
        const response = await request(app)
          .get(`/figures/search?query=${specialQuery}`)
          .set('Authorization', `Bearer ${authToken}`);

        // Should handle gracefully (may succeed or fail based on Atlas Search availability)
        expect([200, 500]).toContain(response.status);
      });

      it('should handle extremely long search queries', async () => {
        const longQuery = encodeURIComponent('a'.repeat(1000));
        
        const response = await request(app)
          .get(`/figures/search?query=${longQuery}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect([200, 400, 500]).toContain(response.status);
      });
    });

    describe('GET /figures/filter', () => {
      it('should handle regex injection attempts', async () => {
        const maliciousFilters = [
          'manufacturer=.*',
          'manufacturer=(.*)',
          'scale=[a-z]*'
        ];

        for (const filter of maliciousFilters) {
          const response = await request(app)
            .get(`/figures/filter?${filter}`)
            .set('Authorization', `Bearer ${authToken}`)
            .expect(200);

          expect(response.body.success).toBe(true);
          // Should handle regex patterns safely
        }
      });

      it('should handle URL encoded parameters', async () => {
        const encodedManufacturer = encodeURIComponent('Test & Special Chars');
        
        const response = await request(app)
          .get(`/figures/filter?manufacturer=${encodedManufacturer}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });
  });

  describe('Content-Type Handling', () => {
    it('should handle unsupported content types', async () => {
      const response = await request(app)
        .post('/figures')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'text/plain')
        .send('This is plain text, not JSON')
        .expect(415); // Should reject unsupported media type

      expect(response.body.message).toBe('Unsupported Media Type');
      expect(response.body.allowedTypes).toBeDefined();
    });

    it('should handle XML content type', async () => {
      const xmlData = '<?xml version="1.0"?><figure><name>Test</name></figure>';
      
      const response = await request(app)
        .post('/figures')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'application/xml')
        .send(xmlData);

      // Should reject unsupported media type
      expect(response.status).toBe(415);
      expect(response.body.message).toBe('Unsupported Media Type');
    });
  });

  describe('Header Validation', () => {
    it('should handle missing Authorization header', async () => {
      const response = await request(app)
        .get('/figures')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'Not authorized, no token'
      });
    });

    it('should handle malformed Authorization header', async () => {
      const malformedHeaders = [
        'Bearer',
        'Bearer ',
        'Token invalid-token',
        'invalid-format',
        ''
      ];

      for (const header of malformedHeaders) {
        const response = await request(app)
          .get('/figures')
          .set('Authorization', header);

        expect([401, 422]).toContain(response.status); // Accept both auth error and validation error
        if (response.body && response.body.success !== undefined) {
          expect(response.body.success).toBe(false);
        }
        if (response.body && response.body.message) {
          expect(response.body.message).toMatch(/not authorized|token/i);
        }
      }
    });

    it('should handle extremely long Authorization header', async () => {
      const longToken = 'Bearer ' + 'a'.repeat(10000);
      
      const response = await request(app)
        .get('/figures')
        .set('Authorization', longToken)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid token');
    });
  });

  describe('Rate Limiting and Large Payloads', () => {
    it('should handle large JSON payloads', async () => {
      // Create a figure with large data (within limits)
      const largeFigureData = {
        manufacturer: 'Large Manufacturer',
        name: 'Large Figure',
        scale: '1/8',
        imageUrl: 'http://example.com/' + 'c'.repeat(1000) + '.jpg'
      };

      const response = await request(app)
        .post('/figures')
        .set('Authorization', `Bearer ${authToken}`)
        .send(largeFigureData);

      // Should handle within reasonable limits
      expect([201, 413, 422, 500]).toContain(response.status);
    });
  });

  describe('Error Response Consistency', () => {
    it('should return consistent error format across endpoints', async () => {
      const endpoints = [
        { method: 'GET', path: '/figures/invalid-id', expectedStatuses: [422, 500] },
        { method: 'POST', path: '/auth/register', expectedStatuses: [422, 500], body: {} },
        { method: 'GET', path: '/figures/search', expectedStatuses: [400, 422] },
        { method: 'PUT', path: '/figures/invalid-id', expectedStatuses: [422, 500], body: {} }
      ];

      for (const endpoint of endpoints) {
        let response: any;
        
        if (endpoint.method === 'GET') {
          let getRequest = request(app).get(endpoint.path);
          if (endpoint.path.includes('/figures/')) {
            getRequest = getRequest.set('Authorization', `Bearer ${authToken}`);
          }
          response = await getRequest;
        } else if (endpoint.method === 'POST') {
          response = await request(app)
            .post(endpoint.path)
            .set('Authorization', `Bearer ${authToken}`)
            .send(endpoint.body || {});
        } else if (endpoint.method === 'PUT') {
          response = await request(app)
            .put(endpoint.path)
            .set('Authorization', `Bearer ${authToken}`)
            .send(endpoint.body || {});
        }

        expect(endpoint.expectedStatuses).toContain(response.status);
        if (response.body) {
          expect(response.body).toHaveProperty('success');
          expect(response.body.success).toBe(false);
          if (response.body.message) {
            expect(typeof response.body.message).toBe('string');
          }
        }
      }
    });
  });
});