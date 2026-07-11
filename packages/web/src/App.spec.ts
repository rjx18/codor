import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('@codor/web App', () => {
  it('is import-safe outside a browser and exports the component', () => {
    expect(typeof App).toBe('function');
  });
});
