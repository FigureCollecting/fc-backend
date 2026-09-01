import { Request, Response } from 'express';
import Figure, { IFigure } from '../models/Figure';
import MFCItem from '../models/MFCItem';
import mongoose from 'mongoose';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger';
import { upsertFigureSearchIndex, deleteFigureSearchIndex } from '../services/searchIndexService';
import { validateTags } from '../utils/tagValidation';

// Create secure logger instance for this controller
const logger = createLogger('FIGURE');

/**
 * Extract MFC item ID from either a full URL or just an ID string.
 * Returns the numeric ID or null if extraction fails.
 */
const extractMfcId = (mfcLink: string | undefined): number | null => {
  if (!mfcLink) return null;

  // If it's a URL, extract the ID from the path
  const urlMatch = mfcLink.match(/myfigurecollection\.net\/item\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  // If it's just digits, parse as number
  const trimmed = mfcLink.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  return null;
};

// Schema v3: Company and Artist entry types from scraper
interface IScrapedCompanyEntry {
  name: string;
  role: string;  // "Manufacturer", "Distributor", etc.
  mfcId?: number;
}

interface IScrapedArtistEntry {
  name: string;
  role: string;  // "Sculptor", "Illustrator", etc.
  mfcId?: number;
}

interface IScrapedRelease {
  date?: Date;
  price?: number;
  currency?: string;
  isRerelease: boolean;
  jan?: string;
}

interface MFCScrapedData {
  imageUrl?: string;
  manufacturer?: string;  // Legacy: kept for backward compatibility
  name?: string;
  scale?: string;
  // Schema v3: Company and Artist data with roles
  companies?: IScrapedCompanyEntry[];
  artists?: IScrapedArtistEntry[];
  releases?: IScrapedRelease[];
}

// Axios-based MFC scraping function - local fallback when scraper service is unavailable
const scrapeDataFromMFCWithAxios = async (mfcLink: string): Promise<MFCScrapedData> => {
  logger.debug('Starting scrape for URL', mfcLink);

  // Security: Validate URL is from allowed domain before making request (prevents SSRF)
  // Use exact domain match or subdomain check (with preceding dot) to prevent bypass attacks
  const allowedDomain = 'myfigurecollection.net';
  const parsedUrl = new URL(mfcLink);
  const hostname = parsedUrl.hostname;
  const isAllowedDomain = hostname === allowedDomain || hostname.endsWith('.' + allowedDomain);
  if (!isAllowedDomain) {
    logger.error('Rejected non-MFC URL in scraper fallback');
    return {};
  }

  try {
    logger.debug('Making HTTP request...');
    const response = await axios.get(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      },
      timeout: 15000, // 15 second timeout
      maxRedirects: 5,
      validateStatus: (status) => status < 500 // Accept redirects and client errors
    });

    logger.debug('HTTP Response Status:', response.status);
    logger.debug('Response Content-Type:', response.headers['content-type']);
    logger.debug('Response data length:', response.data ? response.data.length : 'undefined');

    if (!response.data) {
      logger.error('No response data received');
      return {};
    }

    // Check if we got a Cloudflare challenge page
    if (response.data.includes('Just a moment...') || response.data.includes('cf-challenge') || response.status === 403) {
      logger.error('Detected Cloudflare challenge or 403 - scraping blocked');
      logger.debug('Response contains Cloudflare protection. This may require manual extraction.');
      return {};
    }

    logger.debug('Loading HTML with cheerio...');
    const $ = cheerio.load(response.data);
    const scrapedData: MFCScrapedData = {};

    logger.debug('HTML loaded successfully, document length:', $.html().length);

    // Scrape image URL from main item-picture
    logger.debug('Looking for image element...');
    const imageElement = $('.item-picture .main img').first();
    logger.debug('Found .item-picture elements:', $('.item-picture').length);
    logger.debug('Found .item-picture .main elements:', $('.item-picture .main').length);
    logger.debug('Found image elements in .item-picture .main:', imageElement.length);
    if (imageElement.length) {
      const rawUrl = imageElement.attr('src') || '';
      // Upgrade to full-resolution: /upload/items/0/ or /1/ → /upload/items/2/
      scrapedData.imageUrl = rawUrl.replace(/\/upload\/items\/[01]\//, '/upload/items/2/');
      logger.debug('Image URL found:', scrapedData.imageUrl);
    } else {
      logger.debug('No image element found');
    }

    // Scrape manufacturer from span with switch attribute
    logger.debug('Looking for manufacturer span...');
    const manufacturerSpan = $('span[switch]').first();
    logger.debug('Found span[switch] elements:', $('span[switch]').length);
    if (manufacturerSpan.length) {
      scrapedData.manufacturer = manufacturerSpan.text().trim();
      logger.debug('Manufacturer found:', scrapedData.manufacturer);
    } else {
      logger.debug('No manufacturer span found');
    }

    // Scrape name - look for span with Japanese characters (second span with switch)
    logger.debug('Looking for name span...');
    const nameSpan = $('span[switch]').eq(1);
    if (nameSpan.length) {
      scrapedData.name = nameSpan.text().trim();
      logger.debug('Name found:', scrapedData.name);
    } else {
      logger.debug('No name span found');
    }

    // Scrape scale from item-scale class
    logger.debug('Looking for scale element...');
    const scaleElement = $('.item-scale a[title="Scale"]');
    logger.debug('Found .item-scale elements:', $('.item-scale').length);
    logger.debug('Found .item-scale a elements:', $('.item-scale a').length);
    logger.debug('Found .item-scale a[title="Scale"] elements:', scaleElement.length);
    if (scaleElement.length) {
      let scaleText = scaleElement.text().trim();
      scrapedData.scale = scaleText;
      logger.debug('Scale found:', scrapedData.scale);
    } else {
      logger.debug('No scale element found');
    }

    logger.debug('Final scraping results:', scrapedData);
    return scrapedData;

  } catch (error: any) {
    logger.error('Error scraping MFC data:', error.message);
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText
    });

    if (error.response) {
      logger.error('Error response data (truncated):',
        error.response.data ? String(error.response.data).substring(0, 500) : 'No response data');
    }

    return {};
  }
};

