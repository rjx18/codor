import { ArrowLeft, Monitor, Moon, QrCode, ShieldCheck, Sun, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchDevices,
  fetchPushConfig,
  mintPairingOffer,
  revokeDevice,
  type DeviceSummary,
  type PairingOffer,
  type PushConfig,
} from '@legacy/api.js';
import { currentBrowserAccessToken, ensureBrowserIdentity, unpairBrowser } from '@legacy/crypto.js';
import { enablePushNotifications, notificationPermission } from '@legacy/notifications.js';
import {
  applyThemeChoice,
  readThemeChoice,
  storeThemeChoice,
  type ThemeChoice,
} from '@legacy/theme.js';

import { createConnector, type RoomConnector } from '../app/connector.js';
import { roomSlice, useClientStore } from '../app/store.js';
import { clockTime } from '../primitives/identity.js';
import { Button, Code, Eyebrow, Modal, Segmented } from '../primitives/primitives.js';

export function SettingsPage(props: {
  room: string;
  token: string;
  refreshToken?: () => Promise<string>;
}) {
  // Settings is reached from a room; keep that room when returning, and fall
  // back to the remembered one rather than a placeholder channel.
  const page = { room: props.room };
  const token = useMemo(
    () => () => currentBrowserAccessToken(props.token),
    [props.token],
  );
  const connectorRef = useRef<RoomConnector | null>(null);
  if (connectorRef.current === null) {
    connectorRef.current = createConnector({
      room: page.room,
      token: props.token,
      refreshToken: props.refreshToken,
    });
  }

  return (
    <main className="nx-surface is-settings" aria-label="Settings">
      <div className="nx-settings">
        <header className="nx-settings-head">
          <a className="nx-btn is-quiet nx-settings-back" href={`/?room=${encodeURIComponent(page.room)}`}>
            <ArrowLeft size={15} aria-hidden="true" /> Back to the room
          </a>
          <h1>Settings</h1>
        </header>
        <AppearanceSection />
        <NotificationsSection token={token} />
        <BrakesSection connection={connectorRef.current} />
        <DevicesSection token={token} />
        <PrivacySection />
      </div>
    </main>
  );
}

// ── Appearance ─────────────────────────────────────────────────────────────

function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);
  const choose = (choice: ThemeChoice): void => {
    setTheme(choice);
    storeThemeChoice(choice);
    applyThemeChoice(choice);
  };
  return (
    <section className="nx-settings-card" aria-labelledby="s-appearance">
      <h2 id="s-appearance">Appearance</h2>
      <p className="nx-settings-sub">Light is the base paint; dark is a choice or your system’s.</p>
      <Segmented<ThemeChoice>
        label="Theme"
        value={theme}
        onChange={choose}
        options={[
          { value: 'system', label: 'System', testid: 'theme-system' },
          { value: 'light', label: 'Light', testid: 'theme-light' },
          { value: 'dark', label: 'Dark', testid: 'theme-dark' },
        ]}
      />
      <p className="nx-settings-note">
        {theme === 'system' ? <Monitor size={13} aria-hidden="true" /> : theme === 'dark' ? <Moon size={13} aria-hidden="true" /> : <Sun size={13} aria-hidden="true" />}
        {' '}applies immediately on this device
      </p>
    </section>
  );
}

// ── Notifications: Web Push opt-in, honest when the switchboard lacks it ──

