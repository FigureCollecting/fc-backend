/**
 * applyScrapedData - unified Stage-B DB-write logic for MFC scraped item data.
 *
 * Extracted from the webhook /sync/webhook/item-complete handler so that the
 * live-scrape webhook and a future reprocess path (re-running the parser
 * against a previously-saved page) both call ONE function to write scraped
 * data to the database. This prevents the two paths from silently diverging.
 *
 * Effects performed here (all preserved from the original webhook logic):
 *  - Figure upsert (per-user record), unless orphaned or no userId is given
 *  - Shared MFCItem catalog upsert - runs for ALL items regardless of userId
 *  - Fire-and-forget search-index sync for the upserted Figure (non-blocking)
 */
import mongoose from 'mongoose';
import { Figure, MFCItem, Company, Artist, RoleType } from '../models';
import { IFigure } from '../models/Figure';
import { upsertFigureSearchIndex } from './searchIndexService';
import { parseDimensionsString } from '../utils/parseDimensions';

// Interface for scraped company/artist data from scraper
interface IScrapedCompany {
  name: string;
  role: string;
  mfcId?: number;
}

interface IScrapedArtist {
  name: string;
  role: string;
  mfcId?: number;
}

/**
 * Process scraped companies and return companyRoles array for Figure
 *
 * Note: Company model has subType (role) as part of its identity.
 * Same company name with different roles creates separate Company records.
 */
async function processScrapedCompanies(
  companies: IScrapedCompany[]
): Promise<{ companyRoles: any[]; manufacturer?: string }> {
  const companyRoles: any[] = [];
  let manufacturer: string | undefined;

  for (const company of companies) {
    // Look up RoleType first - it's required for Company creation
    const roleType = await RoleType.findOne({ name: company.role, kind: 'company' });

    let companyDoc;
    if (roleType) {
      // Upsert Company by name + subType (role)
      // Company model uses {name, category, subType} as unique key
      companyDoc = await Company.findOneAndUpdate(
        { name: company.name, category: 'company', subType: roleType._id },
        {
          $set: { name: company.name, category: 'company', subType: roleType._id },
          $setOnInsert: { mfcId: company.mfcId }
        },
        { upsert: true, new: true }
      );
    } else {
      // Unknown role type - try to find existing company by name only
      // Don't create new Company without valid subType
      companyDoc = await Company.findOne({ name: company.name });
    }

    // Build companyRole entry
    const companyRole: any = {
      companyName: company.name,
      roleName: company.role
    };
    if (companyDoc) {
      companyRole.companyId = companyDoc._id;
    }
    if (roleType) {
      companyRole.roleId = roleType._id;
    }

    companyRoles.push(companyRole);

    // Set legacy manufacturer from first Manufacturer role
    if (!manufacturer && company.role === 'Manufacturer') {
      manufacturer = company.name;
    }
  }

  return { companyRoles, manufacturer };
}

/**
 * Process scraped artists and return artistRoles array for Figure
 */
async function processScrapedArtists(
  artists: IScrapedArtist[]
): Promise<any[]> {
  const artistRoles: any[] = [];

  for (const artist of artists) {
    // Upsert Artist by name
    const artistDoc = await Artist.findOneAndUpdate(
      { name: artist.name },
      {
        $set: { name: artist.name },
        $setOnInsert: { mfcId: artist.mfcId }
      },
      { upsert: true, new: true }
    );

    // Look up RoleType by name
    const roleType = await RoleType.findOne({ name: artist.role, kind: 'artist' });

    // Build artistRole entry
    const artistRole: any = {
      artistId: artistDoc._id,
      artistName: artist.name,
      roleName: artist.role
    };
    if (roleType) {
      artistRole.roleId = roleType._id;
    }

    artistRoles.push(artistRole);
  }

  return artistRoles;
}

/** Context about the sync-job item that scopes how scraped data gets applied. */
export interface ApplyScrapedDataOptions {
  /** Collection status to assign to the Figure record. Defaults to 'owned'. */
  collectionStatus?: 'owned' | 'wished' | 'ordered';
  /** Activity ordering from the MFC collection page sort, if known. */
  mfcActivityOrder?: number;
  /**
   * Orphan items (from lists, not in the user's collection) only get MFCItem
   * catalog enrichment. They do NOT get a user-specific Figure record.
   */
  isOrphan?: boolean;
}

export interface ApplyScrapedDataResult {
  /** The upserted Figure, or null if it was skipped (orphan item / no userId). */
  figure: IFigure | null;
}

/**
 * Apply scraped MFC item data to the database.
 *
 * Single source of truth for writing scraped MFC data - called by both the
 * live-scrape webhook and (in future) a reprocess path, so the two can never
 * silently diverge.
 *
 * @param mfcId - MFC item id (string, as received from the scraper)
 * @param scrapedData - raw scraped fields for the item
 * @param userId - owning user, if this write should also create/update a
 *   per-user Figure record. Omit for catalog-only enrichment.
 * @param options - sync-job-derived context (collection status, ordering, orphan flag)
 */
