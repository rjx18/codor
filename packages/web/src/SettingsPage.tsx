import {
  Bell,
  Cable,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gauge,
  KeyRound,
  Laptop,
  Monitor,
  Moon,
  Palette,
  RadioTower,
  Send,
  ShieldCheck,
  Smartphone,
  Sun,
  Unplug,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

import {
  fetchDevices,
  fetchPushConfig,
  mintPairingOffer,
  revokeDevice,
  type DeviceSummary,
  type PairingOffer,
  type PushConfig,
} from './api.js';
import {
  currentBrowserAccessToken,
  ensureBrowserIdentity,
  unpairBrowser,
} from './crypto.js';
import { enablePushNotifications, notificationPermission } from './notifications.js';
import { BridgedRoomBanner } from './components.js';
import { RoomRail } from './shell.js';
import { heldDeliveries, me, roleAtLeast, unreadCount, useRoomStore } from './state.js';
import {
  readThemeChoice,
  storeThemeChoice,
  type ThemeChoice,
} from './theme.js';
import { connect } from './ws.js';

function pageParams(): { room: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  return { room: params.get('room') ?? 'default', token: params.get('token') ?? '' };
}

const relayCapabilities = [
  ['Push gateway', 'Available now · sealed notifications to paired devices.'],
  ['Rendezvous & NAT relay', 'Hosted roadmap · ciphertext pipe when direct links fail.'],
  ['Encrypted mailbox', 'Hosted roadmap · deferred from the v1 push relay.'],
  ['Browser gateway', 'Hosted roadmap · encrypted path to a stable web URL.'],
  ['Hosted integrations', 'Hosted roadmap · explicit Slack and Telegram bridge opt-in.'],
] as const;

const settingsSections = [
  ['appearance', 'Appearance'],
  ['notifications', 'Notifications'],
  ['brakes', 'Brakes'],
  ['relay', 'Relay'],
  ['devices', 'Paired devices'],
  ['privacy', 'Privacy'],
] as const;

const themeChoices = [
  ['system', Monitor, 'System'],
  ['dark', Moon, 'Dark'],
  ['light', Sun, 'Light'],
] as const;

type SettingsSection = typeof settingsSections[number][0];

function sectionFromHash(): SettingsSection {
  const candidate = window.location.hash.replace(/^#/, '');
  return settingsSections.some(([id]) => id === candidate)
    ? candidate as SettingsSection
    : 'appearance';
}

// harn:assume web-settings-controls-preserve-product-truth ref=glass-settings-surface
export function SettingsPage(props: {
  token?: string;
  refreshToken?: () => Promise<string>;
} = {}): JSX.Element {
  const state = useRoomStore();
  const page = useMemo(pageParams, []);
  const room = page.room;
  const token = props.token ?? page.token;
  const accessToken = useCallback(() => currentBrowserAccessToken(token), [token]);
  const connection = useMemo(
    () => connect({ room, token: accessToken(), refreshToken: props.refreshToken }),
    [room, accessToken, props.refreshToken],
  );
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [pushConfig, setPushConfig] = useState<PushConfig>({ enabled: false });
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [pairingOffer, setPairingOffer] = useState<PairingOffer>();
  const [pairingQr, setPairingQr] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<string>();
  const [relayOpen, setRelayOpen] = useState(false);
  const [unpaired, setUnpaired] = useState(false);
  const [unpairWarning, setUnpairWarning] = useState<string>();
  const [localPurgeWarning, setLocalPurgeWarning] = useState<string>();
  const [turnEnabled, setTurnEnabled] = useState(false);
  const [turnBrake, setTurnBrake] = useState('3');
  const [spendEnabled, setSpendEnabled] = useState(false);
  const [spendBrake, setSpendBrake] = useState('10');
  const [stallMinutes, setStallMinutes] = useState('30');
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);
  const [activeSection, setActiveSection] = useState<SettingsSection>(sectionFromHash);

  const chooseTheme = (choice: ThemeChoice): void => {
    setTheme(choice);
    storeThemeChoice(choice);
  };

  const refreshDevices = async (): Promise<void> => {
    const [nextDevices, nextConfig, identity] = await Promise.all([
      fetchDevices({ token: accessToken() }),
      fetchPushConfig({ token: accessToken() }),
      ensureBrowserIdentity(),
    ]);
    setDevices(nextDevices);
    setPushConfig(nextConfig);
    setCurrentDeviceId(identity.device_id);
  };

  useEffect(() => {
    const config = state.room?.config;
    if (!config) return;
    setTurnEnabled(config.turn_brake !== null);
    setTurnBrake(String(config.turn_brake ?? 3));
    setSpendEnabled(config.spend_brake_usd !== null);
    setSpendBrake(String(config.spend_brake_usd ?? 10));
    setStallMinutes(String(config.stall_minutes));
  }, [state.room?.config]);

  useEffect(() => {
    const followHash = (): void => setActiveSection(sectionFromHash());
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  const currentDevice = devices.find((device) => device.device_id === currentDeviceId);
  const roomHref = `/?${new URLSearchParams({ room }).toString()}`;
  const self = me(state.members, state.selfMemberId);
  const owner = Object.values(state.members).find((member) =>
    member.kind === 'human' && member.role === 'owner');
  const canAdmin = roleAtLeast(self?.role, 'admin');
  const canOwner = roleAtLeast(self?.role, 'owner');
  const visibleSections = settingsSections.filter(([id]) =>
    id === 'appearance' || id === 'privacy' ||
    (canAdmin && (id === 'brakes' || id === 'relay')) ||
    (canOwner && (id === 'notifications' || id === 'devices')));
  const visibleActiveSection = visibleSections.some(([id]) => id === activeSection)
    ? activeSection
    : 'appearance';
  const activeSectionLabel = settingsSections.find(([id]) => id === visibleActiveSection)?.[1] ?? 'Settings';

  useEffect(() => {
    if (self === undefined) return;
    if (canOwner) {
      void refreshDevices().catch(() => setNotice('Device settings are unavailable.'));
    } else {
      void fetchPushConfig({ token: accessToken() }).then(setPushConfig).catch(() => undefined);
    }
  }, [accessToken, canOwner, self?.id]);

  useEffect(() => {
    if (!pairingOffer) {
      setPairingQr(undefined);
      return;
    }
    const url = new URL('/pair', pairingOffer.endpoint);
    url.searchParams.set('endpoint', pairingOffer.endpoint);
    url.searchParams.set('pairing_token', pairingOffer.pairing_token);
    url.searchParams.set('switchboard_sign_pub', pairingOffer.switchboard_sign_pub);
    let current = true;
    void QRCode.toDataURL(url.toString(), { margin: 1, width: 240 }).then((data) => {
      if (current) setPairingQr(data);
    });
    return () => { current = false; };
  }, [pairingOffer]);

  if (unpaired) {
    return (
      <main data-testid="browser-unpaired" className="wr-settings-page wr-centered-page">
        <section className="wr-focused-glass wr-state-sheet">
          <ShieldCheck aria-hidden="true" size={30} />
          <h1>Browser unpaired</h1>
          <p>{localPurgeWarning ?? 'Local keys, caches, channel state, and the push subscription were removed.'}</p>
          {unpairWarning && <p role="alert" className="wr-warning-copy">{unpairWarning}</p>}
          <a href="/pair" className="wr-primary-button min-h-11 px-4">Pair again</a>
        </section>
      </main>
    );
  }

  return (
    <main data-testid="settings-page" className="wr-settings-page">
      <div className="wr-settings-grid">
        <RoomRail
          rooms={state.room ? [state.room] : []}
          currentRoom={room}
          currentUnread={unreadCount(state)}
          currentHeld={heldDeliveries(state.inbox).length}
          connected={state.connected}
          token={accessToken()}
          owner={owner ? { handle: owner.handle, display_name: owner.display_name } : undefined}
          canCreateRoom={canOwner}
        />
        <aside data-testid="settings-nav" className="wr-settings-nav">
          <div className="wr-settings-nav-title">
            <strong>Settings</strong>
          </div>
          <nav aria-label="Settings categories">
            {visibleSections.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                aria-current={visibleActiveSection === id ? 'location' : undefined}
                onClick={() => setActiveSection(id)}
              >
                {label}<ChevronRight aria-hidden="true" size={14} />
              </a>
            ))}
          </nav>
          <a href={roomHref} aria-label="Return to channel from settings navigation" className="wr-settings-back">
            <ChevronLeft aria-hidden="true" size={17} /> Back to channel
          </a>
        </aside>

        <div className="wr-settings-content">
          <header className="wr-settings-header">
            <a href={roomHref} aria-label="Back to channel" className="wr-icon-button">
              <ChevronLeft aria-hidden="true" size={21} />
            </a>
            <div>
              <h1>{activeSectionLabel}</h1>
              <p>{state.room?.name ?? room} · local settings</p>
            </div>
          </header>

          <div className="wr-settings-body">
            {notice && <p role="status" className="wr-settings-notice">{notice}</p>}

            {/* harn:assume web-settings-pairing-match-restrained-reference ref=restrained-settings-pairing-surface */}
            {state.room?.config.bridged && <BridgedRoomBanner />}
            <section id="appearance" data-testid="settings-section-appearance" data-active={visibleActiveSection === 'appearance'} className="wr-settings-section">
              <div className="wr-section-heading">
                <Palette aria-hidden="true" size={18} />
                <div><h2>Appearance</h2><p>Local to this browser.</p></div>
              </div>
              {/* harn:assume web-theme-choice-stays-local ref=settings-theme-control */}
              <div className="wr-setting-row">
                <div className="wr-setting-copy">
                  <strong>Theme</strong>
                  <span>Follow the system or keep a fixed color mode.</span>
                </div>
                <div className="wr-segmented" role="radiogroup" aria-label="Theme">
                  {themeChoices.map(([choice, Icon, label], index) => (
                    <button
                      key={choice}
                      type="button"
                      role="radio"
                      aria-checked={theme === choice}
                      tabIndex={theme === choice ? 0 : -1}
                      data-testid={`theme-${choice}`}
                      onClick={() => chooseTheme(choice)}
                      onKeyDown={(event) => {
                        let next = index;
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + themeChoices.length - 1) % themeChoices.length;
                        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % themeChoices.length;
                        else if (event.key === 'Home') next = 0;
                        else if (event.key === 'End') next = themeChoices.length - 1;
                        else return;
                        event.preventDefault();
                        const nextChoice = themeChoices[next]![0];
                        chooseTheme(nextChoice);
                        event.currentTarget.parentElement
                          ?.querySelector<HTMLElement>(`[data-testid="theme-${nextChoice}"]`)
                          ?.focus();
                      }}
                    >
                      <Icon aria-hidden="true" size={15} /> {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* harn:end web-theme-choice-stays-local */}
            </section>

            {canOwner && <section id="notifications" data-testid="settings-section-notifications" data-active={visibleActiveSection === 'notifications'} className="wr-settings-section">
              <div className="wr-section-heading">
                <Bell aria-hidden="true" size={18} />
                <div><h2>Notifications</h2><p>Sealed previews for this paired browser.</p></div>
              </div>
              <div className="wr-setting-row">
                <div className="wr-setting-copy">
                  <strong>{currentDevice?.push_enabled ? 'Browser notifications on' : 'Browser notifications off'}</strong>
                  <span>{pushConfig.enabled ? `Permission: ${notificationPermission()}` : 'Push is not configured on this device.'}</span>
                </div>
                <button
                  type="button"
                  data-testid="enable-notifications"
                  disabled={busy || !currentDevice || !pushConfig.enabled || !pushConfig.vapid_public_key}
                  onClick={() => {
                    if (!currentDevice || !pushConfig.vapid_public_key) return;
                    setBusy(true);
                    setNotice(undefined);
                    void enablePushNotifications({
                      deviceId: currentDevice.device_id,
                      token: accessToken(),
                      vapidPublicKey: pushConfig.vapid_public_key,
                    }).then(
                      async () => {
                        await refreshDevices();
                        setNotice('Notifications enabled.');
                      },
                      (error: unknown) => setNotice(error instanceof Error ? error.message : 'Notification setup failed.'),
                    ).finally(() => setBusy(false));
                  }}
                  className="wr-secondary-button min-h-11 px-4 disabled:opacity-40"
                >
                  Enable
                </button>
              </div>
            </section>}

            {canAdmin && <section id="brakes" data-testid="settings-section-brakes" data-active={visibleActiveSection === 'brakes'} className="wr-settings-section">
              <div className="wr-section-heading">
                <Gauge aria-hidden="true" size={18} />
                <div><h2>Channel brakes</h2><p>Opt-in holds for this channel. Both are off by default.</p></div>
              </div>
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const turn = Number(turnBrake);
                  const spend = Number(spendBrake);
                  const stall = Number(stallMinutes);
                  if (
                    (turnEnabled && (!Number.isSafeInteger(turn) || turn < 1)) ||
                    (spendEnabled && (!Number.isFinite(spend) || spend <= 0)) ||
                    !Number.isSafeInteger(stall) ||
                    stall < 1
                  ) {
                    setNotice('Enter positive values for enabled brakes and the stall interval.');
                    return;
                  }
                  connection.act({
                    act: 'configure_room',
                    turn_brake: turnEnabled ? turn : null,
                    spend_brake_usd: spendEnabled ? spend : null,
                    stall_minutes: stall,
                  });
                  setNotice('Channel brake update requested.');
                }}
              >
                <BrakeRow
                  icon={<Gauge size={20} />}
                  label="Turn brake"
                  description="Hold after consecutive agent hops without a human message."
                  enabled={turnEnabled}
                  onEnabled={setTurnEnabled}
                  value={turnBrake}
                  onValue={setTurnBrake}
                  testId="turn-brake"
                  unit="hops"
                />
                <BrakeRow
                  icon={<CircleDollarSign size={20} />}
                  label="Spend brake"
                  description="Hold when reported daily spend reaches this threshold."
                  enabled={spendEnabled}
                  onEnabled={setSpendEnabled}
                  value={spendBrake}
                  onValue={setSpendBrake}
                  testId="spend-brake"
                  step="0.01"
                  unit="USD"
                />
                <div className="wr-setting-row">
                  <span className="wr-setting-icon"><Clock3 aria-hidden="true" size={20} /></span>
                  <label htmlFor="stall-minutes" className="wr-setting-copy">
                    <strong>Stall flag</strong>
                    <span>Always on · flags inactivity · never kills a run.</span>
                  </label>
                  <div className="wr-number-control">
                    <input
                      id="stall-minutes"
                      data-testid="stall-minutes"
                      type="number"
                      min="1"
                      step="1"
                      value={stallMinutes}
                      onChange={(event) => setStallMinutes(event.target.value)}
                      className="wr-input"
                    />
                    <span>min</span>
                  </div>
                </div>
                <div className="wr-settings-actions">
                  <button type="submit" data-testid="room-settings-save" className="wr-primary-button min-h-11 px-5">Save brakes</button>
                </div>
              </form>
            </section>}

            {canAdmin && <section id="relay" data-testid="settings-section-relay" data-active={visibleActiveSection === 'relay'} className="wr-settings-section">
              <button
                type="button"
                data-testid="open-relay-pairing"
                aria-expanded={relayOpen}
                onClick={() => setRelayOpen((open) => !open)}
                className="wr-section-toggle"
              >
                <RadioTower aria-hidden="true" size={20} />
                <span><strong>Codor Relay</strong><small>{pushConfig.enabled ? 'Self-hosted push configured' : 'Not connected'}</small></span>
                <ChevronRight aria-hidden="true" size={18} />
              </button>
              {relayOpen && <RelayPairing />}
            </section>}

            {/* harn:assume unpair-purges-all-browser-state ref=settings-unpair-action */}
            {canOwner && <section id="devices" data-testid="settings-section-devices" data-active={visibleActiveSection === 'devices'} className="wr-settings-section">
              <div className="wr-section-heading">
                <Laptop aria-hidden="true" size={18} />
                <div><h2>Paired devices</h2><p>Device authority and sealed push state.</p></div>
              </div>
              {/* harn:assume pairing-code-enrollment-surfaces ref=settings-pair-another-device */}
              <div className="wr-pair-another">
                <button
                  type="button"
                  data-testid="pair-another-device"
                  disabled={busy}
                  className="wr-secondary-button min-h-11 px-4"
                  onClick={() => {
                    setBusy(true);
                    setNotice(undefined);
                    void mintPairingOffer(window.location.origin, { token: accessToken() }).then(
                      setPairingOffer,
                      () => setNotice('A pairing code could not be created.'),
                    ).finally(() => setBusy(false));
                  }}
                >
                  <KeyRound aria-hidden="true" size={18} />
                  Pair another device
                </button>
                {pairingOffer && (
                  <div data-testid="pairing-offer" className="wr-settings-pairing-offer">
                    <div>
                      <span>Pairing code</span>
                      <output data-testid="settings-pairing-code">{pairingOffer.pairing_code}</output>
                      <small>Expires {new Date(pairingOffer.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                    </div>
                    {pairingQr ? (
                      <img src={pairingQr} alt="Pair another device QR code" />
                    ) : (
                      <span role="status">Preparing QR</span>
                    )}
                  </div>
                )}
              </div>
              {/* harn:end pairing-code-enrollment-surfaces */}
              <ul className="wr-device-list">
                {devices.map((device) => {
                  const current = device.device_id === currentDeviceId;
                  const confirming = confirmDevice === device.device_id;
                  return (
                    <li key={device.device_id} data-testid={`device-${device.device_id}`}>
                      <div className="wr-device-row">
                        <span className="wr-setting-icon">
                          {current ? <Laptop aria-hidden="true" size={20} /> : <Smartphone aria-hidden="true" size={20} />}
                        </span>
                        <div className="wr-setting-copy">
                          <strong>{device.label ?? 'Paired browser'}</strong>
                          <span>{current ? 'This browser · ' : ''}{device.push_enabled ? 'Push on' : 'Push off'} · paired {new Date(device.paired_at).toLocaleDateString()}</span>
                        </div>
                        {!confirming && (
                          <button type="button" onClick={() => setConfirmDevice(device.device_id)} className="wr-danger-link min-h-11 px-3">
                            {current ? 'Unpair' : 'Revoke'}
                          </button>
                        )}
                      </div>
                      {confirming && (
                        <div className="wr-confirm-row">
                          <span>{current ? 'Remove this browser and all local Codor data?' : 'Revoke this device?'}</span>
                          <button type="button" onClick={() => setConfirmDevice(undefined)} className="wr-secondary-button min-h-11 px-3">Cancel</button>
                          <button
                            type="button"
                            data-testid={current ? 'confirm-unpair-browser' : `confirm-revoke-${device.device_id}`}
                            className="wr-danger-button min-h-11 px-3"
                            onClick={() => {
                              setBusy(true);
                              if (current) {
                                void (async () => {
                                  try {
                                    await revokeDevice(device.device_id, { token: accessToken() });
                                  } catch {
                                    setUnpairWarning('Codor could not be reached. Revoke this browser from another paired device before treating it as fully revoked.');
                                  } finally {
                                    connection.disconnect();
                                    state.reset();
                                    try {
                                      await unpairBrowser();
                                    } catch {
                                      setLocalPurgeWarning('Local cleanup could not be confirmed. Close other Codor tabs before pairing again.');
                                    } finally {
                                      setDevices([]);
                                      setUnpaired(true);
                                    }
                                  }
                                })().finally(() => setBusy(false));
                              } else {
                                void revokeDevice(device.device_id, { token: accessToken() })
                                  .then(refreshDevices)
                                  .catch(() => setNotice('The device could not be revoked.'))
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
                {devices.length === 0 && <li className="wr-empty-row">No paired devices</li>}
              </ul>
            </section>}
            {/* harn:end unpair-purges-all-browser-state */}

            <section id="privacy" data-testid="settings-section-privacy" data-active={visibleActiveSection === 'privacy'} className="wr-settings-section">
              <div className="wr-section-heading">
                <ShieldCheck aria-hidden="true" size={18} />
                <div><h2>Privacy</h2><p>Local plaintext, content-blind relay.</p></div>
              </div>
              <div className="wr-setting-row">
                <div className="wr-setting-copy">
                  <strong>Codor</strong>
                  <span>Channel history, run evidence, keys, and ledger stay on your machine.</span>
                </div>
                <span className="wr-status-copy"><i className="wr-presence is-live" /> Local only</span>
              </div>
            </section>
            {/* harn:end web-settings-pairing-match-restrained-reference */}
          </div>
        </div>
      </div>
    </main>
  );
}

function BrakeRow(props: {
  icon: JSX.Element;
  label: string;
  description: string;
  enabled: boolean;
  onEnabled(value: boolean): void;
  value: string;
  onValue(value: string): void;
  testId: string;
  unit: string;
  step?: string;
}) {
  return (
    <div className="wr-setting-row">
      <span className="wr-setting-icon">{props.icon}</span>
      <label htmlFor={`${props.testId}-enabled`} className="wr-setting-copy">
        <strong>{props.label}</strong>
        <em>Off by default</em>
        <span>{props.enabled ? props.description : 'Enable to configure this hold.'}</span>
      </label>
      <input
        id={`${props.testId}-enabled`}
        data-testid={`${props.testId}-enabled`}
        type="checkbox"
        checked={props.enabled}
        onChange={(event) => props.onEnabled(event.target.checked)}
        className="wr-checkbox"
      />
      <div className="wr-number-control">
        <input
          id={`${props.testId}-value`}
          data-testid={`${props.testId}-value`}
          type="number"
          aria-label={`${props.label} value`}
          min={props.step ? '0.01' : '1'}
          step={props.step ?? '1'}
          disabled={!props.enabled}
          value={props.value}
          onChange={(event) => props.onValue(event.target.value)}
          className="wr-input"
        />
        <span>{props.unit}</span>
      </div>
    </div>
  );
}

function RelayPairing() {
  return (
    <div data-testid="relay-pairing" className="wr-relay-detail">
      <div className="wr-relay-intro">
        <Cable aria-hidden="true" size={22} />
        <div><h2>Sealed push doorbell</h2><p>The v1 push relay forwards one opaque, padded ciphertext envelope and retains nothing.</p></div>
      </div>
      <div className="wr-disclosure-grid">
        <section>
          <h3>Relay can see</h3>
          <ul>
            <li>Opaque padded ciphertext</li>
            <li>Web Push endpoint + delivery keys</li>
            <li>Opaque Codor public key</li>
            <li>Timing, TTL, and source IP</li>
          </ul>
          <strong>Stores nothing · no mailbox · no retries</strong>
        </section>
        <section>
          <h3>Relay never sees</h3>
          <ul>
            <li>Sender, channel, or member names</li>
            <li>Message or run content</li>
            <li>Decrypted channel keys or any private key</li>
          </ul>
        </section>
      </div>
      <div className="wr-hosted-roadmap">
        <h3>Optional hosted Relay</h3>
        <p>Separate roadmap capabilities, still content-blind unless a channel explicitly enables a hosted bridge.</p>
        <ul>
          {relayCapabilities.map(([name, detail], index) => (
            <li key={name}>
              {index === 0 ? <Send aria-hidden="true" size={17} /> : index === 4 ? <Unplug aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}
              <span><strong>{name}</strong><small>{detail}</small></span>
            </li>
          ))}
        </ul>
        <p><strong>$5/month hosted</strong> · self-host the same open-source data plane.</p>
        <code><KeyRound aria-hidden="true" size={14} /> CODOR_RELAY_URL · CODOR_VAPID_PUBLIC_KEY</code>
      </div>
    </div>
  );
}
// harn:end web-settings-controls-preserve-product-truth
