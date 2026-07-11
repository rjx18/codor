import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
assert.match(selfHost, /Bridged rooms: the one deliberate exception/);
assert.doesNotMatch(selfHost, /github\.com\/wireroom\/wireroom/);

const userUnit = await readFile(
  new URL('../../packaging/systemd/codor.service', import.meta.url),
  'utf8',
);
assert.doesNotMatch(userUnit, /network-online\.target/);

process.stdout.write('website verification passed: appearance, links, and user unit\n');
