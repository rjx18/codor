import { defineWorkspace } from 'vitest/config';

// harn:assume workspace-gates-cover-all-buildable-projects ref=vitest-projects
// VitePress has a package-level static build test; this list covers projects
// that own Vitest specs and excludes bare grouping directories. relay-worker
// carries its own @cloudflare/vitest-pool-workers config, so it is loaded here
// as a Workers-pool project.
export default defineWorkspace([
  'packages/!(adapters|bridges)',
  'packages/adapters/*',
  'packages/bridges/*',
  'relay',
  'relay-worker',
]);
// harn:end workspace-gates-cover-all-buildable-projects
