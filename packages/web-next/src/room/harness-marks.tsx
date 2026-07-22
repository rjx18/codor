/**
 * Harness marks — each vendor's own vector, rendered in `currentColor`.
 *
 * These are the official shapes taken from each project's published brand assets
 * (Anthropic's press kit, OpenAI's logo pack, OpenCode's brand zip, Cursor's
 * brand kit), reduced to their path data and inlined. Nothing is fetched at
 * runtime; the tiles are drawn in the current text colour so they invert with the
 * theme like the rest of the dialog.
 *
 * Trademark note: these are third-party marks used to identify which harness a
 * tile selects. They are unmodified in shape and monochrome by our own theming.
 * Anthropic's published guidelines ask for prior written approval and prohibit
 * recolouring, so if that matters for a public surface, ask before shipping.
 *
 * An adapter this file does not know renders the generic fallback rather than
 * borrowing someone else's shape.
 */
import { Cat, Cpu, Gauge } from 'lucide-react';
import type { ReactNode } from 'react';

interface HarnessMark {
  label: string;
  mark: (size: number) => ReactNode;
}

const MARKS: Record<string, HarnessMark> = {
  'acp': {
    label: 'ACP-compatible',
    mark: (size: number) => <Cpu width={size} height={size} aria-hidden="true" />,
  },
  // Named ACP providers use neutral product monograms — not a borrowed vendor logo —
  // keyed by their `acp:<provider>` selector id.
  'acp:kimi': {
    label: 'Kimi Code CLI',
    mark: (size: number) => (
      <span className="nx-harness-monogram" style={{ width: size, height: size }} aria-hidden="true">Ki</span>
    ),
  },
  'acp:kilo': {
    label: 'Kilo Code',
    mark: (size: number) => (
      <span className="nx-harness-monogram" style={{ width: size, height: size }} aria-hidden="true">Kl</span>
    ),
  },
  'claude-code': {
    label: 'Claude Code',
    mark: (size: number) => (
      <svg viewBox="0 0 94 94" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z"/></svg>
    ),
  },
  'codex': {
    label: 'Codex',
    // The Blossom's own artboard carries ~50% padding, so at a shared box size it
    // rendered half the weight of every other mark. The viewBox is tightened to
    // its measured ink plus the same optical margin the others carry — the path
    // itself is untouched.
    mark: (size: number) => (
      <svg viewBox="166.30 166.30 383.40 383.40" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z"/></svg>
    ),
  },
  'gemini': {
    label: 'Gemini',
    mark: (size: number) => (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M12 2c0 5.52-4.48 10-10 10 5.52 0 10 4.48 10 10 0-5.52 4.48-10 10-10-5.52 0-10-4.48-10-10Z"/></svg>
    ),
  },
  'antigravity': {
    label: 'Antigravity',
    // Antigravity does not publish a standalone product glyph in this repo;
    // retain main's neutral gauge identity rather than inventing a vendor mark.
    mark: (size: number) => <Gauge width={size} height={size} aria-hidden="true" />,
  },
  'copilot': {
    label: 'GitHub Copilot',
    // A neutral code-assistant identity avoids embedding an unlicensed logo.
    mark: (size: number) => <Cat width={size} height={size} aria-hidden="true" />,
  },
  'opencode': {
    label: 'OpenCode',
    mark: (size: number) => (
      <svg viewBox="0 0 240 300" width={size} height={size} fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true"><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"/></svg>
    ),
  },
  'cursor': {
    label: 'Cursor',
    mark: (size: number) => (
      <svg viewBox="0 0 466.73 532.09" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>
    ),
  },
};

/** The display label for an adapter id, falling back to the id itself. */
export function harnessLabel(id: string): string {
  return MARKS[id]?.label ?? id;
}

/** The mark for an adapter id, falling back to a generic processor glyph. */
export function harnessMark(id: string, size = 22): ReactNode {
  const known = MARKS[id];
  if (known !== undefined) return known.mark(size);
  return <Cpu size={size} aria-hidden="true" />;
}
