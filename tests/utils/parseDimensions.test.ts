/**
 * Unit tests for parseDimensionsString utility.
 *
 * Tests parsing of dimension strings from the scraper into IDimensions objects.
 * The scraper sends dimensions as a raw string (e.g., "1/6, H=260mm"),
 * which must be parsed into { heightMm, scaledHeight } for the Figure model.
 */
import { parseDimensionsString } from '../../src/utils/parseDimensions';

describe('parseDimensionsString', () => {
  it('should parse "1/6, H=260mm" into heightMm and scaledHeight', () => {
    const result = parseDimensionsString('1/6, H=260mm');
    expect(result).toEqual({ heightMm: 260, scaledHeight: '1/6' });
  });

  it('should parse "H=260mm" into heightMm only', () => {
    const result = parseDimensionsString('H=260mm');
    expect(result).toEqual({ heightMm: 260 });
  });

  it('should parse "1/7" into scaledHeight only', () => {
    const result = parseDimensionsString('1/7');
    expect(result).toEqual({ scaledHeight: '1/7' });
  });

  it('should return null for undefined input', () => {
    const result = parseDimensionsString(undefined as unknown as string);
    expect(result).toBeNull();
  });

  it('should return null for empty string', () => {
    const result = parseDimensionsString('');
    expect(result).toBeNull();
  });

  it('should parse height without "mm" suffix (e.g., "H=260")', () => {
    const result = parseDimensionsString('H=260');
    expect(result).toEqual({ heightMm: 260 });
  });

  it('should parse "1/8, H=200mm" correctly', () => {
    const result = parseDimensionsString('1/8, H=200mm');
    expect(result).toEqual({ heightMm: 200, scaledHeight: '1/8' });
  });

  it('should parse scale with spaces (e.g., "1/6 , H=260mm")', () => {
    const result = parseDimensionsString('1/6 , H=260mm');
    expect(result).toEqual({ heightMm: 260, scaledHeight: '1/6' });
  });

  it('should handle whitespace-only string', () => {
    const result = parseDimensionsString('   ');
    expect(result).toBeNull();
  });

  it('should return null for unrecognized format', () => {
    const result = parseDimensionsString('unknown format');
    expect(result).toBeNull();
  });

  it('should parse decimal heights (e.g., "H=260.5mm")', () => {
    const result = parseDimensionsString('H=260.5mm');
    expect(result).toEqual({ heightMm: 260.5 });
  });

  // ==========================================================================
  // Multi-dimension parsing (W=/L=/D=) with high fault tolerance.
  // MFC is wildly inconsistent: labels reorder, repeat, go missing, and appear
  // alongside unknown labels. The parser must extract whatever IS present and
  // never fabricate a missing dimension.
  // Mapping: W -> widthMm, L (Length) -> depthMm, D (Depth) -> depthMm.
  // ==========================================================================
  describe('multi-dimension (W/L/D) parsing', () => {
    it('should parse full W/L/H with scale (Mahina) into width/depth/height', () => {
      const result = parseDimensionsString('1/6, W=250mm, L=210mm, H=470mm');
      expect(result).toEqual({ widthMm: 250, depthMm: 210, heightMm: 470, scaledHeight: '1/6' });
    });

    it('should map an explicit Depth (D=) label to depthMm', () => {
      const result = parseDimensionsString('W=195mm, H=242mm, D=90mm');
      expect(result).toEqual({ widthMm: 195, heightMm: 242, depthMm: 90 });
    });

    it('should populate only found fields when height is absent (never fabricate)', () => {
      const result = parseDimensionsString('W=100mm, L=80mm');
      expect(result).toEqual({ widthMm: 100, depthMm: 80 });
      expect(result?.heightMm).toBeUndefined();
    });

    it('should tolerate reordered labels', () => {
      const result = parseDimensionsString('H=470mm, W=250mm, L=210mm');
      expect(result).toEqual({ widthMm: 250, depthMm: 210, heightMm: 470 });
    });

    it('should tolerate duplicate labels by taking the first occurrence', () => {
      const result = parseDimensionsString('H=200mm, H=300mm');
      expect(result).toEqual({ heightMm: 200 });
    });

    it('should take the first of a Length/Depth collision (both map to depthMm)', () => {
      const result = parseDimensionsString('L=210mm, D=90mm');
      expect(result).toEqual({ depthMm: 210 });
    });

    it('should skip unknown labels but keep recognized ones', () => {
      const result = parseDimensionsString('X=999mm, H=300mm');
      expect(result).toEqual({ heightMm: 300 });
    });

    it('should accept full-word labels (Width/Height)', () => {
      const result = parseDimensionsString('Width=100mm, Height=200mm');
      expect(result).toEqual({ widthMm: 100, heightMm: 200 });
    });

    it('should convert centimeters to millimeters for any dimension', () => {
      const result = parseDimensionsString('W=26cm, H=47cm');
      expect(result).toEqual({ widthMm: 260, heightMm: 470 });
    });

    it('should convert inches to millimeters', () => {
      const result = parseDimensionsString('H=10in');
      expect(result).toEqual({ heightMm: 254 });
    });

    it('should keep fractional millimeters when converting inches', () => {
      const result = parseDimensionsString('H=9.5in');
      expect(result).toEqual({ heightMm: 241.3 });
    });

    it('should return null when nothing parseable is present', () => {
      const result = parseDimensionsString('W=, L=, H=');
      expect(result).toBeNull();
    });
  });
});
