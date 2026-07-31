// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DictationSession,
  downsampleLevels,
  encodeWav,
  fetchVoiceProviders,
  formatElapsed,
  perceptualLevel,
  startRecording,
  transcribeVoice,
  VOICE_SAMPLE_RATE,
  type DictationTake,
  type DictationTimers,
  type StartRecording,
} from './voice.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function wavHeader(bytes: Uint8Array): {
  riff: string; wave: string; format: number; channels: number; sampleRate: number; bits: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  return {
    riff: tag(0),
    wave: tag(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
  };
}

describe('encodeWav', () => {
  it('writes a 24 kHz mono PCM16 RIFF/WAVE header', () => {
    const out = encodeWav(new Float32Array(24_000).fill(0.1), VOICE_SAMPLE_RATE);
    expect(wavHeader(out)).toEqual({
      riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, sampleRate: 24_000, bits: 16,
    });
  });

  it('resamples 48 kHz capture down to ~24 kHz mono', () => {
    const out = encodeWav(new Float32Array(48_000).fill(0), 48_000);
    const frames = (out.length - 44) / 2;
    expect(frames).toBe(24_000);
    expect(wavHeader(out).sampleRate).toBe(24_000);
  });
});

describe('formatElapsed', () => {
  it('formats seconds as m:ss', () => {
    expect(formatElapsed(5)).toBe('0:05');
    expect(formatElapsed(72)).toBe('1:12');
  });
});

describe('voice REST client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extracts the server error message on a failed transcription', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false, status: 502, json: () => Promise.resolve({ error: 'run `codex login`' }),
    } as unknown as Response));
    await expect(transcribeVoice('t', new Uint8Array([1]))).rejects.toThrow('run `codex login`');
  });

  it('falls back to a status message when the body has no error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false, status: 503, json: () => Promise.reject(new Error('no body')),
    } as unknown as Response));
    await expect(transcribeVoice('t', new Uint8Array([1]))).rejects.toThrow('503');
  });

  it('returns the catalog on success', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ enabled: true, selected: 'codex', providers: [] }),
    } as unknown as Response));
    await expect(fetchVoiceProviders('t')).resolves.toEqual({ enabled: true, selected: 'codex', providers: [] });
  });
});

describe('capture level stream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('emits the RMS of each capture buffer to onLevel', async () => {
    let node: { onaudioprocess: ((e: unknown) => void) | null; connect: () => void; disconnect: () => void } | undefined;
    const context = {
      sampleRate: 24_000,
      destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => {
        node = { onaudioprocess: null, connect() {}, disconnect() {} };
        return node;
      },
      close: () => Promise.resolve(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) },
    });
    vi.stubGlobal('AudioContext', function AudioContextMock() { return context; });

    const levels: number[] = [];
    await startRecording((level) => levels.push(level));
    const emit = (data: number[]) =>
      node?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(data) } });

    emit([0, 0, 0, 0]); // silence → 0
    emit(new Array(64).fill(0.03)); // quiet speech → a mid bar
    emit([1, 1]); // loud → clamps to the ceiling
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(0.2);
    expect(levels[1]).toBeLessThan(0.9);
    expect(levels[2]).toBe(1);
  });
});

describe('perceptualLevel', () => {
  it('maps silence to 0, quiet speech to a mid bar, and loud to the ceiling', () => {
    expect(perceptualLevel(0)).toBe(0);
    const quiet = perceptualLevel(0.03);
    expect(quiet).toBeGreaterThan(0.2);
    expect(quiet).toBeLessThan(0.9);
    expect(perceptualLevel(0.5)).toBe(1); // the gain pushes even 0.5 rms to full
  });

  it('is monotonic in the audible range', () => {
    expect(perceptualLevel(0.02)).toBeLessThan(perceptualLevel(0.05));
    expect(perceptualLevel(0.05)).toBeLessThan(perceptualLevel(0.1));
  });
});

describe('downsampleLevels', () => {
  it('returns the input unchanged when it is within the cap', () => {
    expect(downsampleLevels([10, 20, 30], 48)).toEqual([10, 20, 30]);
  });

  it('peak-downsamples to at most the cap, order preserved', () => {
    const ramp = Array.from({ length: 200 }, (_, i) => i);
    const out = downsampleLevels(ramp, 48);
    expect(out.length).toBe(48);
    expect(out[47]).toBe(199); // last bucket keeps the peak
    for (let i = 1; i < out.length; i += 1) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
  });
});

