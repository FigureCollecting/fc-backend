import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as figureController from '../../src/controllers/figureController';
import Figure from '../../src/models/Figure';
import axios from 'axios';
import '../setup'; // Import test setup for environment variables

// Mock searchIndexService (fire-and-forget calls in CRUD)
jest.mock('../../src/services/searchIndexService', () => ({
  upsertFigureSearchIndex: jest.fn().mockResolvedValue(undefined),
  deleteFigureSearchIndex: jest.fn().mockResolvedValue(undefined),
}));

// Mock tagValidation
jest.mock('../../src/utils/tagValidation', () => ({
  validateTags: jest.fn().mockReturnValue({ valid: [], invalid: [] }),
}));

// Comprehensive mocking for Figure model and external dependencies
jest.mock('../../src/models/Figure', () => {
  return {
    __esModule: true,
    default: {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      countDocuments: jest.fn(),
      aggregate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      deleteOne: jest.fn()
    },
    // Maintain mongoose-like behavior for ObjectId conversion
    Types: {
      ObjectId: {
        isValid: jest.fn().mockReturnValue(true)
      }
    }
  };
});
const MockedFigure = jest.mocked(Figure);

// Enhanced axios mocking with more robust error handling
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
    create: jest.fn()
  },
  post: jest.fn(),
  get: jest.fn(),
  create: jest.fn()
}));
const mockedAxios = jest.mocked(axios);

