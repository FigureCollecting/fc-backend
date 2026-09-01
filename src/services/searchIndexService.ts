import mongoose from 'mongoose';
import SearchIndex from '../models/SearchIndex';
import { IFigure } from '../models/Figure';
import { createLogger } from '../utils/logger';

const logger = createLogger('SEARCH_INDEX');

/**
 * Compose a single space-separated search text from all searchable figure fields.
 * Tags have their group prefix stripped (e.g. "location:room-3" -> "room-3").
 */
export function composeSearchText(figure: IFigure): string {
  const parts: string[] = [];

  if (figure.companyRoles?.length) {
    figure.companyRoles.forEach(cr => { if (cr.companyName) parts.push(cr.companyName); });
  }
  if (figure.manufacturer) parts.push(figure.manufacturer);
  if (figure.artistRoles?.length) {
    figure.artistRoles.forEach(ar => { if (ar.artistName) parts.push(ar.artistName); });
  }

  const fields = ['name', 'mfcTitle', 'origin', 'version', 'category', 'classification', 'scale', 'materials'] as const;
  fields.forEach(f => { if (figure[f]) parts.push(figure[f]!); });

  if (figure.releases?.length) {
    figure.releases.forEach(r => { if (r.jan) parts.push(r.jan); });
  }
  if (figure.tags?.length) {
    figure.tags.forEach(tag => {
      const i = tag.indexOf(':');
      parts.push(i > -1 ? tag.slice(i + 1) : tag);
    });
  }

  return parts.join(' ');
}

/** Compose a lowercased, trimmed version of the figure name for exact-match search. */
export function composeNameSearchable(figure: IFigure): string {
  return (figure.name || '').toLowerCase().trim();
}

/** Build the common $set payload for a figure's SearchIndex document. */
function buildSetPayload(figure: IFigure) {
  return {
    searchText: composeSearchText(figure),
    nameSearchable: composeNameSearchable(figure),
    userId: figure.userId,
    figureName: figure.name,
    scale: figure.scale,
    mfcLink: figure.mfcLink,
    imageUrl: figure.imageUrl,
    origin: figure.origin,
    category: figure.category,
    companyRoles: figure.companyRoles?.map(cr => ({
      companyName: cr.companyName || '', roleName: cr.roleName || ''
    })) || [],
    artistRoles: figure.artistRoles?.map(ar => ({
      artistName: ar.artistName || '', roleName: ar.roleName || ''
    })) || [],
    releaseJans: figure.releases?.map(r => r.jan).filter((j): j is string => !!j) || [],
    releaseDates: figure.releases?.map(r => r.date).filter((d): d is Date => !!d) || [],
    tags: figure.tags || [],
    mfcId: figure.mfcId,
    popularity: 0,
    entityType: 'figure' as const
  };
}

/** Upsert a SearchIndex entry for a figure. Fire-and-forget: never throws. */
export async function upsertFigureSearchIndex(figure: IFigure): Promise<void> {
  try {
    await SearchIndex.findOneAndUpdate(
      { entityType: 'figure', entityId: figure._id },
      { $set: buildSetPayload(figure) },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (error) {
    logger.error('Failed to upsert figure search index:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/** Delete the SearchIndex entry for a given figureId. Fire-and-forget: never throws. */
export async function deleteFigureSearchIndex(figureId: mongoose.Types.ObjectId): Promise<void> {
  try {
    await SearchIndex.deleteOne({ entityType: 'figure', entityId: figureId });
  } catch (error) {
    logger.error('Failed to delete figure search index:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/** Bulk upsert SearchIndex entries for an array of figures. Fire-and-forget: never throws. */
export async function bulkUpsertFigureSearchIndexes(figures: IFigure[]): Promise<void> {
  if (!figures.length) return;

  try {
    const ops = figures.map(figure => ({
      updateOne: {
        filter: { entityType: 'figure' as const, entityId: figure._id },
        update: { $set: buildSetPayload(figure) },
        upsert: true
      }
    }));
    await SearchIndex.bulkWrite(ops);
  } catch (error) {
    logger.error('Failed to bulk upsert figure search indexes:', error instanceof Error ? error.message : 'Unknown error');
  }
}
