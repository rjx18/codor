import { registerPushSubscription } from './api.js';

function decodeApplicationServerKey(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function sameBytes(left: ArrayBuffer | null, right: ArrayBuffer): boolean {
  if (!left) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in globalThis ? Notification.permission : 'unsupported';
}

// harn:assume push-decrypts-on-device-only ref=notification-permission-registration
export async function enablePushNotifications(options: {
  deviceId: string;
  token: string;
  vapidPublicKey: string;
}): Promise<PushSubscription> {
  if (!('Notification' in globalThis) || !('serviceWorker' in navigator)) {
    throw new Error('notifications are not supported in this browser');
  }
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('notification permission was not granted');
  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = decodeApplicationServerKey(options.vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  await registerPushSubscription(options.deviceId, subscription.toJSON(), { token: options.token });
  return subscription;
}
// harn:end push-decrypts-on-device-only
