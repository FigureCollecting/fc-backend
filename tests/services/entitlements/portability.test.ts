/**
 * THE PORTABILITY GUARD.
 *
 * src/services/entitlements is meant to be a directory copy away from running
 * in the Postgres-only fc-backend. That is a claim about its IMPORTS, and a
 * claim about imports rots the moment someone reaches for a convenience — the
 * app's logger, a config helper, a user lookup "just for the subject". Each of
 * those is one line to write and a rewrite to undo later, so the constraint is
 * asserted mechanically here rather than left in a comment nobody reads.
 *
 * WHAT IS ALLOWED: node builtins, `axios`, `@figurecollecting/ingest-contract`,
 * and files within this directory. Nothing else, and nothing reached by
 * climbing out of the directory with `../`.
 *
 * If a genuinely new dependency belongs in the module, add it to ALLOWED_BARE
 * deliberately — and know that it becomes a dependency of the Postgres-only
 * backend too.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MODULE_DIR = path.resolve(__dirname, '../../../src/services/entitlements');

const ALLOWED_BARE = [
  /^node:/,
  /^axios$/,
  /^@figurecollecting\/ingest-contract(\/|$)/,
];

/** Every `from '...'` and `require('...')` specifier in a source file. */
const specifiersIn = (source: string): string[] => [
  ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
  ...[...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
];

const moduleFiles = fs
  .readdirSync(MODULE_DIR)
  .filter(name => name.endsWith('.ts'))
  .map(name => path.join(MODULE_DIR, name));

describe('src/services/entitlements is self-contained', () => {
  it('contains the module (guards against a rename silently emptying this suite)', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(moduleFiles.map(f => [path.basename(f), f]))('%s imports nothing outside the module', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of specifiersIn(source)) {
      if (spec.startsWith('.')) {
        // A relative import must stay inside this directory.
        const resolved = path.resolve(path.dirname(file), spec);
        expect(resolved.startsWith(MODULE_DIR + path.sep) || resolved === MODULE_DIR).toBe(true);
        continue;
      }
      expect(ALLOWED_BARE.some(re => re.test(spec))).toBe(true);
    }
  });

  it.each(moduleFiles.map(f => [path.basename(f), f]))(
    '%s names no database, ORM or app-model symbol in CODE',
    (_name, file) => {
      // Comments are stripped first, deliberately: these files are SUPPOSED to
      // talk about what porting them means, and index.ts names the legacy glue
      // it replaces. A prose mention is documentation; a live reference is the
      // coupling this guard exists to catch.
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const forbidden of [
        /\bmongoose\b/i,
        /\bmongodb\b/i,
        /models\/User/,
        /\bSequelize\b/,
        /\bprisma\b/i,
        /\bTypeORM\b/i,
        /\bknex\b/i,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    }
  );
});
