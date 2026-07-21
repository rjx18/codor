import QRCode from 'qrcode';

// harn:assume terminal-pairing-qr-matches-plain-url ref=terminal-qr-renderer
export function renderTerminalQr(payload: string): string {
  // Low error correction keeps the symbol small for a long pairing URL; the
  // two-module quiet zone preserves reliable scanning.
  const matrix = QRCode.create(payload, { errorCorrectionLevel: 'L' }).modules;
  const quietZone = 2;
  const size = matrix.size + quietZone * 2;
  const dark = (row: number, column: number): boolean => {
    const sourceRow = row - quietZone;
    const sourceColumn = column - quietZone;
    if (sourceRow < 0 || sourceColumn < 0 || sourceRow >= matrix.size || sourceColumn >= matrix.size) {
      return false;
    }
    return matrix.data[sourceRow * matrix.size + sourceColumn] === 1;
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '\u001b[30;47m';
    for (let column = 0; column < size; column += 1) {
      const upper = dark(row, column);
      const lower = dark(row + 1, column);
      line += upper ? (lower ? '█' : '▀') : (lower ? '▄' : ' ');
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join('\n');
}
// harn:end terminal-pairing-qr-matches-plain-url
