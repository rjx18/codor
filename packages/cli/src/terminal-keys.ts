export type SetupKey =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'enter' }
  | { type: 'space' }
  | { type: 'cancel' }
  | { type: 'char'; value: string };

const ESC = '\u001B';
const CTRL_C = '\u0003';
const CSI_FINAL = /[@-~]/;
const CSI_KEYS: Record<string, SetupKey> = {
  A: { type: 'up' },
  B: { type: 'down' },
  C: { type: 'right' },
  D: { type: 'left' },
};

function decodeSingle(character: string): SetupKey {
  if (character === CTRL_C) return { type: 'cancel' };
  if (character === '\r' || character === '\n') return { type: 'enter' };
  if (character === ' ') return { type: 'space' };
  if (character.toLowerCase() === 'q') return { type: 'cancel' };
  return { type: 'char', value: character };
}

// harn:assume setup-terminal-input-survives-chunk-boundaries ref=setup-key-decoder
export class TerminalKeyDecoder {
  private pending = '';

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  decode(chunk: string): SetupKey[] {
    this.pending += chunk;
    const keys: SetupKey[] = [];
    while (this.pending.length > 0) {
      const character = this.pending[0]!;
      if (character !== ESC) {
        keys.push(decodeSingle(character));
        this.pending = this.pending.slice(1);
        continue;
      }
      if (this.pending.length === 1) break;
      if (this.pending[1] !== '[') {
        keys.push({ type: 'cancel' });
        this.pending = this.pending.slice(1);
        continue;
      }
      const finalIndex = this.findCsiFinal();
      if (finalIndex === -1) break;
      const key = CSI_KEYS[this.pending[finalIndex]!];
      if (key !== undefined) keys.push(key);
      this.pending = this.pending.slice(finalIndex + 1);
    }
    return keys;
  }

  flush(): SetupKey[] {
    if (this.pending.length === 0) return [];
    const retained = this.pending;
    this.pending = '';
    return retained.startsWith(ESC) ? [{ type: 'cancel' }] : retained.split('').map(decodeSingle);
  }

  private findCsiFinal(): number {
    for (let index = 2; index < this.pending.length; index += 1) {
      if (CSI_FINAL.test(this.pending[index]!)) return index;
    }
    return -1;
  }
}
// harn:end setup-terminal-input-survives-chunk-boundaries
