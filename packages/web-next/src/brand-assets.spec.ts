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
  for (const [, path] of source.matchAll(/["'](\/[\w.-]+\.(?:svg|png|ico|webmanifest))["']/g)) {
    paths.add(path);
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

  it('leaves no unreferenced legacy brand asset behind', () => {
    const stale = readdirSync(publicDir).filter((f) => f === 'codor-icon.svg' || f === 'codor.svg');
    expect(stale).toEqual([]);
  });
});