// Call dedicated scraper service
const scrapeDataFromMFC = async (mfcLink: string, mfcAuth?: string): Promise<MFCScrapedData> => {
  logger.debug('Starting scrape via scraper service for URL', mfcLink);
  if (mfcAuth) {
    logger.debug('Including MFC authentication cookies');
  }

  const scraperServiceUrl = process.env.SCRAPER_SERVICE_URL || 'http://scraper-dev:3090'; // NOSONAR

  try {
    logger.debug('Calling scraper service at:', scraperServiceUrl);

    const requestBody: any = { url: mfcLink };
    if (mfcAuth) {
      requestBody.mfcAuth = mfcAuth;
    }

    const response = await axios.post(`${scraperServiceUrl}/scrape/mfc`, requestBody, { // NOSONAR - internal service URL from env
      timeout: 45000, // 45 second timeout for browser automation
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.success && response.data.data) {
      logger.debug('Scraper service successful:', response.data.data);
      return response.data.data;
    } else {
      logger.debug('Scraper service returned no data');
      return {};
    }

  } catch (error: any) {
    logger.error('Scraper service failed:', error.message);

    // Check if this is a user-facing error that should be shown to the user
    // (like NSFW auth requirements or MFC 404 messages)
    const errorMessage = error.response?.data?.message || error.message || '';
    if (errorMessage.includes('MFC_ITEM_NOT_ACCESSIBLE') ||
        errorMessage.includes('NSFW_AUTH_REQUIRED') ||
        errorMessage.includes('requires MFC authentication')) {
      // Re-throw user-facing errors so they reach the user
      logger.debug('Re-throwing user-facing error');
      throw new Error(errorMessage);
    }

    // If scraper service is down (network/connection error), try local fallback
    logger.debug('Falling back to local axios method...');
    try {
      const axiosResult = await scrapeDataFromMFCWithAxios(mfcLink);
      if (axiosResult.imageUrl || axiosResult.manufacturer || axiosResult.name) {
        logger.debug('Local fallback successful');
        return axiosResult;
      }
    } catch (fallbackError: any) {
      logger.error('Local fallback also failed:', fallbackError.message);
    }

    // Return manual extraction guidance if all methods fail
    return {
      imageUrl: `MANUAL_EXTRACT:${mfcLink}`,
      manufacturer: '',
      name: '',
      scale: ''
    };
  }
};

// New endpoint for frontend to call when MFC link changes
export const scrapeMFCData = async (req: Request, res: Response) => {
  logger.debug('Received scrape request');

  try {
    const { mfcLink, mfcAuth } = req.body;

    if (!mfcLink) {
      logger.debug('No MFC link provided in request');
      return res.status(400).json({
        success: false,
        message: 'MFC link is required'
      });
    }

    logger.debug('Processing MFC link');
    if (mfcAuth) {
      logger.debug('MFC authentication cookies provided');
    }

    // Validate URL format
    try {
      new URL(mfcLink);
      logger.debug('URL format validation passed');
    } catch (urlError) {
      logger.debug('Invalid URL format');
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format'
      });
    }

    // Check if it's an MFC URL - use strict hostname validation to prevent bypass attacks
    try {
      const parsedMfcUrl = new URL(mfcLink);
      const hostname = parsedMfcUrl.hostname.toLowerCase();
      if (hostname !== 'myfigurecollection.net' && hostname !== 'www.myfigurecollection.net') {
        logger.debug('URL is not from myfigurecollection.net');
        return res.status(400).json({
          success: false,
          message: 'URL must be from myfigurecollection.net'
        });
      }
    } catch {
      logger.debug('Invalid URL format for MFC link');
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format'
      });
    }

    logger.debug('Starting scraping process...');
    const scrapedData = await scrapeDataFromMFC(mfcLink, mfcAuth);
    logger.debug('Scraping completed');

    return res.status(200).json({
      success: true,
      data: scrapedData
    });
  } catch (error: any) {
    logger.error('Error in scrapeMFCData:', error.message);

    // Return the actual error message from the scraper for better UX
    // This includes helpful messages like NSFW auth requirements
    return res.status(500).json({
      success: false,
      message: error.message || 'Server Error',
      error: error.message
    });
  }
};

