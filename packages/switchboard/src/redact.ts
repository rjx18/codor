// harn:assume redaction-before-fanout ref=redaction-projection
/**
 * Redaction projection (PRIVACY): applied to every body/event payload BEFORE
 * it is serialized into a WS frame or REST response. Raw content stays in
 * the store and in the blobs on disk — redaction is a serving-side
 * projection, gated per room by `config.redaction_enabled`.
 */

const PATTERNS: RegExp[] = [
  // harn:assume pairing-codes-redacted-from-content ref=pairing-code-redaction
  // Pairing codes, in display form and in labeled form.
  //
  // Both patterns reject a candidate that is adjacent to a word character or a
  // hyphen. `\b` does NOT: a hyphen is a non-word character, so `\b[X]{4}-[X]{4}\b`
  // matches the middle groups of a UUID (`…-9fd8-48d3-…`), and ids are what
  // clients use to correlate runs and address deliveries. The bare display form
  // additionally requires the canonical uppercase that `formatPairingCode` emits,
  // because case-insensitively it also matches ordinary hyphenated prose
  // ("self-help", "well-kept"). A code carrying a label is redacted in any case.
  /(?<![\w-])[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}(?![\w-])/g,
  /\b(?:pairing[ _-]?)?code\s*[:=]\s*["']?[23456789A-HJ-NP-Z]{4}-?[23456789A-HJ-NP-Z]{4}["']?(?![\w-])/gi,
  // harn:end pairing-codes-redacted-from-content
  // AWS access key ids
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  // Bearer tokens (authorization headers pasted into logs)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // OpenAI/Anthropic-style secret keys
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Generic KEY=value with a high-entropy-looking value
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=("[^"]{12,}"|'[^']{12,}'|[^\s"']{12,})/g,
];

export const REDACTED = '[redacted]';

export function redactText(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // KEY=value keeps the key name for debuggability
      if (typeof groups[0] === 'string' && match.includes('=')) {
        return `${groups[0]}=${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/** Deep-redacts every string in a JSON-serializable value. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
// harn:end redaction-before-fanout
