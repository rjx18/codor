import { defineWorkspace } from 'vitest/config';

// harn:assume monorepo-workspace-layout ref=vitest-projects
// Mirrors pnpm-workspace.yaml. 'packages/!(adapters)' skips the bare
// packages/adapters directory: it has no package.json (pnpm skips it,
// vitest would treat it as a project and double-run the adapter specs).
export default defineWorkspace([
  'packages/!(adapters)',
  'packages/adapters/*',
  'relay',
]);
// harn:end monorepo-workspace-layout
