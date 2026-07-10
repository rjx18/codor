import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('@wireroom/web scaffold', () => {
  it('exports the App component stub', () => {
    expect(typeof App).toBe('function');
  });
});
