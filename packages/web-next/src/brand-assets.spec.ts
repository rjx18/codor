import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Brand asset integrity.
 *
 * web-next shipped `<link rel="icon" href="/codor.svg">` while the file on disk
 * was `codor-icon.svg`, so the application had no favicon at all and nothing
 * failed to say so. A mistyped or renamed asset path is invisible in review and
 * degrades silently, so the guarantee has to be a check rather than an eye.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');  // src/ -> package root
const publicDir = resolve(pkg, 'public');
const indexHtml = readFileSync(resolve(pkg, 'index.html'), 'utf8');
const viteConfig = readFileSync(resolve(pkg, 'vite.config.ts'), 'utf8');

/** Root-absolute asset paths referenced from a source file. */
function referenced(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/["'](\/[\w.-]+\.(?:svg|png|ico|webmanifest))["']/g)) {
    const path = match[1];
    if (path !== undefined) paths.add(path);
  }
  return [...paths];
}

describe('brand assets', () => {
  it('resolves every asset path referenced by index.html', () => {
    const missing = referenced(indexHtml).filter((p) => !existsSync(resolve(publicDir, p.slice(1))));
    expect(missing).toEqual([]);
  });

  it('resolves every icon path declared in the PWA manifest', () => {
    const missing = referenced(viteConfig).filter((p) => !existsSync(resolve(publicDir, p.slice(1))));
    expect(missing).toEqual([]);
  });

  it('declares a favicon, an apple-touch-icon and a social preview', () => {
    expect(indexHtml).toMatch(/rel="icon"[^>]*codor-favicon\.svg/);
    expect(indexHtml).toMatch(/rel="apple-touch-icon"/);
    expect(indexHtml).toMatch(/property="og:image"/);
  });

  it('gives the maskable icon its own padded asset', () => {
    // Reusing the plain 512 here let Android's mask clip the plate corners.
    expect(viteConfig).toMatch(/codor-maskable-512\.png[^}]*purpose: 'maskable'/);
    expect(viteConfig).not.toMatch(/codor-512\.png[^}]*purpose: 'maskable'/);
  });

  it('keeps one themeable vector source with no baked fill', () => {
    const mark = readFileSync(resolve(publicDir, 'codor-mark.svg'), 'utf8');
    expect(mark).toContain('currentColor');
    expect(mark).not.toMatch(/fill="#[0-9a-fA-F]{3,8}"/);
  });

  it('bakes a colour-scheme switch into the favicon, which has no CSS context', () => {
    const favicon = readFileSync(resolve(publicDir, 'codor-favicon.svg'), 'utf8');
    expect(favicon).toContain('prefers-color-scheme: dark');
    expect(favicon).not.toContain('currentColor');
  });

  it('declares an absolute og:url and og:image, which Open Graph requires', () => {
    // A root-relative /codor-og.png is unresolvable to a scraper, so the card
    // silently degrades to no image at all.
    expect(indexHtml).toMatch(/property="og:url" content="https:\/\//);
    expect(indexHtml).toMatch(/property="og:image" content="https:\/\/[^"]+\/codor-og\.png"/);
    expect(indexHtml).toMatch(/property="og:image:width" content="1200"/);
    expect(indexHtml).toMatch(/property="og:image:alt"/);
  });

  it('self-hosts the wordmark font and ships its licence', () => {
    const tokens = readFileSync(resolve(pkg, 'src/styles/tokens.css'), 'utf8');
    expect(tokens).toContain("font-family: 'Bitcount Prop Single'");
    expect(tokens).toContain('/fonts/BitcountPropSingle-latin.woff2');
    expect(tokens).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(existsSync(resolve(publicDir, 'fonts/BitcountPropSingle-latin.woff2'))).toBe(true);
    // SIL OFL 1.1 requires the licence to travel with the binary.
    expect(readFileSync(resolve(publicDir, 'fonts/OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });

  it('renders the mark large enough to read inside its box', () => {
    // The supplied artwork carried enough internal padding that a 30px box drew a
    // ~17.7px glyph, under the 24px floor. The viewBox is normalised to the ink.
    const mark = readFileSync(resolve(publicDir, 'codor-mark.svg'), 'utf8');
    const box = /viewBox="([\d.\s-]+)"/.exec(mark)?.[1]?.trim().split(/\s+/).map(Number);
    expect(box).toBeDefined();
    expect(box?.[2]).toBeLessThan(700); // normalised, not the exporter's 1024 canvas
  });

  it('keeps every committed asset byte-identical to a fresh generator run', () => {
    // Without this the generated-not-hand-committed assumption is unenforced:
    // a hand-edited PNG passes every other gate here.
    const root = resolve(pkg, '../..');
    expect(() =>
      execFileSync('node', ['scripts/build-icons.mjs', '--check'], { cwd: root, stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('leaves no unreferenced legacy brand asset behind', () => {
    const stale = readdirSync(publicDir).filter((f) => f === 'codor-icon.svg' || f === 'codor.svg');
    expect(stale).toEqual([]);
  });
});