describe('FigureController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.MockedFunction<any>;

  beforeEach(() => {
    mockRequest = {
      user: { id: '000000000000000000000123' },
      query: {},
      params: {},
      body: {}
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('getFigures', () => {
    it('should get figures with default pagination', async () => {
      const mockFigures = [
        { _id: 'fig1', manufacturer: 'GSC', name: 'Miku', userId: '000000000000000000000123' },
        { _id: 'fig2', manufacturer: 'Alter', name: 'Rin', userId: '000000000000000000000123' }
      ];

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockFigures)
      };

      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(2);

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith({ userId: '000000000000000000000123' });
      expect(mockFind.sort).toHaveBeenCalledWith({ mfcActivityOrder: -1 });
      expect(mockFind.collation).toHaveBeenCalledWith({ locale: 'en', strength: 2 });
      expect(mockFind.skip).toHaveBeenCalledWith(0);
      expect(mockFind.limit).toHaveBeenCalledWith(10);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        count: 2,
        page: 1,
        pages: 1,
        total: 2,
        data: mockFigures
      });
    });

    it('should handle pagination parameters', async () => {
      mockRequest.query = { page: '2', limit: '5' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };

      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(15);

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockFind.skip).toHaveBeenCalledWith(5); // (2-1) * 5
      expect(mockFind.limit).toHaveBeenCalledWith(5);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          pages: 3,
          total: 15
        })
      );
    });

    it('should handle server errors', async () => {
      MockedFigure.find = jest.fn().mockImplementation(() => {
        throw new Error('Database error');
      });

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'An unexpected error occurred while fetching figures'
      });
    });
  });

  describe('getFigureById', () => {
    it('should get figure by id successfully', async () => {
      const mockFigureData = {
        _id: 'fig123',
        manufacturer: 'GSC',
        name: 'Miku',
        userId: '000000000000000000000123'
      };
      const mockFigure = {
        ...mockFigureData,
        mfcId: undefined,
        toObject: () => ({ ...mockFigureData }),
      };

      mockRequest.params = { id: 'fig123' };
      MockedFigure.findOne = jest.fn().mockResolvedValue(mockFigure);

      await figureController.getFigureById(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findOne).toHaveBeenCalledWith({
        _id: 'fig123',
        userId: '000000000000000000000123'
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockFigureData
      });
    });

    it('should return 404 if figure not found', async () => {
      mockRequest.params = { id: 'nonexistent' };
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      await figureController.getFigureById(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Figure not found'
      });
    });
  });

  describe('createFigure', () => {
    it('should create figure successfully without scraping', async () => {
      mockRequest.body = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
      };

      const mockCreatedFigure = {
        _id: 'fig123',
        ...mockRequest.body,
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'Good Smile Company',
          name: 'Hatsune Miku',
          scale: '1/8',
          mfcLink: '',
          imageUrl: '',
          userId: '000000000000000000000123'
        })
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockCreatedFigure
      });
    });

    it('should create figure with MFC scraping', async () => {
      mockRequest.body = {
        manufacturer: '',
        name: '',
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      const mockScrapedData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
        imageUrl: 'https://example.com/image.jpg'
      };

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        imageUrl: 'https://example.com/image.jpg',
        userId: '000000000000000000000123'
      };

      // Mock scraper service call
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: mockScrapedData
        }
      });

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://scraper-dev:3090/scrape/mfc',
        { url: 'https://myfigurecollection.net/item/12345' },
        expect.any(Object)
      );
      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'Good Smile Company',
          name: 'Hatsune Miku',
          scale: '1/8',
          mfcLink: '12345', // Normalized to just ID
          mfcId: 12345,     // Extracted from URL
          imageUrl: 'https://example.com/image.jpg',
          userId: '000000000000000000000123'
        })
      );
    });

    it('should handle scraping service failure with fallback', async () => {
      mockRequest.body = {
        manufacturer: '',
        name: '',
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Mock scraper service failure
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service down'));

      // Mock fallback axios call
      mockedAxios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html><div class="item-picture"><div class="main"><img src="https://example.com/image.jpg"></div></div></html>'
      });

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: '',
        name: '',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockedAxios.post).toHaveBeenCalled();
      expect(mockedAxios.get).toHaveBeenCalled();
    });
  });

  describe('updateFigure', () => {
    it('should update figure successfully', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Updated Manufacturer',
        name: 'Updated Name',
        scale: '1/7'
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Old Manufacturer',
        name: 'Old Name',
        userId: '000000000000000000000123',
        mfcLink: ''
      };

      const mockUpdatedFigure = {
        _id: 'fig123',
        manufacturer: 'Updated Manufacturer',
        name: 'Updated Name',
        scale: '1/7',
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue(mockUpdatedFigure);

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findOne).toHaveBeenCalledWith({
        _id: 'fig123',
        userId: '000000000000000000000123'
      });
      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          manufacturer: 'Updated Manufacturer',
          name: 'Updated Name',
          scale: '1/7'
        }),
        { returnDocument: 'after' }
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockUpdatedFigure
      });
    });

    it('should return 404 if figure not found', async () => {
      mockRequest.params = { id: 'nonexistent' };
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Figure not found or you do not have permission'
      });
    });
  });

  describe('deleteFigure', () => {
    it('should delete figure successfully', async () => {
      mockRequest.params = { id: 'fig123' };

      const mockFigure = {
        _id: 'fig123',
        manufacturer: 'GSC',
        name: 'Miku',
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockFigure);
      MockedFigure.deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });

      await figureController.deleteFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findOne).toHaveBeenCalledWith({
        _id: 'fig123',
        userId: '000000000000000000000123'
      });
      expect(MockedFigure.deleteOne).toHaveBeenCalledWith({ _id: 'fig123' });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        message: 'Figure removed successfully'
      });
    });

    it('should return 404 if figure not found', async () => {
      mockRequest.params = { id: 'nonexistent' };
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      await figureController.deleteFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Figure not found or you do not have permission'
      });
    });
  });

  describe('scrapeMFCData', () => {
    beforeEach(() => {
      // Reset all mocks before each test
      jest.clearAllMocks();
    });

    it('should handle scraper service network errors', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate network error for both post and get (fallback)
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Network connection failed'));
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Network connection failed'));

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle invalid data from scraper service', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate incomplete or invalid scraper response
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {}
        }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {}
      });
    });
    it('should scrape MFC data successfully', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      const mockScrapedData = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
        imageUrl: 'https://example.com/image.jpg'
      };

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: mockScrapedData
        }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockScrapedData
      });
    });

    it('should return error for missing MFC link', async () => {
      mockRequest.body = {};

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'MFC link is required'
      });
    });

    it('should return error for invalid URL', async () => {
      mockRequest.body = {
        mfcLink: 'not-a-valid-url'
      };

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid URL format'
      });
    });

    it('should return error for non-MFC URL', async () => {
      mockRequest.body = {
        mfcLink: 'https://example.com/item/12345'
      };

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'URL must be from myfigurecollection.net'
      });
    });
  });

  describe('filterFigures', () => {
    it('should filter figures with multiple criteria', async () => {
      mockRequest.query = {
        manufacturer: 'GSC',
        scale: '1/8',
        page: '1',
        limit: '10'
      };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };

      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(5);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      // Manufacturer filter now uses $and with $or to search both legacy field and companyRoles
      // Scale uses anchored regex for exact matching
      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '000000000000000000000123',
          $and: expect.arrayContaining([
            expect.objectContaining({
              $or: expect.arrayContaining([
                expect.objectContaining({ manufacturer: expect.any(RegExp) }),
                expect.objectContaining({
                  companyRoles: expect.objectContaining({
                    $elemMatch: expect.objectContaining({
                      roleName: 'Manufacturer',
                      companyName: expect.any(RegExp)
                    })
                  })
                })
              ])
            })
          ]),
          scale: expect.objectContaining({ $regex: expect.any(String) }),
        })
      );
    });
  });

  describe('Local MFC Scraping Fallback Scenarios', () => {
    it('should handle local fallback when scraper service fails completely', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate scraper service completely failing
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service completely down'));

      // Mock a failing local axios method
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Local fallback failed'));

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle Cloudflare challenge detection during scraping', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate Cloudflare challenge page
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: {
          data: 'Just a moment... cf-challenge',
          status: 403
        }
      });

      // Ensure fallback is called but fails
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Cloudflare blocked'));

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle manual extraction when all scraping methods fail', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate all scraping methods failing
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Scraper service completely down'));
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Local axios scraping failed'));

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: `MANUAL_EXTRACT:https://myfigurecollection.net/item/12345`,
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });
  });

  describe('Advanced Error Handling Scenarios', () => {
    it('should handle invalid or blocked scraper with manual extraction marker', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate a scenario where scraping completely fails with error details
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: 'Access Denied',
          headers: { 'content-type': 'text/html' }
        }
      });

      // Local fallback also fails
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Local scraping blocked'));

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: `MANUAL_EXTRACT:https://myfigurecollection.net/item/12345`,
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle non-string input during MFC data scraping', async () => {
      mockRequest.body = {
        mfcLink: null // Non-string input
      };

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'MFC link is required'
      });
    });

    it('should handle empty manufacturer name during figure creation', async () => {
      mockRequest.body = {
        manufacturer: '',
        name: 'Test Figure',
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Mock scraping to return data
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            manufacturer: 'Test Manufacturer',
            name: 'Test Figure',
            imageUrl: 'https://example.com/image.jpg'
          }
        }
      });

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'Test Manufacturer',
        name: 'Test Figure',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        imageUrl: 'https://example.com/image.jpg',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(expect.objectContaining({
        manufacturer: 'Test Manufacturer',
        name: 'Test Figure'
      }));
    });

    it('should handle server errors during figure creation', async () => {
      mockRequest.body = {
        manufacturer: 'Test Manufacturer',
        name: 'Test Figure'
      };

      // Simulate database error
      MockedFigure.create = jest.fn().mockRejectedValue(new Error('Database connection failed'));

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Server Error',
        error: 'An unexpected error occurred during figure creation'
      });
    });

    it('should handle complex scraping data merging scenarios', async () => {
      mockRequest.body = {
        manufacturer: 'Partial Manufacturer',
        name: '',
        scale: '',
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Mock scraping to return comprehensive data
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            manufacturer: 'Complete Manufacturer',
            name: 'Complete Name',
            scale: '1/8',
            imageUrl: 'https://example.com/detailed-image.jpg'
          }
        }
      });

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'Complete Manufacturer',
        name: 'Complete Name',
        scale: '1/8',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        imageUrl: 'https://example.com/detailed-image.jpg',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(expect.objectContaining({
        manufacturer: 'Partial Manufacturer',
        name: 'Complete Name',
        scale: '1/8',
        imageUrl: 'https://example.com/detailed-image.jpg'
      }));
    });
  });

  describe('Smart Scraping - needsScrape Conditional', () => {
    it('should skip scraping when all fields are already provided', async () => {
      mockRequest.body = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/8',
        imageUrl: 'https://example.com/image.jpg',
        mfcLink: 'https://myfigurecollection.net/item/12345',
      };

      const mockCreatedFigure = {
        _id: 'fig123',
        ...mockRequest.body,
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      // Scraper should NOT be called when all fields are provided
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'Good Smile Company',
          name: 'Hatsune Miku',
          scale: '1/8',
          mfcLink: '12345', // Normalized to just ID
          mfcId: 12345,     // Extracted from URL
          imageUrl: 'https://example.com/image.jpg',
          userId: '000000000000000000000123'
        })
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
    });

    it('should scrape when any required field is missing', async () => {
      mockRequest.body = {
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '', // Missing scale - should trigger scrape
        imageUrl: 'https://example.com/image.jpg',
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      const mockScrapedData = {
        manufacturer: 'Scraped Manufacturer',
        name: 'Scraped Name',
        scale: '1/7',
        imageUrl: 'https://scraped.com/image.jpg'
      };

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: mockScrapedData
        }
      });

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/7', // Scraped because it was empty
        imageUrl: 'https://example.com/image.jpg',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      // Scraper SHOULD be called when scale is missing
      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should pass mfcAuth to scraper when provided', async () => {
      mockRequest.body = {
        manufacturer: '',
        name: '',
        scale: '',
        mfcLink: 'https://myfigurecollection.net/item/12345',
        mfcAuth: 'PHPSESSID=abc123; sesUID=user456'
      };

      const mockScrapedData = {
        manufacturer: 'Good Smile Company',
        name: 'NSFW Figure',
        scale: '1/6',
        imageUrl: 'https://example.com/nsfw-image.jpg'
      };

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: mockScrapedData
        }
      });

      const mockCreatedFigure = {
        _id: 'fig123',
        ...mockScrapedData,
        mfcLink: 'https://myfigurecollection.net/item/12345',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      // Verify mfcAuth was passed to the scraper
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://scraper-dev:3090/scrape/mfc',
        {
          url: 'https://myfigurecollection.net/item/12345',
          mfcAuth: 'PHPSESSID=abc123; sesUID=user456'
        },
        expect.any(Object)
      );
    });

    it('should skip scrape on update when all fields are provided', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Updated Manufacturer',
        name: 'Updated Name',
        scale: '1/7',
        imageUrl: 'https://example.com/updated-image.jpg',
        mfcLink: 'https://myfigurecollection.net/item/99999' // Different from existing
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Old Manufacturer',
        name: 'Old Name',
        scale: '1/8',
        imageUrl: 'https://example.com/old-image.jpg',
        mfcLink: 'https://myfigurecollection.net/item/12345', // Different from new
        userId: '000000000000000000000123'
      };

      const mockUpdatedFigure = {
        _id: 'fig123',
        ...mockRequest.body,
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue(mockUpdatedFigure);

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      // Scraper should NOT be called when all fields are provided
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('should pass mfcAuth to scraper on update when needed', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Test Manufacturer',
        name: 'Test Name',
        scale: '', // Missing - triggers scrape
        mfcLink: 'https://myfigurecollection.net/item/99999',
        mfcAuth: 'PHPSESSID=xyz789'
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Old Manufacturer',
        name: 'Old Name',
        mfcLink: 'https://myfigurecollection.net/item/12345', // Different
        userId: '000000000000000000000123'
      };

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: { scale: '1/8' }
        }
      });

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockRequest.body,
        scale: '1/8'
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      // Verify mfcAuth was passed
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://scraper-dev:3090/scrape/mfc',
        {
          url: 'https://myfigurecollection.net/item/99999',
          mfcAuth: 'PHPSESSID=xyz789'
        },
        expect.any(Object)
      );
    });

    it('should return NSFW auth error message when scraping requires authentication', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate NSFW auth error from scraper
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: {
          data: {
            message: 'NSFW_AUTH_REQUIRED: This item requires MFC authentication'
          }
        }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      // Should return 500 with the auth error message passed through
      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'NSFW_AUTH_REQUIRED: This item requires MFC authentication',
        error: 'NSFW_AUTH_REQUIRED: This item requires MFC authentication'
      });
    });

    it('should return MFC item not accessible error message', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Simulate item not accessible error
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: {
          data: {
            message: 'MFC_ITEM_NOT_ACCESSIBLE: Item no longer exists'
          }
        }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'MFC_ITEM_NOT_ACCESSIBLE: Item no longer exists',
        error: 'MFC_ITEM_NOT_ACCESSIBLE: Item no longer exists'
      });
    });

    it('should use local fallback and succeed when scraper service fails', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Scraper service fails
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service unavailable'));

      // Local fallback succeeds with HTML response
      const mockHtml = `
        <html>
          <body>
            <div class="item-picture"><div class="main"><img src="https://example.com/image.jpg" /></div></div>
            <span switch>TestManufacturer</span>
            <span switch>TestName</span>
            <div class="item-scale"><a title="Scale">1/8</a></div>
          </body>
        </html>
      `;
      mockedAxios.get = jest.fn().mockResolvedValue({
        status: 200,
        data: mockHtml,
        headers: { 'content-type': 'text/html' }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          imageUrl: 'https://example.com/image.jpg',
          manufacturer: 'TestManufacturer',
          name: 'TestName'
        })
      });
    });

    it('should handle local fallback returning empty response data', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Scraper service fails
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service unavailable'));

      // Local fallback returns empty response
      mockedAxios.get = jest.fn().mockResolvedValue({
        status: 200,
        data: null,
        headers: { 'content-type': 'text/html' }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      // Should return MANUAL_EXTRACT when no data
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should detect Cloudflare challenge in local fallback response', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Scraper service fails
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service unavailable'));

      // Local fallback returns Cloudflare challenge page
      mockedAxios.get = jest.fn().mockResolvedValue({
        status: 200,
        data: '<html><body>Just a moment... cf-challenge</body></html>',
        headers: { 'content-type': 'text/html' }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      // Should return MANUAL_EXTRACT when Cloudflare blocked
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle 403 status in local fallback response', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Scraper service fails
      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Service unavailable'));

      // Local fallback returns 403
      mockedAxios.get = jest.fn().mockResolvedValue({
        status: 403,
        data: '<html><body>Access Denied</body></html>',
        headers: { 'content-type': 'text/html' }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      // Should return MANUAL_EXTRACT when 403
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {
          imageUrl: 'MANUAL_EXTRACT:https://myfigurecollection.net/item/12345',
          manufacturer: '',
          name: '',
          scale: ''
        }
      });
    });

    it('should handle scraper returning empty data object', async () => {
      mockRequest.body = {
        mfcLink: 'https://myfigurecollection.net/item/12345'
      };

      // Scraper returns success but empty data
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: null
        }
      });

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: {}
      });
    });
  });

  describe('SSRF Protection - scrapeDataFromMFCWithAxios', () => {
    it('should reject non-MFC URL in local fallback scraper', async () => {
      mockRequest.body = {
        mfcLink: 'https://evil.example.com/item/12345'
      };

      await figureController.scrapeMFCData(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'URL must be from myfigurecollection.net'
      });
    });
  });

  describe('getFigures - validation branches', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'User not authenticated'
      });
    });

    it('should return 422 for invalid sortBy parameter', async () => {
      mockRequest.query = { sortBy: 'invalid_field' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Validation Error',
          errors: expect.arrayContaining([
            expect.stringContaining('sortBy must be one of')
          ])
        })
      );
    });

    it('should return 422 for invalid sortOrder parameter', async () => {
      mockRequest.query = { sortOrder: 'invalid' };

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errors: expect.arrayContaining([
            'sortOrder must be either asc or desc'
          ])
        })
      );
    });

    it('should return 422 for invalid status parameter', async () => {
      mockRequest.query = { status: 'invalid_status' };

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errors: expect.arrayContaining([
            expect.stringContaining('status must be one of')
          ])
        })
      );
    });

    it('should return 422 when page is beyond available pages', async () => {
      mockRequest.query = { page: '999' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(5); // 5 items, 1 page

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errors: ['Requested page is beyond available pages']
        })
      );
    });

    it('should filter by owned status including legacy null collectionStatus', async () => {
      mockRequest.query = { status: 'owned' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.getFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: [
            { collectionStatus: 'owned' },
            { collectionStatus: { $exists: false } },
            { collectionStatus: null }
          ]
        })
      );
    });
  });

  describe('getFigureById - auth check', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;
      mockRequest.params = { id: 'fig123' };

      await figureController.getFigureById(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should return 500 on server error', async () => {
      mockRequest.params = { id: 'fig123' };
      MockedFigure.findOne = jest.fn().mockRejectedValue(new Error('DB error'));

      await figureController.getFigureById(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe('createFigure - additional branches', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should derive manufacturer from companyRoles when not provided directly', async () => {
      mockRequest.body = {
        name: 'Test Figure',
        companyRoles: [
          { companyName: 'Derived Manufacturer', roleName: 'Manufacturer' }
        ]
      };

      // Mock findOne for duplicate check to return null (no duplicate)
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'Derived Manufacturer',
        name: 'Test Figure',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'Derived Manufacturer'
        })
      );
    });

    it('should derive manufacturer from first companyRole when no Manufacturer role', async () => {
      mockRequest.body = {
        name: 'Test Figure',
        companyRoles: [
          { companyName: 'First Company', roleName: 'Distributor' }
        ]
      };

      // Mock findOne for duplicate check to return null (no duplicate)
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      const mockCreatedFigure = {
        _id: 'fig123',
        manufacturer: 'First Company',
        name: 'Test Figure',
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          manufacturer: 'First Company'
        })
      );
    });

    it('should return 422 for invalid MFC link domain', async () => {
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        mfcLink: 'https://evil.com/item/123'
      };

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining(['Invalid MFC link domain'])
        })
      );
    });

    it('should return 422 for invalid MFC link format', async () => {
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        mfcLink: 'not://valid url format'
      };

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining(['Invalid MFC link format'])
        })
      );
    });

    it('should return 422 for invalid image URL format', async () => {
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        imageUrl: 'not-a-valid-url'
      };

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining(['Invalid image URL format'])
        })
      );
    });

    it('should use releasesArray (Schema v3) when provided', async () => {
      mockRequest.body = {
        manufacturer: 'Test Mfr',
        name: 'Test Figure',
        releases: [
          { date: '2024-01-01', price: 15000, currency: 'JPY', isRerelease: false, jan: '123' },
          { date: '2024-06-01', price: 16000, currency: 'JPY', isRerelease: true }
        ]
      };

      // Mock findOne for duplicate check
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      const mockCreatedFigure = {
        _id: 'fig123',
        ...mockRequest.body,
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          releases: expect.arrayContaining([
            expect.objectContaining({
              price: 15000,
              currency: 'JPY',
              isRerelease: false,
              jan: '123'
            })
          ])
        })
      );
    });

    it('should build releases from legacy flat fields', async () => {
      mockRequest.body = {
        manufacturer: 'Test Mfr',
        name: 'Test Figure',
        releaseDate: '2024-03-15',
        releasePrice: 12000,
        releaseCurrency: 'JPY',
        jan: '4580416940511'
      };

      // Mock findOne for duplicate check
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      const mockCreatedFigure = {
        _id: 'fig123',
        ...mockRequest.body,
        userId: '000000000000000000000123'
      };

      MockedFigure.create = jest.fn().mockResolvedValue(mockCreatedFigure);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          releases: expect.arrayContaining([
            expect.objectContaining({
              price: 12000,
              currency: 'JPY',
              isRerelease: false,
              jan: '4580416940511'
            })
          ])
        })
      );
    });

    it('should handle ValidationError from Mongoose', async () => {
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test'
      };

      // Mock findOne for duplicate check
      MockedFigure.findOne = jest.fn().mockResolvedValue(null);

      const validationError = new Error('Validation failed') as any;
      validationError.name = 'ValidationError';
      validationError.errors = {
        scale: { message: 'Scale format is invalid' }
      };

      MockedFigure.create = jest.fn().mockRejectedValue(validationError);

      await figureController.createFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Validation failed',
          errors: ['Scale format is invalid']
        })
      );
    });
  });

  describe('updateFigure - additional branches', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;
      mockRequest.params = { id: 'fig123' };

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should derive manufacturer from companyRoles on update', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        name: 'Updated Name',
        companyRoles: [
          { companyName: 'Derived Mfr', roleName: 'Manufacturer' }
        ]
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Old Mfr',
        name: 'Old Name',
        mfcLink: '',
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        manufacturer: 'Derived Mfr',
        name: 'Updated Name'
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          manufacturer: 'Derived Mfr'
        }),
        { returnDocument: 'after' }
      );
    });

    it('should keep existing image when no new image URL and no MFC link', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Updated',
        name: 'Updated'
        // No imageUrl, no mfcLink
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Old',
        name: 'Old',
        imageUrl: 'https://existing.com/image.jpg',
        mfcLink: '',
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockRequest.body
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          imageUrl: 'https://existing.com/image.jpg'
        }),
        { returnDocument: 'after' }
      );
    });

    it('should update legacy releases from flat fields when releases exist', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        releaseDate: '2025-01-01',
        releasePrice: 20000
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Test',
        name: 'Test',
        mfcLink: '',
        releases: [{ date: new Date('2024-01-01'), price: 15000, currency: 'JPY' }],
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockRequest.body
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          releases: expect.arrayContaining([
            expect.objectContaining({
              price: 20000
            })
          ])
        }),
        { returnDocument: 'after' }
      );
    });

    it('should add new legacy release when no existing releases', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        releasePrice: 18000,
        releaseCurrency: 'USD'
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Test',
        name: 'Test',
        mfcLink: '',
        releases: [],
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockRequest.body
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          releases: expect.arrayContaining([
            expect.objectContaining({
              price: 18000,
              currency: 'USD',
              isRerelease: false
            })
          ])
        }),
        { returnDocument: 'after' }
      );
    });

    it('should fill in all empty fields from scraped data on update', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        // All fields empty - should be filled by scraper
        manufacturer: '',
        name: '',
        scale: '',
        imageUrl: '',
        mfcLink: 'https://myfigurecollection.net/item/99999' // Different from existing
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Existing Mfr',
        name: 'Existing Name',
        scale: '1/8',
        imageUrl: 'https://existing.com/img.jpg',
        mfcLink: '12345', // Different from new
        userId: '000000000000000000000123'
      };

      const mockScrapedData = {
        manufacturer: 'Scraped Manufacturer',
        name: 'Scraped Name',
        scale: '1/7',
        imageUrl: 'https://scraped.com/image.jpg'
      };

      // Mock scraper service call
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: mockScrapedData
        }
      });

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockScrapedData
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      // Verify all scraped fields were used since all provided fields were empty
      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          imageUrl: 'https://scraped.com/image.jpg',
          manufacturer: 'Scraped Manufacturer',
          name: 'Scraped Name',
          scale: '1/7'
        }),
        { returnDocument: 'after' }
      );
    });

    it('should use releasesArray on update (Schema v3)', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = {
        manufacturer: 'Test',
        name: 'Test',
        releases: [
          { date: '2025-01-01', price: 20000, currency: 'JPY', isRerelease: false, jan: '123' }
        ]
      };

      const mockExistingFigure = {
        _id: 'fig123',
        manufacturer: 'Test',
        name: 'Test',
        mfcLink: '',
        releases: [],
        userId: '000000000000000000000123'
      };

      MockedFigure.findOne = jest.fn().mockResolvedValue(mockExistingFigure);
      MockedFigure.findByIdAndUpdate = jest.fn().mockResolvedValue({
        ...mockExistingFigure,
        ...mockRequest.body
      });

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.findByIdAndUpdate).toHaveBeenCalledWith(
        'fig123',
        expect.objectContaining({
          releases: expect.arrayContaining([
            expect.objectContaining({
              price: 20000,
              currency: 'JPY'
            })
          ])
        }),
        { returnDocument: 'after' }
      );
    });

    it('should return 500 on update server error', async () => {
      mockRequest.params = { id: 'fig123' };
      mockRequest.body = { manufacturer: 'Test', name: 'Test' };
      MockedFigure.findOne = jest.fn().mockRejectedValue(new Error('DB Error'));

      await figureController.updateFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe('deleteFigure - additional branches', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;
      mockRequest.params = { id: 'fig123' };

      await figureController.deleteFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should return 500 on delete server error', async () => {
      mockRequest.params = { id: 'fig123' };
      MockedFigure.findOne = jest.fn().mockRejectedValue(new Error('DB Error'));

      await figureController.deleteFigure(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe('filterFigures - additional branches', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockRequest.user = undefined;

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should filter by status=owned with legacy null handling', async () => {
      mockRequest.query = { status: 'owned' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: [
            { collectionStatus: 'owned' },
            { collectionStatus: { $exists: false } },
            { collectionStatus: null }
          ]
        })
      );
    });

    it('should filter by status=ordered', async () => {
      mockRequest.query = { status: 'ordered' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionStatus: 'ordered'
        })
      );
    });

    it('should handle __unspecified__ scale filter', async () => {
      mockRequest.query = { scale: '__unspecified__' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          scale: { $in: [null, ''] }
        })
      );
    });

    it('should handle mixed __unspecified__ and specified scale values', async () => {
      mockRequest.query = { scale: '__unspecified__|1/7' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          scale: expect.objectContaining({
            $in: expect.arrayContaining([null, ''])
          })
        })
      );
    });

    it('should handle multiple scale values', async () => {
      mockRequest.query = { scale: '1/7|1/8' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          scale: expect.objectContaining({ $in: expect.any(Array) })
        })
      );
    });

    it('should filter by tag (exact match)', async () => {
      mockRequest.query = { tag: 'character:miku' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: 'character:miku'
        })
      );
    });

    it('should filter by tagGroup (prefix match)', async () => {
      mockRequest.query = { tagGroup: 'character' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: { $regex: '^character:', $options: 'i' }
        })
      );
    });

    it('should filter by origin with __unspecified__', async () => {
      mockRequest.query = { origin: '__unspecified__' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: { $in: [null, ''] }
        })
      );
    });

    it('should filter by origin with mixed __unspecified__ and specified values', async () => {
      mockRequest.query = { origin: '__unspecified__|Vocaloid' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: expect.objectContaining({
            $in: expect.arrayContaining([null, ''])
          })
        })
      );
    });

    it('should filter by multiple origin values', async () => {
      mockRequest.query = { origin: 'Vocaloid|Fate' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: expect.objectContaining({ $in: expect.any(Array) })
        })
      );
    });

    it('should filter by category with __unspecified__', async () => {
      mockRequest.query = { category: '__unspecified__' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          category: { $in: [null, ''] }
        })
      );
    });

    it('should filter by category with mixed __unspecified__ and specified', async () => {
      mockRequest.query = { category: '__unspecified__|Scale' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          category: expect.objectContaining({
            $in: expect.arrayContaining([null, ''])
          })
        })
      );
    });

    it('should filter by multiple category values', async () => {
      mockRequest.query = { category: 'Scale|Trading' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          category: expect.objectContaining({ $in: expect.any(Array) })
        })
      );
    });

    it('should return 400 for invalid page parameter in filter', async () => {
      mockRequest.query = { page: '-1' };

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: ['Page must be a positive integer']
        })
      );
    });

    it('should return 400 for invalid limit parameter in filter', async () => {
      mockRequest.query = { limit: '200' };

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: ['Limit must be between 1 and 100']
        })
      );
    });

    it('should return 400 for invalid sortBy in filter', async () => {
      mockRequest.query = { sortBy: 'invalid_field' };

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.stringContaining('sortBy must be one of')]
        })
      );
    });

    it('should return 400 for invalid sortOrder in filter', async () => {
      mockRequest.query = { sortOrder: 'invalid' };

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: ['sortOrder must be either asc or desc']
        })
      );
    });

    it('should return 400 when page exceeds total pages in filter', async () => {
      mockRequest.query = { page: '999' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(5);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [expect.stringContaining('beyond the total')]
        })
      );
    });

    it('should return 500 on filter server error', async () => {
      MockedFigure.countDocuments = jest.fn().mockRejectedValue(new Error('DB Error'));

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });

    it('should filter by distributor', async () => {
      mockRequest.query = { distributor: 'AmiAmi' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            expect.objectContaining({
              companyRoles: expect.objectContaining({
                $elemMatch: expect.objectContaining({
                  roleName: 'Distributor',
                  companyName: expect.any(RegExp)
                })
              })
            })
          ])
        })
      );
    });

    it('should filter with multiple manufacturers', async () => {
      mockRequest.query = { manufacturer: 'GSC|Alter' };

      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        collation: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };
      MockedFigure.find = jest.fn().mockReturnValue(mockFind);
      MockedFigure.countDocuments = jest.fn().mockResolvedValue(0);

      await figureController.filterFigures(mockRequest as Request, mockResponse as Response);

      // Verify $and with $or for manufacturer search
      expect(MockedFigure.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            expect.objectContaining({
              $or: expect.arrayContaining([
                expect.objectContaining({ manufacturer: expect.objectContaining({ $in: expect.any(Array) }) }),
                expect.objectContaining({
                  companyRoles: expect.objectContaining({
                    $elemMatch: expect.objectContaining({
                      roleName: 'Manufacturer',
                      companyName: expect.objectContaining({ $in: expect.any(Array) })
                    })
                  })
                })
              ])
            })
          ])
        })
      );
    });
  });

});