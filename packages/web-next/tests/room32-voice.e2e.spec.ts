import { expect, test, type Page } from '@playwright/test';

// eng seeds an agent roster; a dictated message addresses a human (@viewer, no
// run triggered) and posts as a plain-text message carrying voice metadata,
// rendered as a voice card. The agent-free files room stays clean for the
// "nothing posted" assertions (eng accretes cards across tests).
const ROOM = '/?room=eng&token=next-e2e-token';
const AGENTLESS = '/?room=files&token=next-e2e-token';
const disabledCatalog = { enabled: false, selected: 'none', providers: [] };

// Headless Chromium's fake-device flags don't yield a usable capture here, so the
// mic + WebAudio boundary is faked, emitting level frames on an interval so the
// waveform draws. Everything above it — session, encode, the real transcribe
// endpoint, and posting — runs unchanged.
async function installFakeMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const stream = { getTracks: () => [{ stop() {} }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    class FakeAudioContext {
      sampleRate = 24_000;
      destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const node: { onaudioprocess: ((e: unknown) => void) | null; timer: number; connect: () => void; disconnect: () => void } = {
          onaudioprocess: null,
          timer: 0,
          connect() {
            node.timer = window.setInterval(() => node.onaudioprocess?.({
              inputBuffer: { getChannelData: () => new Float32Array(2_048).fill(0.4) },
            }), 40);
          },
          disconnect() { window.clearInterval(node.timer); },
        };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    Object.assign(window, { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext });
  });
}

async function openRoom(page: Page, room: string = ROOM): Promise<void> {
  await installFakeMedia(page);
  await page.context().grantPermissions(['microphone']);
  await page.goto(room);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

/** Press-and-hold the mic past the long-press threshold, then release (Add). */
async function holdMic(page: Page): Promise<void> {
  const box = await page.getByTestId('composer-mic').boundingBox();
  if (!box) throw new Error('mic control not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450); // past the 350 ms hold threshold
  await page.mouse.up();
}

test.describe('composer dictation (v2.1)', () => {
  test('two takes defer transcription until Send, then post a voice card', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('composer-input').fill('@viewer');

    const transcribeUrls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/voice/transcribe')) transcribeUrls.push(request.url());
    });

    await holdMic(page); // take 1 via hold-to-record
    await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();
    await expect(page.getByTestId('dictation-segment-0')).toBeVisible();

    await page.getByTestId('dictation-record-another').click(); // take 2
    await expect(page.getByTestId('dictation-add')).toBeVisible();
    await page.waitForTimeout(150);
    await page.getByTestId('dictation-add').click();
    await expect(page.getByTestId('dictation-segment-1')).toBeVisible();

    expect(transcribeUrls).toHaveLength(0); // nothing uploaded before Send

    await page.getByTestId('dictation-send').click();
    await expect(page.getByTestId('dictation-waiting')).toBeVisible(); // waveform loader, no counter
    await expect(page.getByTestId('composer-input')).toBeVisible(); // posted, panel closed
    expect(transcribeUrls.length).toBeGreaterThanOrEqual(2); // both takes uploaded on Send

    const card = page.locator('[data-testid^="voice-card-"]').last();
    await expect(card).toBeVisible();
    await expect(card.locator('.nx-miniwave')).toBeVisible();
    await expect(card.locator('.nx-voice-card-duration')).toBeVisible();
    await expect(card).toContainText('dictation'); // the real transcript is the body
    expect(await card.innerText()).not.toContain('🎤'); // no marker glyph in the body
  });

  test('cancel during recording and discard-all post nothing and never upload', async ({ page }) => {
    await openRoom(page, AGENTLESS);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/voice/transcribe')) requests.push(request.url());
    });

    await page.getByTestId('composer-mic').click(); // tap → recording
    await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-cancel').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('composer-mic').click();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-add').click(); // one recorded take
    await page.getByTestId('dictation-discard').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
    await expect(page.locator('[data-testid^="voice-card-"]')).toHaveCount(0);
  });

  // The partial-failure retry path (a failed take keeps the panel open, done
  // takes are never re-uploaded on a second Send) is proven in voice.spec.ts —
  // driving a per-take stub failure through the browser isn't cheaply reachable.

  test('renders no mic when the catalog reports dictation disabled', async ({ page }) => {
    await page.route('**/api/voice/providers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(disabledCatalog) }));
    await openRoom(page);
    await expect(page.getByTestId('composer-mic')).toHaveCount(0);
  });
});

test.describe('composer dictation on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders no mic in the mobile row when dictation is disabled', async ({ page }) => {
    await page.route('**/api/voice/providers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(disabledCatalog) }));
    await openRoom(page);
    await expect(page.getByTestId('composer-mic')).toHaveCount(0);
  });
});
