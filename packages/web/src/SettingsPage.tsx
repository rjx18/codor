import {
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gauge,
  KeyRound,
  Laptop,
  RadioTower,
  Send,
  ShieldCheck,
  Smartphone,
  Unplug,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  fetchDevices,
  fetchPushConfig,
  revokeDevice,
  type DeviceSummary,
  type PushConfig,
} from './api.js';
import { ensureBrowserIdentity, unpairBrowser } from './crypto.js';
import { enablePushNotifications, notificationPermission } from './notifications.js';
import { useRoomStore } from './state.js';
import { connect } from './ws.js';

function pageParams(): { room: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return { room: params.get('room') ?? 'default', token: params.get('token') ?? '' };
}

const relayCapabilities = [
  ['Push gateway', 'Sealed notifications to paired devices.'],
  ['Rendezvous & NAT relay', 'A ciphertext pipe when direct links fail.'],
  ['Encrypted mailbox', 'TTL-bound sealed payload pickup.'],
  ['Browser gateway', 'An encrypted path to a stable web URL.'],
  ['Hosted integrations', 'Optional Slack and Telegram bridges.'],
] as const;

export function SettingsPage(): JSX.Element {
  const state = useRoomStore();
  const { room, token } = useMemo(pageParams, []);
  const connection = useMemo(() => connect({ room, token }), [room, token]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [pushConfig, setPushConfig] = useState<PushConfig>({ enabled: false });
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<string>();
  const [relayOpen, setRelayOpen] = useState(false);
  const [pairingValue, setPairingValue] = useState('');
  const [relayNotice, setRelayNotice] = useState<string>();
  const [unpaired, setUnpaired] = useState(false);
  const [unpairWarning, setUnpairWarning] = useState<string>();
  const [turnEnabled, setTurnEnabled] = useState(false);
  const [turnBrake, setTurnBrake] = useState('3');
  const [spendEnabled, setSpendEnabled] = useState(false);
  const [spendBrake, setSpendBrake] = useState('10');
  const [stallMinutes, setStallMinutes] = useState('30');

  const refreshDevices = async (): Promise<void> => {
    const [nextDevices, nextConfig, identity] = await Promise.all([
      fetchDevices({ token }),
      fetchPushConfig({ token }),
      ensureBrowserIdentity(),
    ]);
    setDevices(nextDevices);
    setPushConfig(nextConfig);
    setCurrentDeviceId(identity.device_id);
  };

  useEffect(() => {
    void refreshDevices().catch(() => setNotice('Device settings are unavailable.'));
  }, [token]);

  useEffect(() => {
    const config = state.room?.config;
    if (!config) return;
    setTurnEnabled(config.turn_brake !== null);
    setTurnBrake(String(config.turn_brake ?? 3));
    setSpendEnabled(config.spend_brake_usd !== null);
    setSpendBrake(String(config.spend_brake_usd ?? 10));
    setStallMinutes(String(config.stall_minutes));
  }, [state.room?.config]);

  const currentDevice = devices.find((device) => device.device_id === currentDeviceId);
  const roomHref = `/?${new URLSearchParams({ room, ...(token && { token }) }).toString()}`;

  if (unpaired) {
    return (
      <main data-testid="browser-unpaired" className="flex min-h-dvh items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <section className="w-full max-w-sm text-center">
          <ShieldCheck aria-hidden="true" size={28} className="mx-auto text-emerald-400" />
          <h1 className="mt-4 text-lg font-semibold">Browser unpaired</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">Local keys, caches, room state, and the push subscription were removed.</p>
          {unpairWarning && <p role="alert" className="mt-3 text-sm leading-6 text-amber-400">{unpairWarning}</p>}
          <a href="/pair" className="mt-6 inline-flex min-h-11 items-center px-4 text-sm font-medium text-sky-400">Pair again</a>
        </section>
      </main>
    );
  }

  return (
    <main data-testid="settings-page" className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex min-h-16 items-center border-b border-zinc-800 bg-zinc-950 px-2 sm:px-4">
        <a
          href={roomHref}
          aria-label="Back to room"
          className="inline-flex h-11 w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <ChevronLeft aria-hidden="true" size={22} />
        </a>
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="truncate text-xs text-zinc-500">{state.room?.name ?? room}</p>
        </div>
      </header>

      <div className="mx-auto max-w-3xl">
        <section className="border-b border-zinc-800">
          <h2 className="px-4 pb-2 pt-7 text-[11px] font-medium uppercase text-zinc-500">This browser</h2>
          <div className="flex min-h-24 items-center gap-3 border-t border-zinc-800 px-4 py-4">
            <Bell aria-hidden="true" className="shrink-0 text-zinc-400" size={22} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-zinc-100">
                {currentDevice?.push_enabled ? 'Notifications are enabled' : 'Notifications are disabled'}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {pushConfig.enabled ? `Permission: ${notificationPermission()}` : 'Push is not configured on this switchboard.'}
              </p>
            </div>
            <button
              type="button"
              data-testid="enable-notifications"
              disabled={busy || !currentDevice || !pushConfig.vapid_public_key}
              onClick={() => {
                if (!currentDevice || !pushConfig.vapid_public_key) return;
                setBusy(true);
                setNotice(undefined);
                void enablePushNotifications({
                  deviceId: currentDevice.device_id,
                  token,
                  vapidPublicKey: pushConfig.vapid_public_key,
                }).then(
                  async () => {
                    await refreshDevices();
                    setNotice('Notifications enabled.');
                  },
                  (error: unknown) => setNotice(error instanceof Error ? error.message : 'Notification setup failed.'),
                ).finally(() => setBusy(false));
              }}
              className="min-h-11 shrink-0 px-3 text-sm font-medium text-sky-400 disabled:text-zinc-600"
            >
              Enable
            </button>
          </div>
          {notice && <p role="status" className="px-4 pb-4 text-xs text-zinc-400">{notice}</p>}
        </section>

        {/* harn:assume unpair-purges-all-browser-state ref=settings-unpair-action */}
        <section className="border-b border-zinc-800">
          <h2 className="px-4 pb-2 pt-7 text-[11px] font-medium uppercase text-zinc-500">Paired devices</h2>
          <ul className="border-t border-zinc-800">
            {devices.map((device) => {
              const current = device.device_id === currentDeviceId;
              const confirming = confirmDevice === device.device_id;
              return (
                <li key={device.device_id} data-testid={`device-${device.device_id}`} className="border-b border-zinc-800 px-4 py-4 last:border-b-0">
                  <div className="flex min-h-12 items-center gap-3">
                    {current ? <Laptop aria-hidden="true" size={21} className="text-sky-400" /> : <Smartphone aria-hidden="true" size={21} className="text-zinc-400" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{device.label ?? 'Paired browser'}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {current ? 'This device · ' : ''}{device.push_enabled ? 'Push on' : 'Push off'} · paired {new Date(device.paired_at).toLocaleDateString()}
                      </p>
                    </div>
                    {!confirming && (
                      <button
                        type="button"
                        onClick={() => setConfirmDevice(device.device_id)}
                        className="min-h-11 px-3 text-sm text-red-400"
                      >
                        {current ? 'Unpair' : 'Revoke'}
                      </button>
                    )}
                  </div>
                  {confirming && (
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <span className="mr-auto text-xs text-zinc-400">{current ? 'Remove this browser and its local data?' : 'Revoke this device?'}</span>
                      <button type="button" onClick={() => setConfirmDevice(undefined)} className="min-h-11 px-3 text-sm text-zinc-300">Cancel</button>
                      <button
                        type="button"
                        data-testid={current ? 'confirm-unpair-browser' : `confirm-revoke-${device.device_id}`}
                        className="min-h-11 px-3 text-sm font-medium text-red-400"
                        onClick={() => {
                          setBusy(true);
                          if (current) {
                            void (async () => {
                              try {
                                await revokeDevice(device.device_id, { token });
                              } catch {
                                setUnpairWarning('The switchboard could not be reached. Revoke this browser from another paired device before treating it as fully revoked.');
                              } finally {
                                state.reset();
                                await unpairBrowser();
                                setDevices([]);
                                setUnpaired(true);
                              }
                            })().finally(() => setBusy(false));
                          } else {
                            void revokeDevice(device.device_id, { token })
                              .then(refreshDevices)
                              .finally(() => {
                                setConfirmDevice(undefined);
                                setBusy(false);
                              });
                          }
                        }}
                      >
                        {current ? 'Unpair browser' : 'Revoke device'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {devices.length === 0 && <li className="px-4 py-5 text-sm text-zinc-500">No paired devices</li>}
          </ul>
        </section>
        {/* harn:end unpair-purges-all-browser-state */}

        <section className="border-b border-zinc-800">
          <h2 className="px-4 pb-2 pt-7 text-[11px] font-medium uppercase text-zinc-500">Room brakes</h2>
          <form
            className="border-t border-zinc-800"
            onSubmit={(event) => {
              event.preventDefault();
              connection.act({
                act: 'configure_room',
                turn_brake: turnEnabled ? Number(turnBrake) : null,
                spend_brake_usd: spendEnabled ? Number(spendBrake) : null,
                stall_minutes: Number(stallMinutes),
              });
              setNotice('Room brakes saved.');
            }}
          >
            <BrakeRow icon={<Gauge size={21} />} label="Turn brake" enabled={turnEnabled} onEnabled={setTurnEnabled} value={turnBrake} onValue={setTurnBrake} testId="turn-brake" />
            <BrakeRow icon={<CircleDollarSign size={21} />} label="Spend brake" enabled={spendEnabled} onEnabled={setSpendEnabled} value={spendBrake} onValue={setSpendBrake} testId="spend-brake" step="0.01" />
            <div className="flex min-h-20 items-center gap-3 border-b border-zinc-800 px-4 py-3">
              <Clock3 aria-hidden="true" size={21} className="text-zinc-400" />
              <label htmlFor="stall-minutes" className="min-w-0 flex-1 text-sm text-zinc-200">Stall flag</label>
              <input id="stall-minutes" data-testid="stall-minutes" type="number" min="1" step="1" value={stallMinutes} onChange={(event) => setStallMinutes(event.target.value)} className="h-11 w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-center text-sm" />
              <span className="text-xs text-zinc-500">min</span>
            </div>
            <div className="p-4">
              <button type="submit" data-testid="room-settings-save" className="min-h-11 w-full rounded-md bg-sky-700 px-4 text-sm font-medium text-white hover:bg-sky-600">Save brakes</button>
            </div>
          </form>
        </section>

        <section className="border-b border-zinc-800">
          <button
            type="button"
            data-testid="open-relay-pairing"
            aria-expanded={relayOpen}
            onClick={() => setRelayOpen((open) => !open)}
            className="flex min-h-20 w-full items-center gap-3 px-4 text-left"
          >
            <RadioTower aria-hidden="true" size={22} className="text-sky-400" />
            <span className="min-w-0 flex-1">
              <strong className="block text-sm font-medium text-zinc-100">Wireroom Relay</strong>
              <span className="mt-1 block text-xs text-amber-400">{pushConfig.enabled ? 'Self-hosted push configured' : 'Not connected'}</span>
            </span>
            <ChevronRight aria-hidden="true" size={19} className="text-zinc-500" />
          </button>
          {relayOpen && (
            <RelayPairing
              value={pairingValue}
              onValue={setPairingValue}
              notice={relayNotice}
              onConnect={() => {
                const value = pairingValue.trim();
                if (value === '') return setRelayNotice('Enter a pairing code or relay URL.');
                localStorage.setItem('wireroom-relay-pairing', value);
                setRelayNotice('Pairing request saved locally. Relay-side approval is still required.');
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function BrakeRow(props: {
  icon: JSX.Element;
  label: string;
  enabled: boolean;
  onEnabled(value: boolean): void;
  value: string;
  onValue(value: string): void;
  testId: string;
  step?: string;
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 border-b border-zinc-800 px-4 py-3">
      <span className="text-zinc-400">{props.icon}</span>
      <label htmlFor={`${props.testId}-enabled`} className="min-w-0 flex-1 text-sm text-zinc-200">{props.label}</label>
      <input id={`${props.testId}-enabled`} data-testid={`${props.testId}-enabled`} type="checkbox" checked={props.enabled} onChange={(event) => props.onEnabled(event.target.checked)} className="h-5 w-5 accent-sky-500" />
      <input data-testid={`${props.testId}-value`} type="number" min={props.step ? '0.01' : '1'} step={props.step ?? '1'} disabled={!props.enabled} value={props.value} onChange={(event) => props.onValue(event.target.value)} className="h-11 w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-center text-sm disabled:opacity-40" />
    </div>
  );
}

function RelayPairing(props: {
  value: string;
  onValue(value: string): void;
  notice?: string;
  onConnect(): void;
}) {
  return (
    <div data-testid="relay-pairing" className="border-t border-zinc-800 px-4 py-6">
      <h2 className="text-xl font-semibold text-zinc-100">Connect to Wireroom Relay</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">Blind plumbing for when your room needs to reach beyond your tailnet.</p>
      <ul className="mt-5 divide-y divide-zinc-800 border-y border-zinc-800">
        {relayCapabilities.map(([name, detail], index) => (
          <li key={name} className="flex min-h-16 items-center gap-3 py-3">
            {index === 0 ? <Send size={19} className="text-sky-400" /> : index === 4 ? <Unplug size={19} className="text-amber-400" /> : <ShieldCheck size={19} className="text-emerald-400" />}
            <span><strong className="block text-sm text-zinc-200">{name}</strong><span className="mt-1 block text-xs text-zinc-500">{detail}</span></span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-4 border-b border-zinc-800 py-5 text-xs">
        <div><h3 className="font-semibold text-zinc-200">Relay sees</h3><p className="mt-2 leading-6 text-zinc-500">Device push tokens<br />Connection timing<br />Opaque IDs<br />Public keys</p></div>
        <div><h3 className="font-semibold text-zinc-200">Relay never sees</h3><p className="mt-2 leading-6 text-zinc-500">Message bodies<br />Member names<br />Run events or code<br />Ledger notes</p></div>
      </div>
      <label className="mt-5 block text-xs text-zinc-400">Pairing code or relay URL
        <input value={props.value} onChange={(event) => props.onValue(event.target.value)} className="mt-2 h-12 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-base text-zinc-100" placeholder="relay URL or pairing code" />
      </label>
      <button type="button" onClick={props.onConnect} className="mt-3 min-h-11 w-full rounded-md bg-sky-700 px-4 text-sm font-medium text-white">Connect</button>
      {props.notice && <p role="status" className="mt-3 text-xs text-zinc-400">{props.notice}</p>}
      <p className="mt-5 text-xs leading-5 text-zinc-400"><strong className="text-zinc-200">$5/month hosted</strong> · self-host the same open-source relay. Hosted integrations are an explicit bridged-room exception.</p>
      <p className="mt-2 flex items-center gap-2 text-xs text-sky-400"><KeyRound size={15} /> Self-host with WIREROOM_RELAY_URL and WIREROOM_VAPID_PUBLIC_KEY.</p>
    </div>
  );
}
