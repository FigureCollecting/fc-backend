/**
 * Parses a raw dimensions string from the scraper into an IDimensions object.
 *
 * The scraper sends dimensions as a single string with patterns like:
 *   - "1/6, H=260mm"                   → { heightMm: 260, scaledHeight: "1/6" }
 *   - "1/6, W=250mm, L=210mm, H=470mm" → { widthMm: 250, depthMm: 210, heightMm: 470, scaledHeight: "1/6" }
 *   - "H=260mm"                        → { heightMm: 260 }
 *   - "1/7"                            → { scaledHeight: "1/7" }
 *
 * MFC is deeply inconsistent record-to-record: labels reorder, repeat, go
 * missing, appear with unexpected extras, and use different units. This parser
 * assumes nothing — it extracts whatever labeled measurements are present,
 * tolerates duplicates and unknown labels, and populates only what it finds.
 */
import { IDimensions } from '../models/Figure';

/** Numeric dimension fields on IDimensions (scaledHeight is handled separately). */
type NumericDimensionField = 'widthMm' | 'heightMm' | 'depthMm';

/**
 * Map every known MFC label form to its canonical Figure field. Length and
 * Depth both collapse to depthMm — the estate convention has no lengthMm.
 */
const LABEL_TO_FIELD: Record<string, NumericDimensionField> = {
  w: 'widthMm',
  width: 'widthMm',
  h: 'heightMm',
  height: 'heightMm',
  l: 'depthMm',
  length: 'depthMm',
  d: 'depthMm',
  depth: 'depthMm',
};

/**
 * One labeled measurement: <label> = <number> <optional unit>. The label is
 * length-bounded (longest known label is 6 chars) to keep matching linear.
 */
const DIMENSION_TOKEN = /([a-z]{1,12})\s*=\s*(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|"|″)?/gi;

/** Scale like 1/6, 1/7 (bounded to prevent ReDoS). */
const SCALE_PATTERN = /(\d{1,4}\/\d{1,4})/;

/**
 * Physical sanity ceiling in millimeters. Nothing real is taller than this — a
 * 1/1-scale figure is ~1700mm, so 2500mm leaves ample margin. Any parsed
 * measurement above it is dropped: defense-in-depth so a malformed or
 * concatenated value (e.g. the old 250210470 dimension bug) can never be stored.
 */
const MAX_DIMENSION_MM = 2500;

/**
 * Convert a measurement to millimeters based on its unit label. Unknown or
 * absent units are assumed to already be millimeters (MFC's overwhelming
 * default). Rounds to 2 decimals so unit conversion does not introduce
 * floating-point noise; integers stay integers.
 */
function toMillimeters(value: number, unit: string | undefined): number {
  const u = (unit || '').toLowerCase();
  let mm = value;
  if (u === 'cm') {
    mm = value * 10;
  } else if (u === 'in' || u === 'inch' || u === 'inches' || u === '"' || u === '″') {
    mm = value * 25.4;
  }
  return Math.round(mm * 100) / 100;
}

/**
 * Parse a dimensions string from the scraper into a structured IDimensions object.
 *
 * @param raw - The raw dimensions string from scraped data
 * @returns Parsed IDimensions object, or null if input is empty/undefined or unrecognizable
 */
export function parseDimensionsString(raw: string): IDimensions | null {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const result: IDimensions = {};

  // Extract every labeled measurement. First occurrence of each field wins, so
  // duplicate or conflicting labels (e.g. two heights, or both Length and
  // Depth) degrade gracefully instead of clobbering an earlier value. Unknown
  // labels are skipped rather than guessed.
  for (const match of raw.matchAll(DIMENSION_TOKEN)) {
    const field = LABEL_TO_FIELD[match[1].toLowerCase()];
    if (!field || result[field] !== undefined) {
      continue;
    }
    const mm = toMillimeters(parseFloat(match[2]), match[3]);
    if (mm > MAX_DIMENSION_MM) {
      continue; // physically impossible — drop it rather than store garbage
    }
    result[field] = mm;
  }

  // Extract scale from patterns like 1/6, 1/7, 1/8.
  const scaleMatch = raw.match(SCALE_PATTERN);
  if (scaleMatch) {
    result.scaledHeight = scaleMatch[1];
  }

  // Return null if nothing was parsed.
  if (Object.keys(result).length === 0) {
    return null;
  }

  return result;
}
