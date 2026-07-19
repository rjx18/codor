#!/usr/bin/env node
/**
 * Generate every Codor brand raster from the one checked-in vector mark.
 *
 * Dev-only tooling. Nothing here is imported by the app, the CLI or any browser
 * bundle; users never download or run it. Its whole job is to stop the shipped
 * icons drifting away from the source vector, which is exactly what happened to
 * the previous set (hand-committed once in 3b2fcee, never regenerated).
 *
 * Run:   node scripts/build-icons.mjs
 * Check: node scripts/build-icons.mjs --check
 *
 * --check regenerates every output in memory and byte-compares it against what
 * is committed, exiting non-zero on any difference. Without it the sibling
 * assumption ("rasters are generated, not hand-committed") is unenforced: a
 * hand-edited PNG passes every other gate.
 *
 * harn:assume brand-rasters-generated-not-hand-committed ref=icon-generator-single-source
 */
import { Resvg } from '@resvg/resvg-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = resolve(root, 'packages/web-next/public');
const SITE = resolve(root, 'website/public');

/** The single source. Its fill is `currentColor`, so every output states a colour explicitly. */
const MARK = readFileSync(resolve(APP, 'codor-mark.svg'), 'utf8');

/** Stone ink/paper, matching packages/web-next/src/styles/tokens.css. */
const INK = '#1c1917';
const PAPER = '#fafaf9';

/** Recolour the source for a context that cannot resolve `currentColor`. */
const painted = (color) => MARK.replace(/currentColor/g, color);

/**
 * The bare monoline mark measures illegible below 24px, so every small raster is
 * the glyph knocked out of a filled plate: the silhouette survives a tab strip
 * even when the interior detail cannot.
 *
 * `inset` is the glyph's share of the canvas. Android masks a maskable icon to an
 * arbitrary shape and can crop ~20% off each edge, so those get a much smaller
 * glyph and a full-bleed plate rather than a rounded one.
 */
function plated({ size, plate, glyph, inset, radius }) {
  const box = Math.round(size * inset);
  const off = Math.round((size - box) / 2);
  const inner = painted(glyph)
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace('<svg', `<svg x="${off}" y="${off}" width="${box}" height="${box}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" rx="${radius}" fill="${plate}"/>`
    + inner
    + '</svg>';
}

const png = (svg, width) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

// harn:assume generated-brand-assets-match-their-source ref=icon-generator-check-mode
// --check regenerates every output in memory and byte-compares it against what is
// committed. Without it the sibling generated-not-hand-committed assumption has no
// mechanism behind it and a hand-edited PNG passes every gate.
const CHECK = process.argv.includes('--check');
const drift = [];

const write = (path, data) => {
  const rel = path.replace(root + '/', '');
  if (CHECK) {
    const current = existsSync(path) ? readFileSync(path) : undefined;
    if (current === undefined) drift.push(`${rel} — missing`);
    else if (!current.equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      drift.push(`${rel} — differs from a fresh render`);
    }
    return;
  }
  // harn:end generated-brand-assets-match-their-source
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`  ${rel} — ${data.length} bytes`);
};

/* ── favicon ──────────────────────────────────────────────────────────────
   A favicon resolves against no CSS context, so `currentColor` is meaningless
   there and the light/dark switch has to be baked into the file itself. Plated,
   because this is the smallest place the mark is ever drawn. */
function faviconSvg() {
  const glyph = painted('var(--fg)')
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace('<svg', '<svg x="96" y="96" width="320" height="320"');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    '<style>',
    `  :root { --bg: ${INK}; --fg: ${PAPER}; }`,
    `  @media (prefers-color-scheme: dark) { :root { --bg: ${PAPER}; --fg: ${INK}; } }`,
    '</style>',
    '<rect width="512" height="512" rx="112" fill="var(--bg)"/>',
    glyph,
    '</svg>',
  ].join('\n');
}

/* ── social preview ───────────────────────────────────────────────────────
   1200x630 is the size every unfurler crops toward. Mark centred on the ink
   plate, nothing else.

   Deliberately textless. Rendering a wordmark here would resolve against
   whatever fonts happen to be installed on the generating machine, so the PNG
   bytes would differ per machine and break the no-diff-on-rerun guarantee this
   generator exists to provide. The title and description belong in `og:title`
   and `og:description` anyway, where they can be edited and translated without
   regenerating an image. */
function ogSvg() {
  const glyph = painted(PAPER)
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace('<svg', '<svg x="450" y="165" width="300" height="300"');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
    `<rect width="1200" height="630" fill="${INK}"/>`,
    glyph,
    '</svg>',
  ].join('\n');
}

console.log(CHECK
  ? 'Checking committed brand assets against the vector source'
  : 'Generating brand assets from packages/web-next/public/codor-mark.svg\n');

// Shared vector outputs.
const favicon = faviconSvg();
write(resolve(APP, 'codor-favicon.svg'), favicon);
write(resolve(SITE, 'codor-favicon.svg'), favicon);

// The docs-site nav logo is loaded as an external <img>, which cannot inherit
// currentColor, so VitePress gets a baked pair for its own light/dark switch.
write(resolve(SITE, 'codor-mark-light.svg'), painted(INK));
write(resolve(SITE, 'codor-mark-dark.svg'), painted(PAPER));

// PWA + touch rasters.
const app = (size, inset, radius) =>
  plated({ size, plate: INK, glyph: PAPER, inset, radius });

write(resolve(APP, 'codor-192.png'), png(app(512, 0.62, 112), 192));
write(resolve(APP, 'codor-512.png'), png(app(512, 0.62, 112), 512));
// Maskable: full-bleed plate, glyph well inside the safe zone.
write(resolve(APP, 'codor-maskable-512.png'), png(app(512, 0.55, 0), 512));
// Apple applies its own corner mask, so the plate is square here too.
write(resolve(APP, 'codor-apple-touch-180.png'), png(app(512, 0.62, 0), 180));
write(resolve(SITE, 'codor-apple-touch-180.png'), png(app(512, 0.62, 0), 180));

// Social preview.
const og = png(ogSvg(), 1200);
write(resolve(APP, 'codor-og.png'), og);
write(resolve(SITE, 'codor-og.png'), og);

if (CHECK) {
  if (drift.length > 0) {
    console.error('Committed brand assets do not match a fresh render:\n');
    for (const line of drift) console.error(`  ${line}`);
    console.error('\nRun `node scripts/build-icons.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('All committed brand assets match a fresh render.');
} else {
  console.log('\nDone. Re-run should produce no diff.');
}
// harn:end brand-rasters-generated-not-hand-committed