// Get all figures for the logged-in user with pagination
// Get all figures with optional status filter
// Accepts optional ?status=owned|ordered|wished to filter by collection status
export const getFigures = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const validationErrors: string[] = [];

    // Validate page parameter
    const pageParam = req.query.page as string;
    const page = parseInt(pageParam, 10);
    if (pageParam && (isNaN(page) || page <= 0)) {
      validationErrors.push('Page must be a positive integer');
    }

    // Validate limit parameter
    const limitParam = req.query.limit as string;
    const limit = parseInt(limitParam, 10);
    if (limitParam && (isNaN(limit) || limit <= 0 || limit > 100)) {
      validationErrors.push('Limit must be between 1 and 100');
    }

    // Validate sortBy parameter
    const sortByParam = req.query.sortBy as string;
    const validSortFields = ['createdAt', 'updatedAt', 'name', 'manufacturer', 'scale', 'activity'];
    if (sortByParam && !validSortFields.includes(sortByParam)) {
      validationErrors.push(`sortBy must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder parameter
    const sortOrderParam = req.query.sortOrder as string;
    if (sortOrderParam && !['asc', 'desc'].includes(sortOrderParam)) {
      validationErrors.push('sortOrder must be either asc or desc');
    }

    // Validate status parameter (optional collection status filter)
    const statusParam = req.query.status as string;
    const validStatuses = ['owned', 'ordered', 'wished'];
    if (statusParam && !validStatuses.includes(statusParam)) {
      validationErrors.push(`status must be one of: ${validStatuses.join(', ')}`);
    }

    // Return validation errors if any
    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: validationErrors
      });
    }

    // Use default values if not specified
    const validPage = page || 1;
    const validLimit = limit || 10;
    const validSortBy = sortByParam || 'activity';
    const validSortOrder = sortOrderParam === 'asc' ? 1 : -1;
    const skip = (validPage - 1) * validLimit;

    // Build query filter with optional status
    const query: Record<string, any> = { userId };
    if (statusParam && validStatuses.includes(statusParam)) {
      // Handle legacy figures: null/undefined collectionStatus treated as 'owned'
      if (statusParam === 'owned') {
        query.$or = [
          { collectionStatus: 'owned' },
          { collectionStatus: { $exists: false } },
          { collectionStatus: null }
        ];
      } else {
        query.collectionStatus = statusParam;
      }
    }

    const total = await Figure.countDocuments(query);
    const pages = Math.ceil(total / validLimit);

    // Additional page validation
    if (validPage > pages && total > 0) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: ['Requested page is beyond available pages']
      });
    }

    // Build dynamic sort object - use allowlist guard for property injection safety
    // Map 'activity' to actual DB field 'mfcActivityOrder'
    const allowedSortFields = ['createdAt', 'updatedAt', 'name', 'manufacturer', 'scale', 'activity'];
    const safeSortBy = allowedSortFields.includes(validSortBy) ? validSortBy : 'activity';
    const dbSortField = safeSortBy === 'activity' ? 'mfcActivityOrder' : safeSortBy;
    const sortOptions: Record<string, 1 | -1> = { [dbSortField]: validSortOrder };

    const figures = await Figure.find(query)
      .sort(sortOptions)
      .collation({ locale: 'en', strength: 2 })
      .skip(skip)
      .limit(validLimit);

    return res.status(200).json({
      success: true,
      count: figures.length,
      page: validPage,
      pages,
      total,
      data: figures
    });
  } catch (error: any) {
    logger.error('Get Figures Error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: 'An unexpected error occurred while fetching figures'
    });
  }
};

// Get a single figure by ID
export const getFigureById = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const figure = await Figure.findOne({ // NOSONAR - Mongoose ODM (parameterized)
      _id: req.params.id,
      userId
    });

    if (!figure) {
      return res.status(404).json({
        success: false,
        message: 'Figure not found'
      });
    }

    // Enrich with shared catalog data (community stats, related items)
    const figureObj = figure.toObject();
    if (figure.mfcId) {
      const mfcItem = await MFCItem.findOne(
        { mfcId: figure.mfcId },
        { communityStats: 1, relatedItems: 1 }
      ).lean();
      if (mfcItem) {
        if (mfcItem.communityStats) (figureObj as any).communityStats = mfcItem.communityStats;
        if (mfcItem.relatedItems && mfcItem.relatedItems.length > 0) {
          (figureObj as any).relatedItems = mfcItem.relatedItems;
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: figureObj
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

// Updated createFigure with enhanced scraping and v3.0 fields
export const createFigure = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    // Destructure all v3.0 fields from request body
    const {
      // Core fields
      manufacturer, name, scale, mfcLink, mfcAuth, imageUrl,
      // v3.0 fields
      jan, mfcId,
      // Schema v3: Array fields
      companyRoles, artistRoles, releases: releasesArray,
      // Schema v3: MFC-specific fields
      mfcTitle, origin, version, category, classification, materials, tags,
      // Release info (flat form fields - legacy)
      releaseDate, releasePrice, releaseCurrency,
      // Dimensions (flat form fields)
      heightMm, widthMm, depthMm,
      // Collection status
      collectionStatus, rating, wishRating, quantity, note,
      // Purchase info (flat form fields)
      purchaseDate, purchasePrice, purchaseCurrency,
      // Merchant info (flat form fields)
      merchantName, merchantUrl,
      // Condition
      figureCondition, figureConditionNotes, boxCondition, boxConditionNotes,
      // Legacy
      type, description
    } = req.body;

    // Validate tags if provided
    if (tags) {
      const { invalid } = validateTags(tags);
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid tags: ${invalid.join(', ')}`,
        });
      }
    }

    // Schema v3: Derive manufacturer from companyRoles if not provided directly
    let resolvedManufacturer = manufacturer;
    if (!resolvedManufacturer && companyRoles && Array.isArray(companyRoles) && companyRoles.length > 0) {
      // Find the first company with 'Manufacturer' role, or just use first company
      const manufacturerRole = companyRoles.find(
        (cr: any) => cr.roleName?.toLowerCase() === 'manufacturer'
      );
      resolvedManufacturer = manufacturerRole?.companyName || companyRoles[0]?.companyName || '';
    }

    // Basic validation is now handled by Joi middleware
    // Only need to validate URLs here since Joi doesn't have custom URL domain validation
    const validationErrors: string[] = [];
    
    if (mfcLink) {
      // Accept either a full MFC URL or just the numeric item ID
      const numericIdPattern = /^\d+$/;
      if (!numericIdPattern.test(mfcLink)) {
        // Not a numeric ID, must be a valid MFC URL
        try {
          const parsedUrl = new URL(mfcLink);
          const hostname = parsedUrl.hostname.toLowerCase();
          if (hostname !== 'myfigurecollection.net' && hostname !== 'www.myfigurecollection.net') {
            validationErrors.push('Invalid MFC link domain');
          }
        } catch {
          validationErrors.push('Invalid MFC link format');
        }
      }
      // If it's a numeric ID, it's valid - no further validation needed
    }
    
    if (imageUrl) {
      try {
        new URL(imageUrl);
      } catch {
        validationErrors.push('Invalid image URL format');
      }
    }
    
    // Return validation errors if any
    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: validationErrors
      });
    }
    
    // Check for duplicate figure for the user (only if we have manufacturer and name)
    // Schema v3: Use resolvedManufacturer which can come from companyRoles[]
    if (resolvedManufacturer && resolvedManufacturer.trim() && name && name.trim()) {
      const existingFigure = await Figure.findOne({
        userId,
        manufacturer: resolvedManufacturer.trim(),
        name: name.trim()
      });
      
      if (existingFigure) {
        return res.status(409).json({
          success: false,
          message: 'A figure with the same name and manufacturer already exists'
        });
      }
    }
    
    // Start with provided data
    // Schema v3: Use resolvedManufacturer which can come from companyRoles[]
    let finalData = {
      manufacturer: resolvedManufacturer ? resolvedManufacturer.trim() : '',
      name: name ? name.trim() : '',
      scale: scale ? scale.trim() : '',
      imageUrl: imageUrl ? imageUrl.trim() : '',
    };
    
    // If MFC link is provided, only scrape if there are missing fields to fill
    // This avoids redundant scrapes when data was already populated by the frontend
    if (mfcLink && mfcLink.trim()) {
      const needsScrape = !finalData.imageUrl || !finalData.manufacturer || !finalData.name || !finalData.scale;

      if (needsScrape) {
        const scrapedData = await scrapeDataFromMFC(mfcLink.trim(), mfcAuth);

        // Only use scraped data if the field is empty
        if (!finalData.imageUrl && scrapedData.imageUrl) {
          finalData.imageUrl = scrapedData.imageUrl;
        }
        if (!finalData.manufacturer && scrapedData.manufacturer) {
          finalData.manufacturer = scrapedData.manufacturer;
        }
        if (!finalData.name && scrapedData.name) {
          finalData.name = scrapedData.name;
        }
        if (!finalData.scale && scrapedData.scale) {
          finalData.scale = scrapedData.scale;
        }
      }
    }
    
    // Post-scraping validation: ensure required fields are now available
    const postScrapingErrors: string[] = [];
    if (!finalData.manufacturer || finalData.manufacturer.trim().length === 0) {
      postScrapingErrors.push('Manufacturer is required and could not be scraped from MFC');
    }
    if (!finalData.name || finalData.name.trim().length === 0) {
      postScrapingErrors.push('Name is required and could not be scraped from MFC');
    }
    
    if (postScrapingErrors.length > 0) {
      return res.status(422).json({
        success: false,
        message: 'Validation failed after MFC scraping',
        errors: postScrapingErrors
      });
    }
    
    // Build releases array - prefer Schema v3 releasesArray over legacy flat fields
    let releases: any[] = [];
    if (releasesArray && Array.isArray(releasesArray) && releasesArray.length > 0) {
      // Schema v3: Use the structured releases array from frontend
      releases = releasesArray.map((r: any) => ({
        date: r.date ? new Date(r.date) : undefined,
        price: r.price,
        currency: r.currency || 'JPY',
        isRerelease: r.isRerelease || false,
        jan: r.jan
      }));
    } else if (releaseDate || releasePrice || releaseCurrency) {
      // Legacy: Build from flat fields
      releases.push({
        date: releaseDate ? new Date(releaseDate) : undefined,
        price: releasePrice,
        currency: releaseCurrency || 'JPY',
        isRerelease: false,
        jan: jan
      });
    }

    // Build dimensions object from flat form fields
    const dimensions = (heightMm || widthMm || depthMm) ? {
      heightMm,
      widthMm,
      depthMm
    } : undefined;

    // Build purchaseInfo object from flat form fields
    const purchaseInfo = (purchaseDate || purchasePrice || purchaseCurrency) ? {
      date: purchaseDate ? new Date(purchaseDate) : undefined,
      price: purchasePrice,
      currency: purchaseCurrency || 'USD'
    } : undefined;

    // Build merchant object from flat form fields
    const merchant = (merchantName || merchantUrl) ? {
      name: merchantName,
      url: merchantUrl
    } : undefined;

    // Extract mfcId from mfcLink if not provided
    const resolvedMfcId = mfcId ?? extractMfcId(mfcLink);
    // Normalize mfcLink to just the ID for cleaner storage
    const normalizedMfcLink = resolvedMfcId ? String(resolvedMfcId) : (mfcLink ? mfcLink.trim() : '');

    const figure = await Figure.create({
      // Core identification
      manufacturer: finalData.manufacturer,
      name: finalData.name,
      scale: finalData.scale,
      mfcLink: normalizedMfcLink,
      mfcId: resolvedMfcId,
      jan: jan,

      // Schema v3: Company and Artist roles
      companyRoles: companyRoles && companyRoles.length > 0 ? companyRoles : undefined,
      artistRoles: artistRoles && artistRoles.length > 0 ? artistRoles : undefined,

      // Schema v3: MFC-specific fields
      mfcTitle: mfcTitle || undefined,
      origin: origin || undefined,
      version: version || undefined,
      category: category || undefined,
      classification: classification || undefined,
      materials: materials || undefined,
      tags: tags && tags.length > 0 ? tags : undefined,

      // Media
      imageUrl: finalData.imageUrl,

      // Releases and dimensions
      releases: releases.length > 0 ? releases : undefined,
      dimensions: dimensions,

      // User-specific data
      userId,
      collectionStatus: collectionStatus || 'owned',
      quantity: quantity || 1,
      rating: rating,
      wishRating: wishRating,
      note: note,

      // Purchase info
      purchaseInfo: purchaseInfo,
      merchant: merchant,

      // Condition - convert empty strings to undefined for Mongoose enum validation
      figureCondition: figureCondition || undefined,
      figureConditionNotes: figureConditionNotes,
      boxCondition: boxCondition || undefined,
      boxConditionNotes: boxConditionNotes,

      // Legacy
      type: type || 'action figure',
      description: description
    });

    // Sync search index (fire-and-forget)
    upsertFigureSearchIndex(figure).catch(() => {});

    return res.status(201).json({
      success: true,
      data: figure
    });
  } catch (error: any) {
    // Handle mongoose validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map((err: any) => err.message);
      return res.status(422).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    // Log server errors for debugging
    logger.error('Create Figure Error:', error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: 'An unexpected error occurred during figure creation'
    });
  }
};