function NotificationsSection(props: { token: () => string }) {
  const [config, setConfig] = useState<PushConfig>();
  const [deviceId, setDeviceId] = useState<string>();
  const [state, setState] = useState<'idle' | 'enabling' | 'on' | 'failed'>('idle');
  const permission = notificationPermission();

  useEffect(() => {
    void Promise.all([fetchPushConfig({ token: props.token() }), ensureBrowserIdentity()])
      .then(([loaded, identity]) => {
        setConfig(loaded);
        setDeviceId(identity.device_id);
        if (permission === 'granted') setState('on');
      })
      .catch(() => setConfig({ enabled: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available = config?.enabled === true && config.vapid_public_key !== undefined && permission !== 'unsupported';

  return (
    <section className="nx-settings-card" aria-labelledby="s-notifications">
      <h2 id="s-notifications">Notifications</h2>
      <p className="nx-settings-sub">
        Push arrives sealed; this browser opens it with its own keys.
      </p>
      {config === undefined ? (
        <p className="nx-field-note">Checking push support…</p>
      ) : !available ? (
        <p className="nx-field-note" data-testid="push-unavailable">
          {permission === 'unsupported'
            ? 'This browser does not support Web Push.'
            : 'Push is not configured on this switchboard — enable a relay first.'}
        </p>
      ) : (
        <div className="nx-settings-actions">
          <Button
            variant={state === 'on' ? 'secondary' : 'primary'}
            disabled={state === 'enabling' || state === 'on' || deviceId === undefined}
            data-testid="push-enable"
            onClick={() => {
              if (deviceId === undefined || config.vapid_public_key === undefined) return;
              setState('enabling');
              void enablePushNotifications({
                deviceId,
                token: props.token(),
                vapidPublicKey: config.vapid_public_key,
              }).then(
                () => setState('on'),
                () => setState('failed'),
              );
            }}
          >
            {state === 'on' ? 'Push is on for this device' : state === 'enabling' ? 'Enabling…' : 'Enable push on this device'}
          </Button>
        </div>
      )}
      {state === 'failed' && (
        <p className="nx-field-note is-error" role="alert">
          Couldn’t enable push — check the browser permission and try again.
        </p>
      )}
    </section>
  );
}

// ── Channel brakes ─────────────────────────────────────────────────────────

function BrakesSection(props: { connection: RoomConnector }) {
  const roomId = props.connection.room();
  const room = useClientStore((state) => roomSlice(state, roomId).room);
  const connected = useClientStore((state) => state.connected);
  const [turnEnabled, setTurnEnabled] = useState(false);
  const [turnBrake, setTurnBrake] = useState('3');
  const [spendEnabled, setSpendEnabled] = useState(false);
  const [spendBrake, setSpendBrake] = useState('10');
  const [stallMinutes, setStallMinutes] = useState('30');
  const [saved, setSaved] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || room === undefined) return;
    hydrated.current = true;
    setTurnEnabled(room.config.turn_brake !== null);
    setTurnBrake(String(room.config.turn_brake ?? 3));
    setSpendEnabled(room.config.spend_brake_usd !== null);
    setSpendBrake(String(room.config.spend_brake_usd ?? 10));
    setStallMinutes(String(room.config.stall_minutes));
  }, [room]);

  const apply = (): void => {
    const turn = Number(turnBrake);
    const spend = Number(spendBrake);
    const stall = Number(stallMinutes);
    props.connection.act({
      act: 'configure_room',
      turn_brake: turnEnabled && Number.isInteger(turn) && turn > 0 ? turn : null,
      spend_brake_usd: spendEnabled && Number.isFinite(spend) && spend > 0 ? spend : null,
      ...(Number.isInteger(stall) && stall > 0 && { stall_minutes: stall }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <section className="nx-settings-card" aria-labelledby="s-brakes">
      <h2 id="s-brakes">Brakes — {room?.name ?? 'this channel'}</h2>
      <p className="nx-settings-sub">
        Pause agent chains for your attention. Off by default; held work waits in the banner.
      </p>
      <label className="nx-brake-row">
        <input
          type="checkbox"
          checked={turnEnabled}
          data-testid="brake-turn-toggle"
          onChange={(e) => setTurnEnabled(e.target.checked)}
        />
        <span className="nx-brake-label">Hold after</span>
        <input
          className="nx-brake-value"
          inputMode="numeric"
          value={turnBrake}
          disabled={!turnEnabled}
          data-testid="brake-turn-value"
          onChange={(e) => setTurnBrake(e.target.value)}
        />
        <span className="nx-brake-label">agent-to-agent hops</span>
      </label>
      <label className="nx-brake-row">
        <input
          type="checkbox"
          checked={spendEnabled}
          data-testid="brake-spend-toggle"
          onChange={(e) => setSpendEnabled(e.target.checked)}
        />
        <span className="nx-brake-label">Hold past</span>
        <input
          className="nx-brake-value"
          inputMode="decimal"
          value={spendBrake}
          disabled={!spendEnabled}
          onChange={(e) => setSpendBrake(e.target.value)}
        />
        <span className="nx-brake-label">dollars spent today</span>
      </label>
      <label className="nx-brake-row">
        <span className="nx-brake-label">Flag a silent agent after</span>
        <input
          className="nx-brake-value"
          inputMode="numeric"
          value={stallMinutes}
          onChange={(e) => setStallMinutes(e.target.value)}
        />
        <span className="nx-brake-label">minutes</span>
      </label>
      <div className="nx-settings-actions">
        <Button variant="primary" disabled={!connected} data-testid="brakes-apply" onClick={apply}>
          {saved ? 'Applied ✓' : 'Apply brakes'}
        </Button>
      </div>
    </section>
  );
}

// ── Devices ────────────────────────────────────────────────────────────────

function DevicesSection(props: { token: () => string }) {
  const [devices, setDevices] = useState<DeviceSummary[]>();
  const [offer, setOffer] = useState<PairingOffer>();
  const [qr, setQr] = useState<string>();
  const [revoking, setRevoking] = useState<DeviceSummary>();
  const [error, setError] = useState<string>();

  const refresh = (): void => {
    void fetchDevices({ token: props.token() })
      .then(setDevices)
      .catch(() => setError('Couldn’t load paired devices.'));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!offer) {
      setQr(undefined);
      return;
    }
    const url = new URL('/pair', offer.endpoint);
    url.searchParams.set('endpoint', offer.endpoint);
    url.searchParams.set('pairing_token', offer.pairing_token);
    url.searchParams.set('switchboard_sign_pub', offer.switchboard_sign_pub);
    let current = true;
    void QRCode.toDataURL(url.toString(), { margin: 4, scale: 4 }).then((data) => {
      if (current) setQr(data);
    });
    return () => { current = false; };
  }, [offer]);

  return (
    <section className="nx-settings-card" aria-labelledby="s-devices">
      <h2 id="s-devices">Devices</h2>
      <p className="nx-settings-sub">Browsers paired to this switchboard.</p>
      {error !== undefined && <p className="nx-field-note is-error">{error}</p>}
      {devices !== undefined && (
        <ul className="nx-device-list" data-testid="device-list">
          {devices.length === 0 && <li className="nx-field-note">No paired devices yet.</li>}
          {devices.map((device) => (
            <li key={device.device_id} className="nx-device-row" data-testid={`device-${device.device_id}`}>
              <span className="nx-device-id">
                <strong>{device.label ?? device.device_id.slice(0, 12)}</strong>
                <span className="nx-field-note">paired {clockTime(device.paired_at)}{device.push_enabled ? ' · push on' : ''}</span>
              </span>
              <Button variant="danger" data-testid={`device-${device.device_id}-revoke`} onClick={() => setRevoking(device)}>
                <Trash2 size={14} aria-hidden="true" /> Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="nx-settings-actions">
        <Button
          variant="secondary"
          data-testid="pair-new-device"
          onClick={() => {
            void mintPairingOffer(window.location.origin, { token: props.token() })
              .then(setOffer)
              .catch(() => setError('Couldn’t mint a pairing offer.'));
          }}
        >
          <QrCode size={15} aria-hidden="true" /> Pair a new device
        </Button>
      </div>
      {offer !== undefined && (
        <Modal label="Pair a new device" onClose={() => setOffer(undefined)} testid="pairing-offer">
          <h2 className="nx-dialog-title">Pair a new device</h2>
          <p className="nx-dialog-body">Scan from the new device, or type the code at <Code>{offer.endpoint}/pair</Code>.</p>
          {qr !== undefined && <img className="nx-pair-qr" src={qr} alt="Pairing QR code" />}
          <p className="nx-pair-code" data-testid="pairing-code"><Code>{offer.pairing_code}</Code></p>
          <p className="nx-field-note">offer expires {clockTime(offer.expires_at)}</p>
        </Modal>
      )}
      {revoking !== undefined && (
        <Modal label="Revoke device" onClose={() => setRevoking(undefined)} alert testid="revoke-confirm">
          <h2 className="nx-dialog-title">Revoke {revoking.label ?? 'this device'}?</h2>
          <p className="nx-dialog-body">
            It loses access immediately and the room keys rotate away from it.
          </p>
          <div className="nx-dialog-actions">
            <Button variant="quiet" onClick={() => setRevoking(undefined)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="revoke-go"
              onClick={() => {
                void revokeDevice(revoking.device_id, { token: props.token() })
                  .then(() => {
                    setRevoking(undefined);
                    refresh();
                  })
                  .catch(() => setError('Revoke failed.'));
              }}
            >
              Revoke device
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ── Privacy ────────────────────────────────────────────────────────────────

function PrivacySection() {
  const [confirming, setConfirming] = useState(false);
  const [unpaired, setUnpaired] = useState(false);

  if (unpaired) {
    return (
      <section className="nx-settings-card" data-testid="browser-unpaired">
        <h2><ShieldCheck size={16} aria-hidden="true" /> This browser is unpaired</h2>
        <p className="nx-settings-sub">Local keys and cached state are gone. Pair again from another device’s settings.</p>
      </section>
    );
  }

  return (
    <section className="nx-settings-card" aria-labelledby="s-privacy">
      <h2 id="s-privacy">Privacy</h2>
      <p className="nx-settings-sub">Unpairing deletes this browser’s keys and local state.</p>
      <div className="nx-settings-actions">
        <Button variant="danger" data-testid="unpair-browser" onClick={() => setConfirming(true)}>
          Unpair this browser
        </Button>
      </div>
      {confirming && (
        <Modal label="Unpair this browser" onClose={() => setConfirming(false)} alert testid="unpair-confirm">
          <h2 className="nx-dialog-title">Unpair this browser?</h2>
          <p className="nx-dialog-body">It stops syncing immediately; other devices are untouched.</p>
          <div className="nx-dialog-actions">
            <Button variant="quiet" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="unpair-go"
              onClick={() => {
                void unpairBrowser().finally(() => {
                  setConfirming(false);
                  setUnpaired(true);
                });
              }}
            >
              Unpair
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
