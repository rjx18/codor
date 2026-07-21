import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';

import { renderTerminalQr } from './terminal-qr.js';

const URL = 'https://host.tail-abc.ts.net/pair?endpoint=https%3A%2F%2Fhost.tail-abc.ts.net&pairing_token=YrBG41M28KVjYaR05P7Zb7HcykxA-3pPGa18bPCXvoo&switchboard_sign_pub=XV5Tvp6uechAVjeX_Okb-SKSR8UunmvFTOzTxL_rLNw';

const visibleWidth = (line: string): number => [...line.replace(/\u001B\[[0-9;]*m/g, '')].length;

// harn:assume terminal-pairing-qr-matches-plain-url ref=terminal-qr-renderer-regression
describe('renderTerminalQr', () => {
  it('renders the error-correction-L encoding of the identical pairing URL', () => {
    const expected = QRCode.create(URL, { errorCorrectionLevel: 'L' }).modules;
    const qr = renderTerminalQr(URL);
    // Every row is the module size plus a two-module quiet zone on each side.
    const widths = new Set(qr.split('\n').map(visibleWidth));
    expect(widths).toEqual(new Set([expected.size + 4]));
  });

  it('produces a smaller symbol at L than at M for the same URL', () => {
    const l = QRCode.create(URL, { errorCorrectionLevel: 'L' }).modules.size;
    const m = QRCode.create(URL, { errorCorrectionLevel: 'M' }).modules.size;
    expect(l).toBeLessThan(m);
  });
});
// harn:end terminal-pairing-qr-matches-plain-url
