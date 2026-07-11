import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('@codor/protocol barrel', () => {
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
      'CreateRoomRequestSchema',
      'deriveRoomId',
      'PolicySchema',
      'ThinkingLevelSchema',
      'ToolCallPayloadSchema',
      'ToolResultPayloadSchema',
      'TextDeltaPayloadSchema',
      'ReasoningSummaryPayloadSchema',
      'FileChangePayloadSchema',
      'CommitPayloadSchema',
      'parseRunItemPayload',
      'WireEventSchema',
      'ClientFrameSchema',
      'ServerFrameSchema',
    ] as const) {
      expect(protocol[name], name).toBeDefined();
    }
  });

  it('keeps extension handles as plain text while resolving ordinary agents', () => {
    const agent = protocol.MemberSchema.parse({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      kind: 'agent',
      handle: 'claude',
      display_name: 'Claude',
    });
    const extension = protocol.MemberSchema.parse({
      id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      kind: 'extension',
      handle: 'claude-ext-a4fdb5',
      display_name: 'Review cache',
      parent: agent.id,
    });
    const parsed = protocol.parseBody('@claude inspect @claude-ext-a4fdb5', [agent, extension]);
    expect(parsed.mentions).toEqual([
      expect.objectContaining({ member_id: agent.id }),
    ]);
    expect(parsed.unresolved).toEqual([]);
  });
});

// harn:assume workspace-packages-use-codor-scope ref=codor-package-scope-regression
it('uses the codor scope for every scoped workspace package', () => {
  const manifests = [
    'packages/adapters/claude-code/package.json',
    'packages/adapters/codex/package.json',
    'packages/adapters/copilot/package.json',
    'packages/adapters/gemini/package.json',
    'packages/adapters/opencode/package.json',
    'packages/bridges/core/package.json',
    'packages/bridges/slack/package.json',
    'packages/bridges/telegram/package.json',
    'packages/cli/package.json',
    'packages/protocol/package.json',
    'packages/switchboard/package.json',
    'packages/web/package.json',
    'relay/package.json',
    'website/package.json',
  ];
  for (const manifest of manifests) {
    const parsed = JSON.parse(
      readFileSync(new URL(`../../../${manifest}`, import.meta.url), 'utf8'),
    ) as { name: string };
    expect(parsed.name, manifest).toMatch(/^@codor\//);
  }
});
// harn:end workspace-packages-use-codor-scope

// harn:assume release-gate-runs-unit-and-browser ref=root-release-test-script
it('keeps the fast test loop separate from the full browser release gate', () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  expect(rootPackage.scripts.test).toBe('pnpm -r test');
  expect(rootPackage.scripts['test:all']).toBe(
    'pnpm -r build && pnpm -r test && pnpm --filter @codor/web e2e',
  );
});
// harn:end release-gate-runs-unit-and-browser
