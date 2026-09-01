import { Request, Response } from 'express';
import User from '../models/User';
import RefreshToken from '../models/RefreshToken';
import TwoFactorSession from '../models/TwoFactorSession';
import EmailVerificationToken from '../models/EmailVerificationToken';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { handleErrorResponse } from '../utils/responseUtils';
import { sendVerificationEmail } from '../services/emailService';

interface TokenPayload {
  id: string;
}

interface AuthRequest extends Request {
  user: {
    id: string;
  };
}

// Validate JWT configuration on module load
const validateJWTConfig = (): void => {
  if (!process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is required for authentication');
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new Error('FATAL: JWT_REFRESH_SECRET environment variable is required for authentication');
  }
  // Only enforce strict requirements in production
  if (process.env.NODE_ENV === 'production') {
    if (process.env.JWT_SECRET === 'secret' || process.env.JWT_SECRET.length < 32) {
      throw new Error('FATAL: JWT_SECRET must be at least 32 characters in production');
    }
    if (process.env.JWT_REFRESH_SECRET === 'secret' || process.env.JWT_REFRESH_SECRET.length < 32) {
      throw new Error('FATAL: JWT_REFRESH_SECRET must be at least 32 characters in production');
    }
  }
};

// Validate configuration on module load
if (process.env.NODE_ENV !== 'test') {
  validateJWTConfig();
}


// Generate Access Token (short-lived)
const generateAccessToken = (id: string): string => {
  const payload = { id };
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }
  const expiresIn = process.env.ACCESS_TOKEN_EXPIRY || '15m';
  return jwt.sign(payload, secret, { expiresIn: expiresIn as any });
};

// Generate Refresh Token (long-lived)
const generateRefreshToken = (): string => {
  // Use crypto for refresh tokens for better security
  return crypto.randomBytes(40).toString('hex');
};

// Hash refresh token for secure storage
const hashRefreshToken = (token: string): string => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET not configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(token)
    .digest('hex');
};

// Save refresh token to database (stores hashed version)
const saveRefreshToken = async (
  userId: string, 
  token: string, 
  req: Request
): Promise<void> => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry
  
  // Extract device info from user agent
  const deviceInfo = req.headers['user-agent'] || 'Unknown device';
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  // Store hashed token in database
  const hashedToken = hashRefreshToken(token);
  
  await RefreshToken.create({ // NOSONAR - Mongoose ODM (parameterized)
    user: userId,
    token: hashedToken,  // Store the hashed version
    expiresAt,
    deviceInfo,
    ipAddress
  });
};

