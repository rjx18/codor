import { defineWorkspace } from 'vitest/config';

// harn:assume workspace-gates-cover-all-buildable-projects ref=vitest-projects
// VitePress has a package-level static build test; this list covers projects
// that own Vitest specs and excludes bare grouping directories.
export default defineWorkspace([
  'packages/!(adapters|bridges)',
  'packages/adapters/*',
  'packages/bridges/*',
  'relay',
]);
// harn:end workspace-gates-cover-all-buildable-projects
