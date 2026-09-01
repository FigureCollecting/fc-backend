import { Request, Response } from 'express';
import MfcList from '../models/MfcList';
import MFCItem from '../models/MFCItem';
import Figure from '../models/Figure';

/**
 * GET /lists
 * Get all lists for authenticated user (paginated).
 */
export const getLists = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    const pageParam = req.query.page as string;
    const page = parseInt(pageParam, 10) || 1;
    const limitParam = req.query.limit as string;
    const limit = parseInt(limitParam, 10) || 10;
    const sortBy = (req.query.sortBy as string) || 'name';
    const sortOrder = (req.query.sortOrder as string) === 'asc' ? 1 : -1;
    const privacy = req.query.privacy as string;

    const query: Record<string, any> = { userId };
    if (privacy && ['public', 'friends', 'private'].includes(privacy)) {
      query.privacy = privacy;
    }

    const total = await MfcList.countDocuments(query);
    const pages = Math.ceil(total / limit);
    const skip = (page - 1) * limit;

    const allowedSortFields = ['name', 'mfcCreatedAt', 'createdAt', 'updatedAt', 'itemCount'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const sortOptions: Record<string, 1 | -1> = { [safeSortBy]: sortOrder };

    const lists = await MfcList.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limit);

    return res.status(200).json({
      success: true,
      count: lists.length,
      page,
      pages,
      total,
      data: lists
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: 'An unexpected error occurred while fetching lists'
    });
  }
};

/**
 * GET /lists/:id
 * Get single list by MongoDB _id. Verify ownership.
 */