describe('DictationSession', () => {
  const noopTimers: DictationTimers = { set: () => 0, clear: () => {} };
  const fakeStart: StartRecording = async () => ({
    async stop() { return new Uint8Array([1, 2]); },
    cancel() {},
  });

  const makeSession = (
    transcribe: (wav: Uint8Array) => Promise<string>,
    startRecording?: StartRecording,
  ) => {
    let takes: DictationTake[] = [];
    const session = new DictationSession({
      transcribe,
      startRecording: startRecording ?? fakeStart,
      onChange: (next) => { takes = next; },
      timers: noopTimers,
      now: () => 0,
    });
    return { session, takes: () => takes };
  };

  const record = async (session: DictationSession): Promise<void> => {
    await session.startTake();
    await session.addTake();
  };

  it('records takes without uploading anything until Send', async () => {
    const transcribe = vi.fn(async () => 'text');
    const { session, takes } = makeSession(transcribe);
    await record(session);
    await record(session);
    expect(transcribe).not.toHaveBeenCalled();
    expect(takes().map((t) => t.state)).toEqual(['recorded', 'recorded']);

    await session.sendWhenReady();
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('uploads serially on Send and resolves texts in take order', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let n = 0;
    const transcribe = vi.fn(async () => { n += 1; return n === 1 ? d1.promise : d2.promise; });
    const { session } = makeSession(transcribe);
    await record(session);
    await record(session);

    const sent = session.sendWhenReady();
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1); // second waits for the first
    d1.resolve('alpha');
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(2);
    d2.resolve('beta');
    await expect(sent).resolves.toEqual(['alpha', 'beta']);
  });

  it('keeps a done take and re-uploads only the failed one on a retry Send', async () => {
    let n = 0;
    const transcribe = vi.fn(async () => { n += 1; if (n === 1) return 'kept'; throw new Error('boom'); });
    const { session, takes } = makeSession(transcribe);
    await record(session);
    await record(session);

    await expect(session.sendWhenReady()).rejects.toThrow(/could not be transcribed/);
    expect(takes()[0]).toMatchObject({ state: 'done', text: 'kept' });
    expect(takes()[1]!.state).toBe('failed');
    expect(transcribe).toHaveBeenCalledTimes(2);

    transcribe.mockImplementation(async () => 'recovered');
    await expect(session.sendWhenReady()).resolves.toEqual(['kept', 'recovered']);
    expect(transcribe).toHaveBeenCalledTimes(3); // only the failed take re-uploaded
  });

  it('marks an empty transcript as a failed take on Send', async () => {
    const { session, takes } = makeSession(async () => '   ');
    await record(session);
    await expect(session.sendWhenReady()).rejects.toThrow();
    expect(takes()[0]).toMatchObject({ state: 'failed', error: 'Nothing was transcribed' });
  });

  it('keeps earlier recorded takes while a new one records', async () => {
    const { session, takes } = makeSession(async () => 'x');
    await record(session);
    await session.startTake();
    expect(takes().map((t) => t.state)).toEqual(['recorded', 'recording']);
  });

  it('stores a downsampled 0..100 level envelope on a recorded take', async () => {
    const noisyStart: StartRecording = async (onLevel) => {
      for (let i = 0; i < 100; i += 1) onLevel?.(0.5);
      return { async stop() { return new Uint8Array([1]); }, cancel() {} };
    };
    const { session, takes } = makeSession(async () => 'x', noisyStart);
    await record(session);
    const take = takes()[0]!;
    expect(take.state).toBe('recorded');
    expect(take.levels.length).toBeLessThanOrEqual(48);
    expect(take.levels.every((l) => Number.isInteger(l) && l >= 0 && l <= 100)).toBe(true);
    expect(take.levels[0]).toBe(50); // 0.5 → round(0.5 × 100)
  });

  it('discardAll abandons an in-flight Send and drops every take', async () => {
    const d1 = deferred<string>();
    const { session, takes } = makeSession(async () => d1.promise);
    await record(session);
    const sent = session.sendWhenReady();
    await flush();
    session.discardAll();
    d1.resolve('too late');
    await expect(sent).rejects.toThrow(/discarded/);
    expect(takes()).toEqual([]);
  });

  it('removeTake drops the take and its audio', async () => {
    const { session, takes } = makeSession(async () => 'x');
    await record(session);
    session.removeTake(takes()[0]!.id);
    expect(takes()).toEqual([]);
  });

  it('cancelTake discards the in-progress recording without recording it', async () => {
    const transcribe = vi.fn(async () => 'unused');
    const { session, takes } = makeSession(transcribe);
    await session.startTake();
    session.cancelTake();
    expect(takes()).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