export async function applyScrapedData(
  mfcId: string,
  scrapedData: Record<string, unknown>,
  userId?: mongoose.Types.ObjectId | string,
  options: ApplyScrapedDataOptions = {}
): Promise<ApplyScrapedDataResult> {
  const { collectionStatus = 'owned', mfcActivityOrder, isOrphan = false } = options;

  let figure: IFigure | null = null;

  // Orphan items (from lists, not in collection) only get MFCItem catalog enrichment.
  // They do NOT get a user-specific Figure record. Likewise, without a userId
  // there is no user to scope a Figure record to.
  if (userId && !isOrphan) {
    // Map scraped data to Figure schema
    const figureData: Record<string, unknown> = {
      mfcId: parseInt(mfcId, 10),
      mfcLink: `https://myfigurecollection.net/item/${mfcId}`,
      collectionStatus,
    };

    // Activity ordering from MFC collection page sort
    if (mfcActivityOrder !== undefined) {
      figureData.mfcActivityOrder = mfcActivityOrder;
    }
    // Add optional fields from scraped data
    if (scrapedData.name) figureData.name = scrapedData.name;
    if (scrapedData.manufacturer) figureData.manufacturer = scrapedData.manufacturer;
    if (scrapedData.scale) figureData.scale = scrapedData.scale;
    if (scrapedData.imageUrl) figureData.imageUrl = scrapedData.imageUrl;
    if (scrapedData.description) figureData.description = scrapedData.description;
    if (scrapedData.releases) figureData.releases = scrapedData.releases;
    if (scrapedData.jan) figureData.jan = scrapedData.jan;

    // Schema v3: Individual MFC fields
    if (scrapedData.mfcTitle) figureData.mfcTitle = scrapedData.mfcTitle;
    if (scrapedData.origin) figureData.origin = scrapedData.origin;
    if (scrapedData.version) figureData.version = scrapedData.version;
    if (scrapedData.category) figureData.category = scrapedData.category;
    if (scrapedData.classification) figureData.classification = scrapedData.classification;
    if (scrapedData.materials) figureData.materials = scrapedData.materials;
    if (scrapedData.dimensions && typeof scrapedData.dimensions === 'string') {
      const parsed = parseDimensionsString(scrapedData.dimensions as string);
      if (parsed) {
        figureData.dimensions = parsed;
      }
    }
    if (scrapedData.tags && Array.isArray(scrapedData.tags)) {
      figureData.tags = scrapedData.tags;
    }

    // User's personal ratings (only present when logged-in user has the figure)
    if (scrapedData.userScore && typeof scrapedData.userScore === 'number') {
      figureData.rating = scrapedData.userScore;
    }
    if (scrapedData.userWishRating && typeof scrapedData.userWishRating === 'number') {
      figureData.wishRating = scrapedData.userWishRating;
    }

    // Schema v3: Process companies with roles
    if (scrapedData.companies && Array.isArray(scrapedData.companies) && scrapedData.companies.length > 0) {
      const { companyRoles, manufacturer } = await processScrapedCompanies(
        scrapedData.companies as IScrapedCompany[]
      );
      figureData.companyRoles = companyRoles;

      // Set legacy manufacturer from companies if not already set
      if (!figureData.manufacturer && manufacturer) {
        figureData.manufacturer = manufacturer;
      }
      console.log(`[WEBHOOK] Processed ${companyRoles.length} company roles for ${JSON.stringify(mfcId)}`);
    }

    // Schema v3: Process artists with roles
    if (scrapedData.artists && Array.isArray(scrapedData.artists) && scrapedData.artists.length > 0) {
      const artistRoles = await processScrapedArtists(
        scrapedData.artists as IScrapedArtist[]
      );
      figureData.artistRoles = artistRoles;
      console.log(`[WEBHOOK] Processed ${artistRoles.length} artist roles for ${JSON.stringify(mfcId)}`);
    }

    // Upsert: Update if exists for this user+mfcId, otherwise create
    figure = await Figure.findOneAndUpdate(
      { userId, mfcId: parseInt(mfcId, 10) },
      { $set: figureData, $setOnInsert: { userId } },
      { upsert: true, new: true }
    );

    // Sync search index (fire-and-forget)
    upsertFigureSearchIndex(figure as IFigure).catch(() => {});

    console.log(`[WEBHOOK] Figure ${JSON.stringify(mfcId)} saved/updated: ${figure!._id}`);
  } else if (isOrphan) {
    console.log(`[WEBHOOK] Orphan item ${JSON.stringify(mfcId)} — enriching MFCItem catalog only (no Figure)`);
  }

  // Upsert shared MFCItem catalog entry — runs for ALL items (collection + orphans)
  const catalogData: Record<string, unknown> = {
    mfcId: parseInt(mfcId, 10),
    mfcUrl: `https://myfigurecollection.net/item/${mfcId}`,
  };
  if (scrapedData.name) catalogData.name = scrapedData.name;
  if (scrapedData.scale) catalogData.scale = scrapedData.scale;
  if (scrapedData.imageUrl) catalogData.imageUrls = [scrapedData.imageUrl];
  if (scrapedData.tags) catalogData.tags = scrapedData.tags;
  if (scrapedData.releases) catalogData.releases = scrapedData.releases;
  if (scrapedData.companies) catalogData.companies = scrapedData.companies;
  if (scrapedData.artists) catalogData.artists = scrapedData.artists;
  if (scrapedData.dimensions) catalogData.dimensions = scrapedData.dimensions;
  if (scrapedData.communityStats) catalogData.communityStats = scrapedData.communityStats;
  if (scrapedData.relatedItems) catalogData.relatedItems = scrapedData.relatedItems;
  catalogData.lastScrapedAt = new Date();

  MFCItem.findOneAndUpdate(
    { mfcId: parseInt(mfcId, 10) },
    { $set: catalogData },
    { upsert: true }
  ).catch(() => {});

  return { figure };
}