export const getListById = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const list = await MfcList.findOne({
      _id: req.params.id,
      userId
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: 'List not found'
      });
    }

    // Enrich items: check user's Figures first, then MFCItem catalog, then list's own metadata
    let items: Array<{ mfcId: number; name?: string; imageUrl?: string; scale?: string }> = [];
    if (list.itemMfcIds.length > 0) {
      // 1. User's own figures (most likely source for owned/ordered/wished items)
      const userFigures = await Figure.find(
        { userId, mfcId: { $in: list.itemMfcIds } },
        { mfcId: 1, name: 1, imageUrl: 1, scale: 1 }
      ).lean();
      const figureMap = new Map(userFigures.map(f => [f.mfcId!, f]));

      // 2. MFCItem catalog for items not in user's collection
      const missingMfcIds = list.itemMfcIds.filter(id => !figureMap.has(id));
      let catalogMap = new Map<number, any>();
      if (missingMfcIds.length > 0) {
        const catalogItems = await MFCItem.find(
          { mfcId: { $in: missingMfcIds } },
          { mfcId: 1, name: 1, imageUrls: 1, scale: 1 }
        ).lean();
        catalogMap = new Map(catalogItems.map(i => [i.mfcId, i]));
      }

      // 3. List's own scraped metadata (captured during list sync from MFC pages)
      const detailMap = new Map<number, { name?: string; imageUrl?: string }>();
      if (list.itemDetails && list.itemDetails.length > 0) {
        for (const d of list.itemDetails) {
          detailMap.set(d.mfcId, { name: d.name, imageUrl: d.imageUrl });
        }
      }

      items = list.itemMfcIds.map(mfcId => {
        const fig = figureMap.get(mfcId);
        if (fig) {
          return { mfcId, name: fig.name, imageUrl: fig.imageUrl, scale: fig.scale };
        }
        const cat = catalogMap.get(mfcId);
        if (cat) {
          return { mfcId, name: cat.name, imageUrl: cat.imageUrls?.[0], scale: cat.scale };
        }
        const detail = detailMap.get(mfcId);
        if (detail) {
          return { mfcId, name: detail.name, imageUrl: detail.imageUrl };
        }
        return { mfcId };
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...list.toObject(),
        items,
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * POST /lists
 * Create a new list. Auto-set userId from auth.
 */
export const createList = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    const {
      mfcId, name, teaser, description, privacy,
      iconUrl, allowComments, mailOnSales, mailOnHunts,
      itemMfcIds, mfcCreatedAt, mfcLastEditedAt, lastSyncedAt
    } = req.body;

    const listData: Record<string, any> = {
      mfcId,
      userId,
      name,
      teaser,
      description,
      privacy,
      iconUrl,
      allowComments,
      mailOnSales,
      mailOnHunts,
      itemMfcIds: itemMfcIds || [],
      itemCount: itemMfcIds ? itemMfcIds.length : 0,
      mfcCreatedAt,
      mfcLastEditedAt,
      lastSyncedAt
    };

    const list = await MfcList.create(listData);

    return res.status(201).json({
      success: true,
      data: list
    });
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: Object.values(error.errors).map((err: any) => ({
          message: err.message,
          path: [err.path]
        }))
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * PUT /lists/:id
 * Update a list. Cannot update userId or mfcId. Verify ownership.
 */
export const updateList = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    const list = await MfcList.findOne({
      _id: req.params.id,
      userId
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: 'List not found or you do not have permission'
      });
    }

    const updateData = { ...req.body };
    delete updateData.userId;
    delete updateData.mfcId;

    Object.assign(list, updateData);
    await list.save();

    return res.status(200).json({
      success: true,
      data: list
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * DELETE /lists/:id
 * Delete a list. Verify ownership.
 */
export const deleteList = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;

    const list = await MfcList.findOne({
      _id: req.params.id,
      userId
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: 'List not found or you do not have permission'
      });
    }

    await MfcList.deleteOne({ _id: req.params.id });

    return res.status(200).json({
      success: true,
      message: 'List removed successfully'
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * GET /lists/by-item/:mfcId
 * Find user's lists containing a specific MFC item.
 * Returns lightweight response (name + id only).
 */
export const getListsByItem = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const mfcId = parseInt(req.params.mfcId as string, 10);

    if (isNaN(mfcId)) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: [{ message: 'mfcId must be a number', path: ['mfcId'] }]
      });
    }

    const lists = await MfcList.find(
      { userId, itemMfcIds: mfcId },
      { _id: 1, name: 1 }
    );

    return res.status(200).json({
      success: true,
      data: lists
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * POST /lists/:id/items
 * Add MFC item IDs to a list using $addToSet.
 */
export const addItemsToList = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const { mfcIds } = req.body;

    if (!mfcIds || !Array.isArray(mfcIds)) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: [{ message: 'mfcIds must be an array of numbers', path: ['mfcIds'] }]
      });
    }

    const list = await MfcList.findOne({
      _id: req.params.id,
      userId
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: 'List not found or you do not have permission'
      });
    }

    const updated = await MfcList.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { itemMfcIds: { $each: mfcIds } } },
      { returnDocument: 'after' }
    );

    if (updated) {
      updated.itemCount = updated.itemMfcIds.length;
      await updated.save();
    }

    return res.status(200).json({
      success: true,
      data: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * DELETE /lists/:id/items
 * Remove MFC item IDs from a list using $pull.
 */
export const removeItemsFromList = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const { mfcIds } = req.body;

    if (!mfcIds || !Array.isArray(mfcIds)) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: [{ message: 'mfcIds must be an array of numbers', path: ['mfcIds'] }]
      });
    }

    const list = await MfcList.findOne({
      _id: req.params.id,
      userId
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: 'List not found or you do not have permission'
      });
    }

    const updated = await MfcList.findByIdAndUpdate(
      req.params.id,
      { $pullAll: { itemMfcIds: mfcIds } },
      { returnDocument: 'after' }
    );

    if (updated) {
      updated.itemCount = updated.itemMfcIds.length;
      await updated.save();
    }

    return res.status(200).json({
      success: true,
      data: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};

/**
 * POST /lists/sync
 * Bulk upsert lists from scraper sync data.
 * For each list, upsert by userId + mfcId.
 */
export const syncLists = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    const userId = req.user.id;
    const { lists } = req.body;

    if (!lists || !Array.isArray(lists)) {
      return res.status(422).json({
        success: false,
        message: 'Validation Error',
        errors: [{ message: 'lists must be an array', path: ['lists'] }]
      });
    }

    let upsertCount = 0;

    for (const listData of lists) {
      const { mfcId, ...rest } = listData;

      await MfcList.findOneAndUpdate(
        { userId, mfcId },
        {
          $set: {
            ...rest,
            userId,
            mfcId,
            itemCount: rest.itemMfcIds ? rest.itemMfcIds.length : 0,
            lastSyncedAt: new Date()
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      upsertCount++;
    }

    return res.status(200).json({
      success: true,
      data: { upserted: upsertCount }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
};
