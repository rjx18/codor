import { GrokAdapter } from './adapter.js';

export { GrokAdapter, grokArgs, grokApprovalArgs } from './adapter.js';
export { createTurnTranslator } from './translate.js';
export type { TurnTranslator } from './translate.js';

/** Factory for the `--adapter grok=<module>` external-registration path. */
export function createAdapter(_config: { id: string }): GrokAdapter {
  return new GrokAdapter();
}
