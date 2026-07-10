export function createAdapter({ id }) {
  let nextSession = 0;

  return {
    id,
    capabilities: {
      resume: true,
      discover: false,
      interactiveAttach: false,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
    },
    spawn(options) {
      return { harness: id, cwd: options.cwd, model: options.model, policy: options.policy };
    },
    attach(sessionRef) {
      return { harness: id, session_ref: sessionRef, cwd: process.cwd() };
    },
    async *deliver(session, payload, hooks = {}) {
      hooks.onStarted?.({});
      if (session.session_ref === undefined) {
        session.session_ref = `third-party-session-${String(++nextSession)}`;
        hooks.onSessionRef?.(session.session_ref);
      }
      yield {
        type: 'run.completed',
        status: 'completed',
        final_text: payload.includes('adapter boundary')
          ? '@richard third-party adapter completed the boundary turn'
          : '@richard third-party adapter completed',
        usage: { input_tokens: 7, output_tokens: 5 },
      };
    },
    async respondInteraction() {
      throw new Error('third-party fixture does not support interactions');
    },
    interrupt() {},
    discoverSessions() {
      return [];
    },
  };
}
