import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@wireroom/cli scaffold', () => {
  it('exports its package name', () => {
    expect(packageName()).toBe('@wireroom/cli');
  });
});
