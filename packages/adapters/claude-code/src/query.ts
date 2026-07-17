import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

// Keep the production SDK import in this small module. Tests inject the same
// factory shape the real adapter calls, so no test can accidentally start the
// bundled Claude runtime or make a model request.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeOptions;
};
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

// harn:assume claude-agent-sdk-query-is-the-session-runtime ref=claude-sdk-query-factory
export function claudeQuery(
  input: ClaudeQueryInput,
  queryFactory: ClaudeQueryFactory = query,
): Query {
  return queryFactory(input);
}
// harn:end claude-agent-sdk-query-is-the-session-runtime
