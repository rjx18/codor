import { describe, expect, it } from 'vitest';

import { Store } from './index.js';

describe('@codor/switchboard barrel', () => {
  it('exports the Store', () => {
    expect(Store).toBeTypeOf('function');
  });
});
