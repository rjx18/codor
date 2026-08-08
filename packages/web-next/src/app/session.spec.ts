// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { pageParams, roomUrl } from './session.js';

// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-url-selector
describe('worktree url selector', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('parses the public root and the optional stable worktree id', () => {
    window.history.replaceState(null, '', '/?room=eng');
    expect(pageParams()).toEqual({ room: 'eng' });

    window.history.replaceState(null, '', '/?room=eng&worktree=01ARZ3NDEKTSV4RRFFQ69G5FAC');
    expect(pageParams()).toEqual({ room: 'eng', worktree: '01ARZ3NDEKTSV4RRFFQ69G5FAC' });

    // An empty selector is the main conversation, not a malformed selection.
    window.history.replaceState(null, '', '/?room=eng&worktree=');
    expect(pageParams()).toEqual({ room: 'eng' });
  });

  it('writes only the public root and stable worktree id into navigation state', () => {
    expect(roomUrl('eng')).toBe('/?room=eng');
    expect(roomUrl('eng', '01ARZ3NDEKTSV4RRFFQ69G5FAC'))
      .toBe('/?room=eng&worktree=01ARZ3NDEKTSV4RRFFQ69G5FAC');
    // A child conversation id or alias never becomes a URL parameter.
    expect(roomUrl('eng', '01ARZ3NDEKTSV4RRFFQ69G5FAC')).not.toContain('wt-');
  });
});
// harn:end registered-worktree-navigation-is-promotion-gated
