import request from 'supertest';
import { createTestApp } from '../helpers/testApp';
import User from '../../src/models/User';
import { generateTestToken } from '../setup';
import mongoose from 'mongoose';

const app = createTestApp();

describe('User Routes Integration', () => {
  describe('User Profile Routes', () => {
    describe('GET /users/profile', () => {
    let testUser: any;
    let authToken: string;

    beforeEach(async () => {
      testUser = new User({
        username: 'profileuser',
        email: 'profile@example.com',
        password: 'password123'
      });
      await testUser.save();
      authToken = generateTestToken(testUser._id.toString());
    });

    it('should get user profile with valid token', async () => {
      const response = await request(app)
        .get('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: expect.objectContaining({
          _id: testUser._id.toString(),
          username: 'profileuser',
          email: 'profile@example.com',
          isAdmin: false
        })
      });

      // Should not include password
      expect(response.body.data.password).toBeUndefined();
    });

    it('should return 401 without token', async () => {
      const response = await request(app)
        .get('/users/profile')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'Not authorized, no token'
      });
    });

    it('should return 401 with invalid token', async () => {
      const response = await request(app)
        .get('/users/profile')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    });

    it('should return 401 if user no longer exists (zero trust)', async () => {
      // Delete the user
      await User.findByIdAndDelete(testUser._id);

      // Zero trust: auth middleware now validates user existence
      // Returns 401 because JWT session is invalid when user doesn't exist
      const response = await request(app)
        .get('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'User not found - session invalid',
        code: 'USER_NOT_FOUND'
      });
    });
  });

  describe('PUT /users/profile', () => {
    let testUser: any;
    let authToken: string;

    beforeEach(async () => {
      testUser = new User({
        username: 'updateuser',
        email: 'update@example.com',
        password: 'password123'
      });
      await testUser.save();
      authToken = generateTestToken(testUser._id.toString());
    });

    it('should update user profile successfully', async () => {
      const updateData = {
        username: 'updateduser',
        email: 'updated@example.com'
      };

      const response = await request(app)
        .put('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: expect.objectContaining({
          _id: testUser._id.toString(),
          username: 'updateduser',
          email: 'updated@example.com',
          isAdmin: false
        })
      });

      // Verify changes in database
      const updatedUser = await User.findById(testUser._id);
      expect(updatedUser?.username).toBe('updateduser');
      expect(updatedUser?.email).toBe('updated@example.com');
    });

    it('should update password successfully', async () => {
      const updateData = {
        password: 'newpassword123'
      };

      const response = await request(app)
        .put('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify password was changed
      const updatedUser = await User.findById(testUser._id);
      const isNewPasswordValid = await updatedUser?.comparePassword('newpassword123');
      const isOldPasswordInvalid = await updatedUser?.comparePassword('password123');
      
      expect(isNewPasswordValid).toBe(true);
      expect(isOldPasswordInvalid).toBe(false);
    });

    it('should update only provided fields', async () => {
      const originalUsername = testUser.username;
      const updateData = {
        email: 'newemail@example.com'
        // Only updating email
      };

      const response = await request(app)
        .put('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.data.username).toBe(originalUsername);
      expect(response.body.data.email).toBe('newemail@example.com');
    });

    it('should return 401 without token', async () => {
      const updateData = {
        username: 'newusername'
      };

      const response = await request(app)
        .put('/users/profile')
        .send(updateData)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'Not authorized, no token'
      });
    });

    it('should return 401 if user no longer exists (zero trust)', async () => {
      // Delete the user
      await User.findByIdAndDelete(testUser._id);

      const updateData = {
        username: 'newusername'
      };

      // Zero trust: auth middleware now validates user existence
      // Returns 401 because JWT session is invalid when user doesn't exist
      const response = await request(app)
        .put('/users/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        message: 'User not found - session invalid',
        code: 'USER_NOT_FOUND'
      });
    });
  });
});});
