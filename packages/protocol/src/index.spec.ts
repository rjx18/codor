import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('@wireroom/protocol barrel', () => {
  it('exports every schema surface consumers build on', () => {
    for (const name of [
      'MemberSchema',
      'HandleSchema',
      'AssignableHandleSchema',
      'MessageSchema',
      'MentionSpanSchema',
      'parseBody',
      'AskCardSchema',
      'RunSummarySchema',
      'PendingInteractionSchema',
      'DeliverySchema',
      'ChangeLogEntrySchema',
      'RoomSchema',
      'RoomConfigSchema',
      'RoomMeterSchema',
      'WireEventSchema',
      'ClientFrameSchema',
      'ServerFrameSchema',
    ] as const) {
      expect(protocol[name], name).toBeDefined();
    }
  });
});

// harn:assume release-gate-runs-unit-and-browser ref=root-release-test-script
it('keeps the fast test loop separate from the full browser release gate', () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  expect(rootPackage.scripts.test).toBe('pnpm -r test');
  expect(rootPackage.scripts['test:all']).toBe(
    'pnpm -r build && pnpm -r test && pnpm --filter @wireroom/web e2e',
  );
});
// harn:end release-gate-runs-unit-and-browser
