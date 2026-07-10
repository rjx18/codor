export { ClaudeCodeAdapter, composeControlResponse } from './adapter.js';
export {
  cardFromControlRequest,
  createTurnTranslator,
  wireEventFromHook,
} from './translate.js';
export type { ClaudeTurnTranslator, ControlRequest, HookPayload } from './translate.js';
