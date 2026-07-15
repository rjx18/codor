// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-responsive-adoption
// The live adoption of the pure presentation model. The eight adopted room surfaces resolve
// their frame from the current viewport width, re-resolving when the width crosses the 720
// content breakpoint. Width is read through useSyncExternalStore over a module-level subscriber
// store: however many surfaces are mounted, they share ONE native resize listener, attached when
// the first subscribes and removed after the last unsubscribes - so N surfaces never attach N
// listeners and there is nothing to leak.
import { useSyncExternalStore } from 'react';

import { resolvePresentation, type PresentationMode, type Surface } from './v5/presentation.js';

// The single native listener and the set of React store callbacks it fans out to.
const subscribers = new Set<() => void>();
let nativeListenerAttached = false;

function handleResize(): void {
  for (const notify of [...subscribers]) notify();
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  if (!nativeListenerAttached) {
    window.addEventListener('resize', handleResize);
    nativeListenerAttached = true;
  }
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0 && nativeListenerAttached) {
      window.removeEventListener('resize', handleResize);
      nativeListenerAttached = false;
    }
  };
}

function getWidthSnapshot(): number {
  return window.innerWidth;
}

// A stable desktop default for any non-DOM render; adopted surfaces then resolve framed-desktop.
function getServerWidthSnapshot(): number {
  return 1440;
}

/** The live viewport width, tracked after mount with a listener removed on unmount. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, getWidthSnapshot, getServerWidthSnapshot);
}

/**
 * Resolve a surface's live presentation mode. The eight adopted surfaces pass adopted=true and
 * re-resolve as the width crosses 720; an unadopted surface stays framed-v4.
 */
export function useRoomPresentation(surface: Surface, adopted = true): PresentationMode {
  return resolvePresentation(surface, useViewportWidth(), adopted);
}
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
