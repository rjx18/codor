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
