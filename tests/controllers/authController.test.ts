import { Request, Response } from 'express';
import { register, login, refresh, logout, logoutAll, getProfile, updateProfile } from '../../src/controllers/authController';
import User from '../../src/models/User';
import RefreshToken from '../../src/models/RefreshToken';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import '../setup'; // Import test setup for environment variables

// Mock User model
jest.mock('../../src/models/User');
const MockedUser = jest.mocked(User);

// Mock RefreshToken model
jest.mock('../../src/models/RefreshToken');
const MockedRefreshToken = jest.mocked(RefreshToken);

// Mock JWT
jest.mock('jsonwebtoken');
const mockedJwt = jest.mocked(jwt);

// Mock crypto
jest.mock('crypto');
const mockedCrypto = jest.mocked(crypto);

describe('AuthController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.MockedFunction<any>;

  beforeEach(() => {
    mockRequest = {
      ip: '127.0.0.1',
      headers: {
        'user-agent': 'Jest Test Browser'
      },
      connection: {
        remoteAddress: '127.0.0.1'
      } as any
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('register', () => {
    beforeEach(() => {
      mockRequest.body = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      };
    });

    it('should register a new user successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        save: jest.fn()
      };

      MockedUser.findOne = jest.fn().mockResolvedValue(null);
      MockedUser.create = jest.fn().mockResolvedValue(mockUser);
      mockedJwt.sign = jest.fn().mockReturnValue('access-token');
      mockedCrypto.randomBytes = jest.fn().mockReturnValue({
        toString: jest.fn().mockReturnValue('refresh-token')
      });
      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-refresh-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);
      MockedRefreshToken.create = jest.fn().mockResolvedValue({});

      await register(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findOne).toHaveBeenCalledWith({
        $or: [{ email: 'test@example.com' }, { username: 'testuser' }]
      });
      expect(MockedUser.create).toHaveBeenCalledWith(expect.objectContaining({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
        emailVerified: false,
      }));
      expect(MockedRefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
        user: 'user123',
        token: 'hashed-refresh-token', // Now expecting hashed token
        deviceInfo: 'Jest Test Browser',
        ipAddress: '127.0.0.1'
      }));
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          _id: 'user123',
          username: 'testuser',
          email: 'test@example.com',
          isAdmin: false,
          emailVerified: false,
          accessToken: 'access-token',
          refreshToken: 'refresh-token'
        })
      });
    });

    it('should return error if user already exists by email', async () => {
      const existingUser = {
        _id: 'existing123',
        username: 'existinguser',
        email: 'test@example.com'
      };

      MockedUser.findOne = jest.fn().mockResolvedValue(existingUser);

      await register(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(409);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User already exists'
      });
      expect(MockedUser.create).not.toHaveBeenCalled();
    });

    it('should handle server errors', async () => {
      MockedUser.findOne = jest.fn().mockRejectedValue(new Error('Database error'));

      await register(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'Database error'
      });
    });
  });

  describe('login', () => {
    beforeEach(() => {
      mockRequest.body = {
        email: 'test@example.com',
        password: 'password123'
      };
    });

    it('should login user successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        colorProfile: 'dark',
        emailVerified: true,
        twoFactorEnabled: false,
        webauthnCredentials: [],
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn()
      };

      MockedUser.findOne = jest.fn().mockResolvedValue(mockUser);
      mockedJwt.sign = jest.fn().mockReturnValue('access-token');
      mockedCrypto.randomBytes = jest.fn().mockReturnValue({
        toString: jest.fn().mockReturnValue('refresh-token')
      });
      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-refresh-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);
      MockedRefreshToken.create = jest.fn().mockResolvedValue({});

      await login(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(mockUser.comparePassword).toHaveBeenCalledWith('password123');
      expect(MockedRefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
        user: 'user123',
        token: 'hashed-refresh-token' // Now expecting hashed token
      }));
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          _id: 'user123',
          username: 'testuser',
          email: 'test@example.com',
          isAdmin: false,
          colorProfile: 'dark',
          emailVerified: true,
          twoFactorEnabled: false,
          webauthnCredentialCount: 0,
          accessToken: 'access-token',
          refreshToken: 'refresh-token'
        }
      });
    });

    it('should return error for non-existent user', async () => {
      MockedUser.findOne = jest.fn().mockResolvedValue(null);

      await login(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid email or password'
      });
    });

    it('should return error for incorrect password', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        comparePassword: jest.fn().mockResolvedValue(false)
      };

      MockedUser.findOne = jest.fn().mockResolvedValue(mockUser);

      await login(mockRequest as Request, mockResponse as Response);

      expect(mockUser.comparePassword).toHaveBeenCalledWith('password123');
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid email or password'
      });
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      mockRequest.body = {
        refreshToken: 'valid-refresh-token'
      };
    });

    it('should refresh access token successfully', async () => {
      const mockStoredToken = {
        _id: 'token123',
        user: 'user123',
        token: 'hashed-valid-refresh-token',
        isExpired: jest.fn().mockReturnValue(false)
      };

      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com'
      };

      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-valid-refresh-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);

      MockedRefreshToken.findOne = jest.fn().mockResolvedValue(mockStoredToken);
      MockedUser.findById = jest.fn().mockResolvedValue(mockUser);
      mockedJwt.sign = jest.fn().mockReturnValue('new-access-token');

      await refresh(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.findOne).toHaveBeenCalledWith({ token: 'hashed-valid-refresh-token' });
      expect(MockedUser.findById).toHaveBeenCalledWith('user123');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          accessToken: 'new-access-token'
        }
      });
    });

    it('should return error for missing refresh token', async () => {
      mockRequest.body = {};

      await refresh(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Refresh token required'
      });
    });

    it('should return error for invalid refresh token', async () => {
      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-invalid-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);
      
      MockedRefreshToken.findOne = jest.fn().mockResolvedValue(null);

      await refresh(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid refresh token'
      });
    });

    it('should return error for expired refresh token', async () => {
      const mockStoredToken = {
        _id: 'token123',
        user: 'user123',
        token: 'hashed-expired-refresh-token',
        isExpired: jest.fn().mockReturnValue(true)
      };

      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-expired-refresh-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);

      MockedRefreshToken.findOne = jest.fn().mockResolvedValue(mockStoredToken);
      MockedRefreshToken.findByIdAndDelete = jest.fn().mockResolvedValue({});

      await refresh(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.findByIdAndDelete).toHaveBeenCalledWith('token123');
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Refresh token expired'
      });
    });

    it('should handle token rotation when enabled', async () => {
      process.env.ROTATE_REFRESH_TOKENS = 'true';

      const mockStoredToken = {
        _id: 'token123',
        user: 'user123',
        token: 'hashed-valid-refresh-token',
        isExpired: jest.fn().mockReturnValue(false)
      };

      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com'
      };

      // Mock HMAC for hashing both old and new refresh tokens
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn()
          .mockReturnValueOnce('hashed-valid-refresh-token') // First call for finding token
          .mockReturnValueOnce('hashed-new-refresh-token') // Second call for creating new token
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);

      MockedRefreshToken.findOne = jest.fn().mockResolvedValue(mockStoredToken);
      MockedRefreshToken.findByIdAndDelete = jest.fn().mockResolvedValue({});
      MockedRefreshToken.create = jest.fn().mockResolvedValue({});
      MockedUser.findById = jest.fn().mockResolvedValue(mockUser);
      mockedJwt.sign = jest.fn().mockReturnValue('new-access-token');
      mockedCrypto.randomBytes = jest.fn().mockReturnValue({
        toString: jest.fn().mockReturnValue('new-refresh-token')
      });

      await refresh(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.findByIdAndDelete).toHaveBeenCalledWith('token123');
      expect(MockedRefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
        user: 'user123',
        token: 'hashed-new-refresh-token' // Now expecting hashed token
      }));
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token'
        }
      });

      // Cleanup
      delete process.env.ROTATE_REFRESH_TOKENS;
    });
  });

  describe('logout', () => {
    it('should logout with specific refresh token', async () => {
      mockRequest.body = {
        refreshToken: 'refresh-token-to-remove'
      };

      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-refresh-token-to-remove')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);

      MockedRefreshToken.deleteOne = jest.fn().mockResolvedValue({});

      await logout(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.deleteOne).toHaveBeenCalledWith({ token: 'hashed-refresh-token-to-remove' });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Logged out successfully'
      });
    });

    it('should logout all sessions when user is authenticated', async () => {
      mockRequest.body = {};
      mockRequest.user = { id: 'user123' } as any;

      MockedRefreshToken.deleteMany = jest.fn().mockResolvedValue({});

      await logout(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.deleteMany).toHaveBeenCalledWith({ user: 'user123' });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Logged out successfully'
      });
    });

    it('should handle server errors', async () => {
      mockRequest.body = {
        refreshToken: 'refresh-token'
      };

      // Mock HMAC for hashing the refresh token
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('hashed-refresh-token')
      };
      mockedCrypto.createHmac = jest.fn().mockReturnValue(mockHmac as any);

      MockedRefreshToken.deleteOne = jest.fn().mockRejectedValue(new Error('Database error'));

      await logout(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'Database error'
      });
    });
  });

  describe('logoutAll', () => {
    it('should logout from all devices successfully', async () => {
      mockRequest.user = { id: 'user123' } as any;

      MockedRefreshToken.deleteMany = jest.fn().mockResolvedValue({});

      await logoutAll(mockRequest as Request, mockResponse as Response);

      expect(MockedRefreshToken.deleteMany).toHaveBeenCalledWith({ user: 'user123' });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Logged out from all devices successfully'
      });
    });

    it('should return error when user is not authenticated', async () => {
      mockRequest.user = undefined;

      await logoutAll(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Not authorized'
      });
    });
  });

  describe('getProfile', () => {
    it('should get user profile successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        colorProfile: 'dark',
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02')
      };

      mockRequest.user = { id: 'user123' } as any;
      MockedUser.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await getProfile(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findById).toHaveBeenCalledWith('user123');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          _id: 'user123',
          username: 'testuser',
          email: 'test@example.com',
          isAdmin: false,
          colorProfile: 'dark',
          emailVerified: false,
          twoFactorEnabled: false,
          webauthnCredentialCount: 0,
          webauthnCredentials: [],
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.updatedAt
        }
      });
    });

    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;

      await getProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Not authorized'
      });
    });

    it('should return 401 when user not found (zero trust - session invalid)', async () => {
      mockRequest.user = { id: 'user123' } as any;
      MockedUser.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(null)
      });

      await getProfile(mockRequest as Request, mockResponse as Response);

      // Returns 401 because if user doesn't exist, the JWT session is invalid
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User not found - session invalid',
        code: 'USER_NOT_FOUND'
      });
    });

    it('should handle database errors', async () => {
      mockRequest.user = { id: 'user123' } as any;
      MockedUser.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockRejectedValue(new Error('Database error'))
      });

      await getProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe('updateProfile', () => {
    it('should update color profile successfully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        colorProfile: 'terminal',
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02')
      };

      mockRequest.user = { id: 'user123' } as any;
      mockRequest.body = { colorProfile: 'terminal' };
      MockedUser.findByIdAndUpdate = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findByIdAndUpdate).toHaveBeenCalledWith(
        'user123',
        { colorProfile: 'terminal' },
        { returnDocument: 'after', runValidators: true }
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          _id: 'user123',
          username: 'testuser',
          email: 'test@example.com',
          isAdmin: false,
          colorProfile: 'terminal',
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.updatedAt
        }
      });
    });

    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;
      mockRequest.body = { colorProfile: 'dark' };

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Not authorized'
      });
    });

    it('should return 400 for invalid color profile', async () => {
      mockRequest.user = { id: 'user123' } as any;
      mockRequest.body = { colorProfile: 'invalid-profile' };

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid color profile. Must be one of: light, dark, terminal, surprise'
      });
    });

    it('should return 404 when user not found', async () => {
      mockRequest.user = { id: 'user123' } as any;
      mockRequest.body = { colorProfile: 'dark' };
      MockedUser.findByIdAndUpdate = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(null)
      });

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User not found'
      });
    });

    it('should handle database errors', async () => {
      mockRequest.user = { id: 'user123' } as any;
      mockRequest.body = { colorProfile: 'dark' };
      MockedUser.findByIdAndUpdate = jest.fn().mockReturnValue({
        select: jest.fn().mockRejectedValue(new Error('Database error'))
      });

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });

    it('should handle empty body gracefully', async () => {
      const mockUser = {
        _id: 'user123',
        username: 'testuser',
        email: 'test@example.com',
        isAdmin: false,
        colorProfile: 'light',
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02')
      };

      mockRequest.user = { id: 'user123' } as any;
      mockRequest.body = {};
      MockedUser.findByIdAndUpdate = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await updateProfile(mockRequest as Request, mockResponse as Response);

      expect(MockedUser.findByIdAndUpdate).toHaveBeenCalledWith(
        'user123',
        {},
        { returnDocument: 'after', runValidators: true }
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });
});