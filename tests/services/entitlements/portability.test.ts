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

/**
 * Every module specifier in a source file, in EVERY form the language offers.
 *
 * The forms matter more than they look. A guard that only understands
 * `from '...'` is satisfied by `import '../../config/database'` and by
 * `() => import('../../utils/logger')` — both real coupling, both invisible,
 * and neither caught by the forbidden-symbol pass if the module has a neutral
 * name. A partial guard is worse than none, because it is believed.
 */
export const specifiersIn = (source: string): string[] => [
  // import x from 'm' / import {a} from 'm' / import * as m from 'm' / export {a} from 'm'
  ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
  // import 'm'  — side-effect only, no bindings, no `from`
  ...[...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
  // import('m') — dynamic, deferred, and just as much a dependency
  ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
  // require('m')
  ...[...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
];

const moduleFiles = fs
  .readdirSync(MODULE_DIR)
  .filter(name => name.endsWith('.ts'))
  .map(name => path.join(MODULE_DIR, name));

describe('the specifier extractor sees every import form', () => {
  // Tested on SOURCE STRINGS rather than on the real files, because the whole
  // point is the forms the real files do not currently contain.
  it.each([
    ['static default', "import mongoose from 'mongoose';", 'mongoose'],
    ['static named', "import { Types } from 'mongoose';", 'mongoose'],
    ['namespace', "import * as m from 'mongoose';", 'mongoose'],
    ['re-export', "export { grantsForSubject } from './grants';", './grants'],
    ['bare side-effect', "import '../../config/database';", '../../config/database'],
    ['dynamic', "const later = () => import('../../utils/logger');", '../../utils/logger'],
    ['dynamic, awaited', "const l = await import('../../utils/logger');", '../../utils/logger'],
    ['require', "const m = require('mongoose');", 'mongoose'],
  ])('catches a %s import', (_label, source, expected) => {
    expect(specifiersIn(source)).toContain(expected);
  });
});

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
