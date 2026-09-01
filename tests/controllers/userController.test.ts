import { Request, Response } from 'express';
import { getUserProfile, updateUserProfile } from '../../src/controllers/userController';
import User from '../../src/models/User';
import '../setup'; // Import test setup for environment variables

// Mock User model
jest.mock('../../src/models/User');
const MockedUser = jest.mocked(User);

describe('UserController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.MockedFunction<any>;

  beforeEach(() => {
    mockRequest = {};
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('getUserProfile', () => {
    beforeEach(() => {
      mockRequest.user = { id: 'user123' };
    });

    it('should get user profile successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false
      };

      const mockFindById = {
        select: jest.fn().mockResolvedValue(mockUser)
      };

      MockedUser.findById = jest.fn().mockReturnValue(mockFindById);

      await getUserProfile(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findById).toHaveBeenCalledWith('user123');
      expect(mockFindById.select).toHaveBeenCalledWith('-password');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockUser
      });
    });

    it('should return error if user not found', async () => {
      const mockFindById = {
        select: jest.fn().mockResolvedValue(null)
      };

      MockedUser.findById = jest.fn().mockReturnValue(mockFindById);

      await getUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User not found'
      });
    });

    it('should handle server errors', async () => {
      const mockFindById = {
        select: jest.fn().mockRejectedValue(new Error('Database error'))
      };

      MockedUser.findById = jest.fn().mockReturnValue(mockFindById);

      await getUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'Database error'
      });
    });
  });

  describe('updateUserProfile', () => {
    beforeEach(() => {
      mockRequest.user = { id: 'user123' };
      mockRequest.body = {
        username: 'updateduser',
        email: 'updated@example.com',
        password: 'newpassword'
      };
    });

    it('should update user profile successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        password: 'oldpassword',
        isAdmin: false,
        save: jest.fn().mockResolvedValue({
          _id: 'user123',
          username: 'updateduser',
          email: 'updated@example.com',
          isAdmin: false
        })
      };

      MockedUser.findById = jest.fn().mockResolvedValue(mockUser);

      await updateUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockUser.username).toBe('updateduser');
      expect(mockUser.email).toBe('updated@example.com');
      expect(mockUser.password).toBe('newpassword');
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          _id: 'user123',
          username: 'updateduser',
          email: 'updated@example.com',
          isAdmin: false
        }
      });
    });

    it('should update only provided fields', async () => {
      mockRequest.body = {
        username: 'updateduser'
        // Only username provided
      };

      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        password: 'oldpassword',
        isAdmin: false,
        save: jest.fn().mockResolvedValue({
          _id: 'user123',
          username: 'updateduser',
          email: 'test@example.com',
          isAdmin: false
        })
      };

      MockedUser.findById = jest.fn().mockResolvedValue(mockUser);

      await updateUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockUser.username).toBe('updateduser');
      expect(mockUser.email).toBe('test@example.com'); // Unchanged
      expect(mockUser.password).toBe('oldpassword'); // Unchanged
    });

    it('should return error if user not found', async () => {
      MockedUser.findById = jest.fn().mockResolvedValue(null);

      await updateUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User not found'
      });
    });

    it('should handle server errors', async () => {
      MockedUser.findById = jest.fn().mockRejectedValue(new Error('Database error'));

      await updateUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'Database error'
      });
    });

    it('should handle save errors', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        save: jest.fn().mockRejectedValue(new Error('Save failed'))
      };

      MockedUser.findById = jest.fn().mockResolvedValue(mockUser);

      await updateUserProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'Save failed'
      });
    });
  });
});