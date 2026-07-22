#!/usr/bin/env bun
/**
 * Normalize straight apostrophes (U+0027) to the French typographic apostrophe
 * (U+2019) in French locale JSON.
 *
 * French elision (l-analyse, d-Archifiltre, qu-un) is typographically U+2019, not the
 * ASCII U+0027. This rewrites those in the French translation file.
 *
 * JSON-ONLY by design: in a locale JSON every apostrophe sits inside a double-quoted
 * string value (keys are ASCII identifiers, structure uses double quotes), so a blanket
 * replace is safe and the result is validated as JSON. Do NOT point this at
 * .ts/.js/.svelte — a blanket replace there would corrupt single-quoted delimiters.
 *
 * Usage:  bun scripts/normalize-french-apostrophes.ts [file.json ...]
 *         (defaults to the French UI locale)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const STRAIGHT = String.fromCodePoint(0x27); // straight apostrophe U+0027
const CURLY = String.fromCodePoint(0x2019); // French apostrophe U+2019

const args = process.argv.slice(2);
const targets = args.length ? args : ['ui/src/lib/i18n/locales/fr.json'];

let total = 0;
for (const f of targets) {
  if (!f.endsWith('.json')) {
    console.error(`  SKIP ${f}: not a .json file (unsafe — would break JS/TS string delimiters)`);
    continue;
  }
  const before = readFileSync(f, 'utf8');
  const n = before.split(STRAIGHT).length - 1;
  if (n === 0) {
    console.log(`  ${f}: no straight apostrophes`);
    continue;
  }
  const after = before.replaceAll(STRAIGHT, CURLY);
  JSON.parse(after); // fail loudly if the replace somehow broke the JSON
  writeFileSync(f, after);
  console.log(`  ${f}: ${n} apostrophes normalized to U+2019`);
  total += n;
}
console.log(`  total replaced: ${total}`);