// Update a figure with v3.0 fields
export const updateFigure = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    // Destructure all v3.0 fields from request body
    const {
      // Core fields
      manufacturer, name, scale, mfcLink, mfcAuth, imageUrl,
      // v3.0 fields
      jan, mfcId,
      // Schema v3: Array fields
      companyRoles, artistRoles, releases: releasesArray,
      // Schema v3: MFC-specific fields
      mfcTitle, origin, version, category, classification, materials, tags,
      // Release info (flat form fields - legacy)
      releaseDate, releasePrice, releaseCurrency,
      // Dimensions (flat form fields)
      heightMm, widthMm, depthMm,
      // Collection status
      collectionStatus, rating, wishRating, quantity, note,
      // Purchase info (flat form fields)
      purchaseDate, purchasePrice, purchaseCurrency,
      // Merchant info (flat form fields)
      merchantName, merchantUrl,
      // Condition
      figureCondition, figureConditionNotes, boxCondition, boxConditionNotes,
      // Legacy
      type, description
    } = req.body;

    // Validate tags if provided
    if (tags) {
      const { invalid } = validateTags(tags);
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid tags: ${invalid.join(', ')}`,
        });
      }
    }

    // Schema v3: Derive manufacturer from companyRoles if not provided directly
    let resolvedManufacturer = manufacturer;
    if (!resolvedManufacturer && companyRoles && Array.isArray(companyRoles) && companyRoles.length > 0) {
      const manufacturerRole = companyRoles.find(
        (cr: any) => cr.roleName?.toLowerCase() === 'manufacturer'
      );
      resolvedManufacturer = manufacturerRole?.companyName || companyRoles[0]?.companyName || '';
    }

    // Find figure and check ownership
    let figure = await Figure.findOne({ // NOSONAR - Mongoose ODM (parameterized)
      _id: req.params.id,
      userId
    });

    if (!figure) {
      return res.status(404).json({
        success: false,
        message: 'Figure not found or you do not have permission'
      });
    }

    // Schema v3: Use resolvedManufacturer which can come from companyRoles[]
    let finalData = {
      manufacturer: resolvedManufacturer,
      name,
      scale,
      imageUrl,
    };

    // Only scrape if MFC link is provided, not empty, different from existing, and there are missing fields
    if (mfcLink && mfcLink.trim() && mfcLink.trim() !== figure.mfcLink) {
      const needsScrape = !finalData.imageUrl || !finalData.manufacturer || !finalData.name || !finalData.scale;

      if (needsScrape) {
        const scrapedData = await scrapeDataFromMFC(mfcLink.trim(), mfcAuth);

        // Only use scraped data if the field is empty
        if (!finalData.imageUrl && scrapedData.imageUrl) {
          finalData.imageUrl = scrapedData.imageUrl;
        }
        if (!finalData.manufacturer && scrapedData.manufacturer) {
          finalData.manufacturer = scrapedData.manufacturer;
        }
        if (!finalData.name && scrapedData.name) {
          finalData.name = scrapedData.name;
        }
        if (!finalData.scale && scrapedData.scale) {
          finalData.scale = scrapedData.scale;
        }
      }
    } else if (!imageUrl && !mfcLink) {
      // Keep existing image if no new image URL and no MFC link
      finalData.imageUrl = figure.imageUrl;
    }

    // Build releases array - prefer Schema v3 releasesArray over legacy flat fields
    let releases: any[] = figure.releases || [];
    if (releasesArray && Array.isArray(releasesArray) && releasesArray.length > 0) {
      // Schema v3: Use the structured releases array from frontend
      releases = releasesArray.map((r: any) => ({
        date: r.date ? new Date(r.date) : undefined,
        price: r.price,
        currency: r.currency || 'JPY',
        isRerelease: r.isRerelease || false,
        jan: r.jan
      }));
    } else if (releaseDate || releasePrice || releaseCurrency || jan) {
      // Legacy: Update or add first release from flat fields
      if (releases.length > 0) {
        releases[0] = {
          ...releases[0],
          date: releaseDate ? new Date(releaseDate) : releases[0].date,
          price: releasePrice !== undefined ? releasePrice : releases[0].price,
          currency: releaseCurrency || releases[0].currency || 'JPY',
          jan: jan || releases[0].jan
        };
      } else {
        releases.push({
          date: releaseDate ? new Date(releaseDate) : undefined,
          price: releasePrice,
          currency: releaseCurrency || 'JPY',
          isRerelease: false,
          jan: jan
        });
      }
    }

    // Build dimensions object from flat form fields
    const dimensions = (heightMm !== undefined || widthMm !== undefined || depthMm !== undefined) ? {
      heightMm: heightMm !== undefined ? heightMm : figure.dimensions?.heightMm,
      widthMm: widthMm !== undefined ? widthMm : figure.dimensions?.widthMm,
      depthMm: depthMm !== undefined ? depthMm : figure.dimensions?.depthMm
    } : figure.dimensions;

    // Build purchaseInfo object from flat form fields
    const purchaseInfo = (purchaseDate !== undefined || purchasePrice !== undefined || purchaseCurrency !== undefined) ? {
      date: purchaseDate ? new Date(purchaseDate) : figure.purchaseInfo?.date,
      price: purchasePrice !== undefined ? purchasePrice : figure.purchaseInfo?.price,
      currency: purchaseCurrency || figure.purchaseInfo?.currency || 'USD'
    } : figure.purchaseInfo;

    // Build merchant object from flat form fields
    const merchant = (merchantName !== undefined || merchantUrl !== undefined) ? {
      name: merchantName !== undefined ? merchantName : figure.merchant?.name,
      url: merchantUrl !== undefined ? merchantUrl : figure.merchant?.url
    } : figure.merchant;

    // Extract mfcId from mfcLink if not provided, otherwise use existing
    const resolvedMfcId = mfcId ?? extractMfcId(mfcLink) ?? figure.mfcId;
    // Normalize mfcLink to just the ID for cleaner storage
    const normalizedMfcLink = resolvedMfcId ? String(resolvedMfcId) : (mfcLink ? mfcLink.trim() : figure.mfcLink || '');

    // Update figure with all v3.0 fields
    figure = await Figure.findByIdAndUpdate(
      req.params.id,
      {
        // Core identification
        manufacturer: finalData.manufacturer,
        name: finalData.name,
        scale: finalData.scale,
        mfcLink: normalizedMfcLink,
        mfcId: resolvedMfcId,
        jan: jan !== undefined ? jan : figure.jan,

        // Schema v3: Company and Artist roles
        companyRoles: companyRoles !== undefined ? (companyRoles && companyRoles.length > 0 ? companyRoles : undefined) : figure.companyRoles,
        artistRoles: artistRoles !== undefined ? (artistRoles && artistRoles.length > 0 ? artistRoles : undefined) : figure.artistRoles,

        // Schema v3: MFC-specific fields
        mfcTitle: mfcTitle !== undefined ? (mfcTitle || undefined) : figure.mfcTitle,
        origin: origin !== undefined ? (origin || undefined) : figure.origin,
        version: version !== undefined ? (version || undefined) : figure.version,
        category: category !== undefined ? (category || undefined) : figure.category,
        classification: classification !== undefined ? (classification || undefined) : figure.classification,
        materials: materials !== undefined ? (materials || undefined) : figure.materials,
        tags: tags !== undefined ? (tags && tags.length > 0 ? tags : undefined) : figure.tags,

        // Media
        imageUrl: finalData.imageUrl,

        // Releases and dimensions
        releases: releases,
        dimensions: dimensions,

        // User-specific data
        collectionStatus: collectionStatus !== undefined ? collectionStatus : figure.collectionStatus,
        quantity: quantity !== undefined ? quantity : figure.quantity,
        rating: rating !== undefined ? rating : figure.rating,
        wishRating: wishRating !== undefined ? wishRating : figure.wishRating,
        note: note !== undefined ? note : figure.note,

        // Purchase info
        purchaseInfo: purchaseInfo,
        merchant: merchant,

        // Condition - convert empty strings to undefined for Mongoose enum validation
        figureCondition: figureCondition !== undefined ? (figureCondition || undefined) : figure.figureCondition,
        figureConditionNotes: figureConditionNotes !== undefined ? figureConditionNotes : figure.figureConditionNotes,
        boxCondition: boxCondition !== undefined ? (boxCondition || undefined) : figure.boxCondition,
        boxConditionNotes: boxConditionNotes !== undefined ? boxConditionNotes : figure.boxConditionNotes,

        // Legacy
        type: type !== undefined ? type : figure.type,
        description: description !== undefined ? description : figure.description
      },
      { returnDocument: 'after' }
    );

    // Sync search index (fire-and-forget)
    if (figure) {
      upsertFigureSearchIndex(figure).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      data: figure
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

// Delete a figure
export const deleteFigure = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    
    // Find figure and check ownership
    const figure = await Figure.findOne({ // NOSONAR - Mongoose ODM (parameterized)
      _id: req.params.id,
      userId
    });

    if (!figure) {
      return res.status(404).json({
        success: false,
        message: 'Figure not found or you do not have permission'
      });
    }

    // Delete from MongoDB
    await Figure.deleteOne({ _id: req.params.id }); // NOSONAR - Mongoose ODM (parameterized)

    // Sync search index (fire-and-forget)
    try {
      deleteFigureSearchIndex(new mongoose.Types.ObjectId(req.params.id as string)).catch(() => {});
    } catch { /* ignore ObjectId conversion errors */ }

    return res.status(200).json({
      success: true,
      message: 'Figure removed successfully'
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

// Advanced filter figures
export const filterFigures = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const { manufacturer, scale, status, origin, category, distributor, tag, tagGroup, sculptor, illustrator, classification } = req.query;

    const query: any = { userId };

    // Collection status filter (owned/ordered/wished)
    // Handle legacy figures: null/undefined collectionStatus treated as 'owned'
    const validStatuses = ['owned', 'ordered', 'wished'];
    if (status && validStatuses.includes(status as string)) {
      if (status === 'owned') {
        query.$or = [
          { collectionStatus: 'owned' },
          { collectionStatus: { $exists: false } },
          { collectionStatus: null }
        ];
      } else {
        query.collectionStatus = status;
      }
    }

    // Escape regex special characters in filter values (e.g., "1/7" contains "/")
    const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

    // Split multi-value filter params using pipe delimiter (preferred) or comma (legacy)
    // Pipe avoids collision with commas in values like "Kanojo, Okarishimasu"
    const splitFilterValues = (value: string): string[] => {
      // Always split on pipe — commas may appear inside values (e.g., "Kanojo, Okarishimasu")
      return value.split('|').map(v => v.trim()).filter(Boolean);
    };

    // Support pipe-separated (or comma-separated) values for multi-select faceted filtering
    // e.g., manufacturer=Good+Smile+Company|Alter → matches either manufacturer
    // Search BOTH legacy manufacturer field AND companyRoles with Manufacturer role
    if (manufacturer) {
      const values = splitFilterValues(manufacturer as string);
      const manufacturerPatterns = values.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'));

      // Match either legacy manufacturer OR companyRoles with Manufacturer role
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          // Legacy manufacturer field
          { manufacturer: values.length > 1 ? { $in: manufacturerPatterns } : manufacturerPatterns[0] },
          // v3 companyRoles with Manufacturer role
          {
            companyRoles: {
              $elemMatch: {
                roleName: 'Manufacturer',
                companyName: values.length > 1 ? { $in: manufacturerPatterns } : manufacturerPatterns[0]
              }
            }
          }
        ]
      });
    }

    // Filter by distributor (Schema v3 companyRoles with Distributor role)
    if (distributor) {
      const values = splitFilterValues(distributor as string);
      const distributorPatterns = values.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'));

      query.$and = query.$and || [];
      query.$and.push({
        companyRoles: {
          $elemMatch: {
            roleName: 'Distributor',
            companyName: values.length > 1 ? { $in: distributorPatterns } : distributorPatterns[0]
          }
        }
      });
    }
    if (scale) {
      const values = splitFilterValues(scale as string);
      // Handle special "__unspecified__" value for null/empty scales
      const hasUnspecified = values.includes('__unspecified__');
      const specifiedValues = values.filter(v => v !== '__unspecified__');

      if (hasUnspecified && specifiedValues.length > 0) {
        // Mix of unspecified and specified values: use $or
        query.scale = {
          $in: [
            null,
            '',
            ...specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'))
          ]
        };
      } else if (hasUnspecified) {
        // Only unspecified: match null or empty string
        query.scale = { $in: [null, ''] };
      } else {
        // Only specified values
        query.scale = specifiedValues.length > 1
          ? { $in: specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i')) }
          : { $regex: `^${escapeRegex(specifiedValues[0])}$`, $options: 'i' };
      }
    }
    // Tag filter: exact match in tags array
    if (tag) {
      query.tags = tag as string;
    }
    // Tag group filter: prefix match on tags (e.g., "character" matches "character:miku")
    if (tagGroup) {
      query.tags = { $regex: `^${tagGroup as string}:`, $options: 'i' };
    }
    if (origin) {
      const values = splitFilterValues(origin as string);
      // Handle special "__unspecified__" value for null/empty origins
      const hasUnspecified = values.includes('__unspecified__');
      const specifiedValues = values.filter(v => v !== '__unspecified__');

      if (hasUnspecified && specifiedValues.length > 0) {
        query.origin = {
          $in: [null, '', ...specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'))]
        };
      } else if (hasUnspecified) {
        query.origin = { $in: [null, ''] };
      } else {
        query.origin = specifiedValues.length > 1
          ? { $in: specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i')) }
          : { $regex: `^${escapeRegex(specifiedValues[0])}$`, $options: 'i' };
      }
    }
    if (category) {
      const values = splitFilterValues(category as string);
      // Handle special "__unspecified__" value for null/empty categories
      const hasUnspecified = values.includes('__unspecified__');
      const specifiedValues = values.filter(v => v !== '__unspecified__');

      if (hasUnspecified && specifiedValues.length > 0) {
        query.category = {
          $in: [null, '', ...specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'))]
        };
      } else if (hasUnspecified) {
        query.category = { $in: [null, ''] };
      } else {
        query.category = specifiedValues.length > 1
          ? { $in: specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i')) }
          : { $regex: `^${escapeRegex(specifiedValues[0])}$`, $options: 'i' };
      }
    }

    // Filter by sculptor (Schema v3 artistRoles with Sculptor role)
    if (sculptor) {
      const values = splitFilterValues(sculptor as string);
      const sculptorPatterns = values.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'));

      query.$and = query.$and || [];
      query.$and.push({
        artistRoles: {
          $elemMatch: {
            roleName: 'Sculptor',
            artistName: values.length > 1 ? { $in: sculptorPatterns } : sculptorPatterns[0]
          }
        }
      });
    }

    // Filter by illustrator (Schema v3 artistRoles with Illustrator role)
    if (illustrator) {
      const values = splitFilterValues(illustrator as string);
      const illustratorPatterns = values.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'));

      query.$and = query.$and || [];
      query.$and.push({
        artistRoles: {
          $elemMatch: {
            roleName: 'Illustrator',
            artistName: values.length > 1 ? { $in: illustratorPatterns } : illustratorPatterns[0]
          }
        }
      });
    }

    // Filter by classification
    if (classification) {
      const values = splitFilterValues(classification as string);
      const hasUnspecified = values.includes('__unspecified__');
      const specifiedValues = values.filter(v => v !== '__unspecified__');

      if (hasUnspecified && specifiedValues.length > 0) {
        query.classification = {
          $in: [null, '', ...specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i'))]
        };
      } else if (hasUnspecified) {
        query.classification = { $in: [null, ''] };
      } else {
        query.classification = specifiedValues.length > 1
          ? { $in: specifiedValues.map(v => new RegExp(`^${escapeRegex(v)}$`, 'i')) }
          : { $regex: `^${escapeRegex(specifiedValues[0])}$`, $options: 'i' };
      }
    }

    const pageParam = req.query.page as string;
    const page = parseInt(pageParam, 10);
    if (pageParam && (isNaN(page) || page <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'Pagination validation failed',
        errors: ['Page must be a positive integer']
      });
    }

    const limitParam = req.query.limit as string;
    const limit = parseInt(limitParam, 10);
    if (limitParam && (isNaN(limit) || limit <= 0 || limit > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Pagination validation failed',
        errors: ['Limit must be between 1 and 100']
      });
    }

    // Validate sortBy parameter
    const sortByParam = req.query.sortBy as string;
    const validSortFields = ['createdAt', 'updatedAt', 'name', 'manufacturer', 'scale', 'activity'];
    if (sortByParam && !validSortFields.includes(sortByParam)) {
      return res.status(400).json({
        success: false,
        message: 'Sort validation failed',
        errors: [`sortBy must be one of: ${validSortFields.join(', ')}`]
      });
    }

    // Validate sortOrder parameter
    const sortOrderParam = req.query.sortOrder as string;
    if (sortOrderParam && !['asc', 'desc'].includes(sortOrderParam)) {
      return res.status(400).json({
        success: false,
        message: 'Sort validation failed',
        errors: ['sortOrder must be either asc or desc']
      });
    }

    const validPage = page || 1;
    const validLimit = limit || 10;
    const validSortBy = sortByParam || 'activity';
    const validSortOrder = sortOrderParam === 'asc' ? 1 : -1;
    const skip = (validPage - 1) * validLimit;

    const total = await Figure.countDocuments(query);
    const pages = Math.ceil(total / validLimit);

    // Validate page is within total pages
    if (validPage > pages && total > 0) {
      return res.status(400).json({
        success: false,
        message: 'Pagination validation failed',
        errors: [`Requested page ${validPage} is beyond the total of ${pages} pages`]
      });
    }

    // Build dynamic sort object - use allowlist guard for property injection safety
    // Map 'activity' to actual DB field 'mfcActivityOrder'
    const allowedSortFields = ['createdAt', 'updatedAt', 'name', 'manufacturer', 'scale', 'activity'];
    const safeSortBy = allowedSortFields.includes(validSortBy) ? validSortBy : 'activity';
    const dbSortField = safeSortBy === 'activity' ? 'mfcActivityOrder' : safeSortBy;
    const sortOptions: Record<string, 1 | -1> = { [dbSortField]: validSortOrder };

    const figures = await Figure.find(query)
      .sort(sortOptions)
      .collation({ locale: 'en', strength: 2 })
      .skip(skip)
      .limit(validLimit);

    return res.status(200).json({
      success: true,
      count: figures.length,
      page: validPage,
      pages,
      total,
      data: figures
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

