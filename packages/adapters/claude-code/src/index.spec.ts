import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@wireroom/adapter-claude-code scaffold', () => {
  it('exports its package name', () => {
    expect(packageName()).toBe('@wireroom/adapter-claude-code');
  });
});
