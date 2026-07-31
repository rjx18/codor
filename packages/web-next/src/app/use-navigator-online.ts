import { useEffect, useState } from 'react';

/** Live `navigator.onLine`, kept current via the online/offline events. Shared by the
 *  mid-session recovery classifier and the boot-time connecting surface. */
export function useNavigatorOnLine(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