// Register a new user
export const register = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { username, email, password } = req.body;
    
    // Check if user already exists
    const userExists = await User.findOne({ 
      $or: [{ email }, { username }] 
    });
    
    if (userExists) {
      return res.status(409).json({
        success: false,
        message: 'User already exists'
      });
    }
    
    // Create new user with email verification grace period
    const graceDays = parseInt(process.env.EMAIL_VERIFICATION_GRACE_DAYS || '7', 10);
    const graceExpiry = new Date();
    graceExpiry.setDate(graceExpiry.getDate() + graceDays);

    const user = await User.create({ // NOSONAR - Mongoose ODM (parameterized)
      username,
      email,
      password,
      emailVerified: false,
      emailVerificationGraceExpiry: graceExpiry
    });

    const accessToken = generateAccessToken(user._id.toString());
    const refreshToken = generateRefreshToken();

    // Save refresh token to database
    await saveRefreshToken(user._id.toString(), refreshToken, req);

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await bcrypt.hash(rawToken, 10);
      await EmailVerificationToken.create({
        userId: user._id,
        tokenHash
      });
      await sendVerificationEmail(email, rawToken, user._id.toString());
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
    }

    res.status(201).json({
      success: true,
      data: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        colorProfile: user.colorProfile,
        emailVerified: false,
        accessToken,
        refreshToken
      }
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Login user
export const login = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email }); // NOSONAR - Mongoose ODM (parameterized)

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Grace period for existing users who haven't been assigned one yet
    if (user.emailVerified === undefined || (user.emailVerified === false && !user.emailVerificationGraceExpiry)) {
      const graceDays = parseInt(process.env.EMAIL_VERIFICATION_GRACE_DAYS || '7', 10);
      const graceExpiry = new Date();
      graceExpiry.setDate(graceExpiry.getDate() + graceDays);
      user.emailVerified = false;
      user.emailVerificationGraceExpiry = graceExpiry;
      await user.save();

      // Send verification email silently for existing users
      try {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await bcrypt.hash(rawToken, 10);
        await EmailVerificationToken.create({ userId: user._id, tokenHash });
        await sendVerificationEmail(email, rawToken, user._id.toString());
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
      }
    }

    // Check if 2FA is enabled — intercept and return session instead of tokens
    if (user.twoFactorEnabled) {
      const methods: string[] = [];
      if (user.totp?.verified) methods.push('totp');
      // Check backup codes exist (need to select them)
      const userWithBackup = await User.findById(user._id).select('+backupCodes');
      if (userWithBackup?.backupCodes && userWithBackup.backupCodes.length > 0) {
        methods.push('backup');
      }
      if (user.webauthnCredentials && user.webauthnCredentials.length > 0) {
        methods.push('webauthn');
      }

      const session = await TwoFactorSession.create({
        userId: user._id,
        methods
      });

      return res.status(200).json({
        success: true,
        requiresTwoFactor: true,
        data: {
          sessionId: session._id,
          methods
        }
      });
    }

    const accessToken = generateAccessToken(user._id.toString());
    const refreshToken = generateRefreshToken();

    // Save refresh token to database
    await saveRefreshToken(user._id.toString(), refreshToken, req);

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        colorProfile: user.colorProfile,
        emailVerified: user.emailVerified ?? false,
        twoFactorEnabled: user.twoFactorEnabled ?? false,
        webauthnCredentialCount: user.webauthnCredentials?.length ?? 0,
        accessToken,
        refreshToken
      }
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Refresh access token
export const refresh = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token required'
      });
    }
    
    // Hash the provided token to compare with stored hash
    const hashedToken = hashRefreshToken(refreshToken);
    
    // Find refresh token in database using hashed version
    const storedToken = await RefreshToken.findOne({ token: hashedToken });
    
    if (!storedToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }
    
    // Check if token is expired
    if (storedToken.isExpired()) {
      // Remove expired token
      await RefreshToken.findByIdAndDelete(storedToken._id);
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired'
      });
    }
    
    // Check if user still exists
    const user = await User.findById(storedToken.user);
    
    if (!user) {
      // Remove token if user doesn't exist
      await RefreshToken.findByIdAndDelete(storedToken._id);
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Generate new access token
    const newAccessToken = generateAccessToken(user._id.toString());
    
    // Optional: Rotate refresh token for better security
    if (process.env.ROTATE_REFRESH_TOKENS === 'true') {
      // Delete old refresh token
      await RefreshToken.findByIdAndDelete(storedToken._id);
      
      // Generate new refresh token
      const newRefreshToken = generateRefreshToken();
      await saveRefreshToken(user._id.toString(), newRefreshToken, req);
      
      return res.status(200).json({
        success: true,
        data: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken
        }
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        accessToken: newAccessToken
      }
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Logout user (invalidate refresh token)
export const logout = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { refreshToken } = req.body;
    
    if (refreshToken) {
      // Hash the token to find and remove it
      const hashedToken = hashRefreshToken(refreshToken);
      // Remove specific refresh token
      await RefreshToken.deleteOne({ token: hashedToken });
    } else if (req.user) {
      // If no refresh token provided but user is authenticated,
      // remove all refresh tokens for this user (logout from all devices)
      await RefreshToken.deleteMany({ user: req.user.id });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Logout from all devices
export const logoutAll = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    // Remove all refresh tokens for this user
    await RefreshToken.deleteMany({ user: req.user.id });
    
    res.status(200).json({
      success: true,
      message: 'Logged out from all devices successfully'
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Get active sessions (optional - for user dashboard)
export const getSessions = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const sessions = await RefreshToken.find({
      user: req.user.id,
      expiresAt: { $gt: new Date() }
    }).select('deviceInfo ipAddress createdAt');

    res.status(200).json({
      success: true,
      data: sessions
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Get user profile
export const getProfile = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const user = await User.findById(req.user.id).select('-password');

    if (!user) {
      // Return 401, not 404 - if the user doesn't exist, the JWT is invalid
      // This happens when localStorage has a token from a different database instance
      return res.status(401).json({
        success: false,
        message: 'User not found - session invalid',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        colorProfile: user.colorProfile,
        emailVerified: user.emailVerified ?? false,
        twoFactorEnabled: user.twoFactorEnabled ?? false,
        webauthnCredentialCount: user.webauthnCredentials?.length ?? 0,
        webauthnCredentials: (user.webauthnCredentials || []).map(cred => ({
          credentialId: cred.credentialId,
          nickname: cred.nickname,
          createdAt: cred.createdAt,
        })),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};

// Update user profile (color preference)
export const updateProfile = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const { colorProfile } = req.body;

    // Validate colorProfile if provided
    const validProfiles = ['light', 'dark', 'terminal', 'surprise'];
    if (colorProfile && !validProfiles.includes(colorProfile)) {
      return res.status(400).json({
        success: false,
        message: `Invalid color profile. Must be one of: ${validProfiles.join(', ')}`
      });
    }

    const updateData: { colorProfile?: string } = {};
    if (colorProfile) {
      updateData.colorProfile = colorProfile;
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { returnDocument: 'after', runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        colorProfile: user.colorProfile,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (error: any) {
    return handleErrorResponse(res, error);
  }
};