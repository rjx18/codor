import { CursorAdapter } from './adapter.js';

export { CursorAdapter, cursorArgs } from './adapter.js';
export { createTurnTranslator } from './translate.js';
export type { TurnTranslator } from './translate.js';

/** Factory for the `--adapter cursor=<module>` external-registration path. */
export function createAdapter(_config: { id: string }): CursorAdapter {
  return new CursorAdapter();
}
