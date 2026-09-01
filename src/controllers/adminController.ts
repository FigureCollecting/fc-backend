import { Request, Response } from 'express';
import crypto from 'crypto';
import User from '../models/User';
import SystemConfig from '../models/SystemConfig';
import { createLogger } from '../utils/logger';

const logger = createLogger('ADMIN');

/**
 * Bootstrap admin access using a secret token
 * POST /admin/bootstrap
 * Body: { email: string, token: string }
 */
export const bootstrapAdmin = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { email, token } = req.body;

    // Validate required fields
    if (!email || !token) {
      return res.status(400).json({
        success: false,
        message: 'Email and token are required'
      });
    }

    // Verify bootstrap token from environment
    const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      logger.warn('Bootstrap attempted but ADMIN_BOOTSTRAP_TOKEN not configured');
      return res.status(503).json({
        success: false,
        message: 'Admin bootstrap not configured'
      });
    }

    // Use constant-time comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(token);
    const bootstrapBuffer = Buffer.from(bootstrapToken);
    const tokensMatch = tokenBuffer.length === bootstrapBuffer.length &&
      crypto.timingSafeEqual(tokenBuffer, bootstrapBuffer);

    if (!tokensMatch) {
      logger.warn('Invalid bootstrap token attempt for email:', email);
      return res.status(401).json({
        success: false,
        message: 'Invalid bootstrap token'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found with that email'
      });
    }

    // Check if already admin
    if (user.isAdmin) {
      return res.status(200).json({
        success: true,
        message: 'User is already an admin',
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin
        }
      });
    }

    // Grant admin privileges
    user.isAdmin = true;
    await user.save();

    logger.info('Admin privileges granted to user:', user.email);

    return res.status(200).json({
      success: true,
      message: 'Admin privileges granted successfully',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin
      }
    });
  } catch (error: any) {
    logger.error('Bootstrap admin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during admin bootstrap',
      error: error.message
    });
  }
};

/**
 * Get all system configs (admin only)
 * GET /admin/config
 */
export const getAllConfigs = async (req: Request, res: Response): Promise<Response> => {
  try {
    const configs = await SystemConfig.find()
      .sort({ key: 1 })
      .select('-__v');

    return res.status(200).json({
      success: true,
      count: configs.length,
      data: configs
    });
  } catch (error: any) {
    logger.error('Get all configs error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching configs',
      error: error.message
    });
  }
};

/**
 * Get a specific config by key (admin only)
 * GET /admin/config/:key
 */
export const getConfig = async (req: Request, res: Response): Promise<Response> => {
  try {
    const key = req.params.key as string;

    const config = await SystemConfig.findOne({ key }).select('-__v');
    if (!config) {
      return res.status(404).json({
        success: false,
        message: `Config not found: ${key}`
      });
    }

    return res.status(200).json({
      success: true,
      data: config
    });
  } catch (error: any) {
    logger.error('Get config error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching config',
      error: error.message
    });
  }
};

/**
 * Create or update a config (admin only)
 * PUT /admin/config/:key
 * Body: { value: string, type?: string, description?: string, isPublic?: boolean }
 */
export const upsertConfig = async (req: Request, res: Response): Promise<Response> => {
  try {
    const key = req.params.key as string;
    const { value, type, description, isPublic } = req.body;

    // Validate key format
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid key format. Must be lowercase, start with letter, alphanumeric + underscore only'
      });
    }

    // Validate required fields
    if (value === undefined || value === null) {
      return res.status(400).json({
        success: false,
        message: 'Value is required'
      });
    }

    // Validate type if provided
    const validTypes = ['script', 'markdown', 'json', 'text'];
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    // If type is 'json', validate that value is valid JSON
    if (type === 'json') {
      try {
        JSON.parse(value);
      } catch {
        return res.status(400).json({
          success: false,
          message: 'Value must be valid JSON when type is "json"'
        });
      }
    }

    const updateData: any = {
      value,
      updatedBy: req.user?.id
    };

    if (type !== undefined) updateData.type = type;
    if (description !== undefined) updateData.description = description;
    if (isPublic !== undefined) updateData.isPublic = isPublic;

    const config = await SystemConfig.findOneAndUpdate(
      { key },
      { $set: updateData, $setOnInsert: { key } },
      { returnDocument: 'after', upsert: true, runValidators: true }
    ).select('-__v');

    const isNew = !config.createdAt || config.createdAt.getTime() === config.updatedAt.getTime();

    logger.info('Config', isNew ? 'created' : 'updated', key, 'by user', req.user?.id);

    return res.status(isNew ? 201 : 200).json({
      success: true,
      message: `Config ${isNew ? 'created' : 'updated'} successfully`,
      data: config
    });
  } catch (error: any) {
    logger.error('Upsert config error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error saving config',
      error: error.message
    });
  }
};

/**
 * Delete a config (admin only)
 * DELETE /admin/config/:key
 */
export const deleteConfig = async (req: Request, res: Response): Promise<Response> => {
  try {
    const key = req.params.key as string;

    const config = await SystemConfig.findOneAndDelete({ key });
    if (!config) {
      return res.status(404).json({
        success: false,
        message: `Config not found: ${key}`
      });
    }

    logger.info('Config deleted:', key, 'by user', req.user?.id);

    return res.status(200).json({
      success: true,
      message: 'Config deleted successfully'
    });
  } catch (error: any) {
    logger.error('Delete config error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting config',
      error: error.message
    });
  }
};

/**
 * Get a public config by key (no auth required)
 * GET /config/:key
 */
export const getPublicConfig = async (req: Request, res: Response): Promise<Response> => {
  try {
    const key = req.params.key as string;

    const config = await SystemConfig.findOne({ key, isPublic: true })
      .select('key value type description updatedAt');

    if (!config) {
      return res.status(404).json({
        success: false,
        message: `Config not found or not public: ${key}`
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        key: config.key,
        value: config.value,
        type: config.type,
        description: config.description,
        updatedAt: config.updatedAt
      }
    });
  } catch (error: any) {
    logger.error('Get public config error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching config',
      error: error.message
    });
  }
};
