import assert from 'node:assert/strict';
import { access, lstat, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { darkFirstAppearanceScript } from '../.vitepress/theme/appearance.mjs';

function appearance(initial) {
  let value = initial;
  const writes = [];
  runInNewContext(darkFirstAppearanceScript, {
    localStorage: {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
        writes.push(next);
      },
    },
  });
  return { value, writes };
}

assert.deepEqual(appearance(null), {
  value: 'dark',
  writes: ['dark'],
});
assert.deepEqual(appearance('auto'), {
  value: 'auto',
  writes: [],
});
assert.deepEqual(appearance('light'), {
  value: 'light',
  writes: [],
});

const selfHost = await readFile(
  new URL('../.vitepress/dist/docs/SELF-HOST.html', import.meta.url),
  'utf8',
);
assert.match(selfHost, /docs\/PRIVACY\.md/);
assert.match(selfHost, /Bridged channels: the one deliberate exception/);
assert.ok(!selfHost.includes(['github.com/', 'wire', 'room/', 'wire', 'room'].join('')));

// harn:assume website-doc-mirrors-are-portable-includes ref=portable-doc-mirror-regression
const mirroredDocs = [
  'ADAPTERS', 'ARCHITECTURE', 'BUSINESS', 'JOIN', 'PRIVACY', 'PROTOCOL',
  'ROADMAP', 'ROLES', 'SELF-HOST', 'SETUP', 'VISION',
];
for (const name of mirroredDocs) {
  const mirror = new URL(`../docs/${name}.md`, import.meta.url);
  const canonical = new URL(`../../docs/${name}.md`, import.meta.url);
  assert.equal((await lstat(mirror)).isFile(), true, `${name}.md mirror must be a regular file`);
  assert.equal(
    await readFile(mirror, 'utf8'),
    `<!--@include: ../../docs/${name}.md-->\n`,
    `${name}.md mirror must contain exactly one canonical include`,
  );
  await access(canonical);
}
// harn:end website-doc-mirrors-are-portable-includes

const userUnit = await readFile(
  new URL('../../packaging/systemd/codor.service', import.meta.url),
  'utf8',
);
assert.doesNotMatch(userUnit, /network-online\.target/);

// harn:assume brand-asset-references-resolve ref=website-brand-asset-verification
// Every brand path the docs site declares must exist in its BUILT output, not just
// in config. web-next shipped a favicon pointing at a filename that was not there
// and nothing failed; this surface had no equivalent check at all until now.
//
// Read from the rendered HTML rather than from config.ts: it covers the nav logo
// pair that VitePress renders itself, and it catches a reference that survives
// config but not the build - which is the failure mode that matters.
const dist = new URL('../.vitepress/dist/', import.meta.url);
const home = await readFile(new URL('index.html', dist), 'utf8');
const SITE = 'https://codor.app';

const declared = new Set();
for (const match of home.matchAll(/(?:href|content|src)="([^"]+\.(?:svg|png|ico|woff2))"/g)) {
  const value = match[1];
  // Social tags are absolute by Open Graph's requirement; map ours back to a path.
  if (value.startsWith(`${SITE}/`)) declared.add(value.slice(SITE.length));
  else if (value.startsWith('/')) declared.add(value);
}

// favicon, apple-touch, both nav logos, the social image and the product shot.
assert.ok(declared.size >= 6, `expected the docs site to declare brand assets, found ${declared.size}`);
for (const required of ['/codor-favicon.svg', '/codor-apple-touch-180.png',
  '/codor-mark-light.svg', '/codor-mark-dark.svg', '/codor-og.png']) {
  assert.ok(declared.has(required), `the docs site no longer references ${required}`);
}

const missing = [];
for (const path of [...declared].sort()) {
  try {
    await access(new URL(`.${path}`, dist));
  } catch {
    missing.push(path);
  }
}
assert.deepEqual(missing, [], `brand assets referenced but absent from the build: ${missing.join(', ')}`);

// Open Graph requires og:url and absolute image URLs, or the card silently
// degrades to no image at all.
assert.match(home, /property="og:url" content="https:\/\//);
assert.match(home, /property="og:image" content="https:\/\/[^"]+\/codor-og\.png"/);

// The vendored font must ship with its licence; SIL OFL requires it to travel along.
await access(new URL('./fonts/BitcountPropSingle-latin.woff2', dist));
assert.match(await readFile(new URL('./fonts/OFL.txt', dist), 'utf8'), /SIL Open Font License/);

// A privacy-claiming surface must not fetch its own name from a font CDN.
assert.doesNotMatch(home, /fonts\.(googleapis|gstatic)\.com/);
// harn:end brand-asset-references-resolve

process.stdout.write(
  `website verification passed: appearance, links, user unit, and ${declared.size} brand assets\n`,
);
