export type SetupStageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export const SETUP_STAGE_TITLES = [
  'Check this computer',
  'Install Codor',
  'Where you will use Codor',
  'Start Codor',
  'Create pairing code',
] as const;

export const SETUP_SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸', '⠼',
  '⠴', '⠦', '⠧', '⠇', '⠏',
] as const;
export const MAX_SETUP_STAGE_LOGS = 6;
export const SETUP_CLEAR_SCREEN = '\u001B[H\u001B[J';
export const SETUP_CURSOR_HIDE = '\u001B[?25l';
export const SETUP_CURSOR_SHOW = '\u001B[?25h';

// Codor emblem word art, byte-exact from the fcc66137 attachment (Richard, #503).
export const CODOR_WORD_ART = [
  '                                           ',
  '                                           ',
  '                                    █████████████████            ',
  '                                  █████████████████████          ',
  '                                 ███                 ███         ',
  '                                ███    █             ███         ',
  '                                ███    ███           ███         ',
  '                              ████       ███         ███         ',
  '                             ████        ██          ███         ',
  '                              ████     ██            ███         ',
  '                                ███        ████████  ███         ',
  '                                ███                  ███         ',
  '                                 ███                ███          ',
  '                                   █████████████   ████           ',
  '                                     ██████████   ████                            ',
  '                                                       ',
  '                                                                                              ',
  '                                                       ████                                    ',
  '             █████████                                 ████                                    ',
  '          ███████████████     █████████        ████████████     █████████     ████  ███         ',
  '          ████       ████     █████████      ██████████████     █████████     ████ ████         ',
  '          ████             ████       ████  ████       ████  ████       ████  ███████           ',
  '          ████             ████       ████  ████       ████  ████       ████  ██████            ',
  '          ████             ████       ████  ████      █████  ████       ████  ████              ',
  '          ████       ████  ████       ████  ████     ██████  ████       ████  ████              ',
  '          ███████████████     █████████      ██████████████     █████████     ████              ',
  '             █████████        █████████        ███████ ████     █████████     ████              ',
  '                                                                                              ',
  '                                                                                              ',
  '                                                                                              ',
  '                                                                                               ',
  '                                                                                              ',
  '',
  '',
  '',
].join('\n');

const style = {
  reset: '\u001B[0m',
  bold: (value: string) => `\u001B[1m${value}\u001B[0m`,
  dim: (value: string) => `\u001B[2m${value}\u001B[0m`,
  cyan: (value: string) => `\u001B[36m${value}\u001B[0m`,
  green: (value: string) => `\u001B[32m${value}\u001B[0m`,
  yellow: (value: string) => `\u001B[33m${value}\u001B[0m`,
  red: (value: string) => `\u001B[31m${value}\u001B[0m`,
  gray: (value: string) => `\u001B[90m${value}\u001B[0m`,
};

export interface SetupStage {
  title: string;
  state: SetupStageState;
  logs: string[];
  /** Short muted line shown under the heading while the step is active. */
  description?: string;
  /** Optional note shown after a skipped step's title. */
  summary?: string;
  /** Failure text shown inside the active step when it has failed. */
  error?: string;
}

export interface SetupAccessOption {
  id: string;
  label: string;
  description: string;
  available: boolean;
}

/** A vertical single-select choice. Enter selects the focused option directly;
 *  there is no separate select-then-confirm step. `canBack` drives the menu's
 *  own Back hint, since a live menu supplies its own navigation footer. */
export interface SetupMenu {
  message: string;
  options: SetupAccessOption[];
  focused: number;
  canBack: boolean;
}

export interface SetupSummary {
  /** Headline line — "Codor is ready.", or a paused/running-only variant. */
  headline: string;
  /** The browser endpoint, shown only when the service is actually running. */
  endpoint?: string;
  harnesses: string[];
  nextAction: string;
}

/** Which non-menu navigation actions the active step currently offers. A menu
 *  renders its own navigation hint, so controls are supplied only when the step
 *  is settled: a failure, a reviewed step reached by Back, or the finish. */
export interface SetupControls {
  back: boolean;
  forward: boolean;
  retry: boolean;
  finish: boolean;
}

export interface SetupFrameState {
  version: string;
  byline: string;
  steps: SetupStage[];
  /** Index of the expanded active step. */
  cursor: number;
  spinnerFrame: number;
  viewport: { rows: number; columns: number };
  menu?: SetupMenu;
  controls?: SetupControls;
  summary?: SetupSummary;
  /** Muted "Step N of M" progress label. */
  progress?: { current: number; total: number };
  /** Read-only Check results carried forward as muted context. */
  context?: string[];
  /** A pre-rendered result block (the pairing card) shown in place of the
   *  active step's question. */
  card?: string;
}

export function createSetupStages(): SetupStage[] {
  return SETUP_STAGE_TITLES.map((title) => ({ title, state: 'pending', logs: [] }));
}

function status(state: SetupStageState, frame: number): string {
  if (state === 'running') return style.cyan(`${SETUP_SPINNER_FRAMES[frame % SETUP_SPINNER_FRAMES.length]} working`);
  if (state === 'done') return style.green('done');
  if (state === 'skipped') return style.yellow('skipped');
  if (state === 'failed') return style.red('failed');
  return style.gray('pending');
}

/** A step's result lines in a prominent (non-dim) foreground, so what already
 *  happened stays readable rather than fading into gray. */
function resultLines(logs: string[]): string[] {
  return logs.map((log) => `    ${style.dim('>')} ${log}`);
}


/** The active step's vertical choice: a padded prompt, stacked options with an
 *  unmistakable focused row, and a navigation hint — never crowded onto one
 *  line. */
function menuLines(menu: SetupMenu): string[] {
  // The question uses the one accent color, matching the focused option below.
  // A multiline message (a failure explanation with recovery commands) keeps its
  // first line as the accented prompt and renders the rest at normal contrast,
  // so an actionable error is never buried in dim gray. Copyable recovery
  // commands reuse the same single accent as the question and focused option.
  const [prompt, ...detail] = menu.message.split('\n');
  const lines: string[] = ['', `    ${style.cyan(style.bold(prompt ?? ''))}`,
    ...detail.map((text) => {
      const command = /^(?:sudo\s+tailscale\b|\/.*\btailscale\b.*\bserve\b)/i.test(text.trim());
      return `    ${command ? style.cyan(style.bold(text)) : text}`;
    }), ''];
  menu.options.forEach((option, index) => {
    const focused = index === menu.focused;
    const pointer = focused ? style.cyan('❯') : ' ';
    const label = focused ? style.cyan(style.bold(option.label)) : option.label;
    const availability = option.available ? '' : style.yellow('  (unavailable)');
    lines.push(`    ${pointer} ${label}${availability}`);
    if (option.description.length > 0) lines.push(`      ${style.dim(option.description)}`);
  });
  const hint = ['↑/↓ Move', 'Enter Select'];
  if (menu.canBack) hint.push('← Back');
  lines.push('', `    ${style.dim(hint.join('    '))}`);
  return lines;
}

function controlHints(controls: SetupControls | undefined): string[] {
  if (controls === undefined) return [];
  const parts: string[] = [];
  if (controls.back) parts.push('← Back');
  if (controls.forward) parts.push('→ Forward');
  if (controls.retry) parts.push('r Retry');
  if (controls.finish) parts.push('Enter Finish');
  parts.push('q Cancel');
  return ['', `    ${style.dim(parts.join('    '))}`];
}

/** The expanded active step. Title, menu, error and controls are essential and
 *  always kept; the rolling result lines are clamped to whatever budget remains
 *  so the actionable choice survives on a small terminal. */
function activeBlock(index: number, step: SetupStage, state: SetupFrameState, maxLines: number): string[] {
  const title = `${style.cyan(`(${String(index + 1)})`)} ${style.bold(step.title)}  ${status(step.state, state.spinnerFrame)}`;
  // A short muted description sits directly under the heading.
  const descriptionLines = step.description !== undefined ? [`    ${style.dim(step.description)}`] : [];
  const menu = state.menu !== undefined ? menuLines(state.menu) : [];
  const errorLines = step.error !== undefined ? ['', `    ${style.red(step.error)}`] : [];
  // A live menu supplies its own navigation footer; controls are for settled steps.
  const hintLines = state.menu !== undefined ? [] : controlHints(state.controls);
  const essential = 1 + descriptionLines.length + menu.length + errorLines.length + hintLines.length;
  const logRoom = Math.max(0, Math.min(MAX_SETUP_STAGE_LOGS, maxLines - essential));
  const logs = logRoom <= 0 ? [] : resultLines(step.logs.slice(-logRoom));
  return [title, ...descriptionLines, ...logs, ...menu, ...errorLines, ...hintLines];
}

function summaryLines(summary: SetupSummary | undefined): string[] {
  if (summary === undefined) return [];
  const lines = ['', style.bold(style.green(summary.headline))];
  if (summary.endpoint !== undefined) lines.push(`Open ${style.cyan(summary.endpoint)}`);
  lines.push(summary.harnesses.length > 0
    ? `Detected ${summary.harnesses.join(', ')}`
    : 'No supported coding agents detected on PATH');
  lines.push(summary.nextAction);
  return lines;
}

// harn:assume setup-renders-single-active-step-installer ref=setup-frame-renderer
export function renderSetupFrame(state: SetupFrameState): string {
  const budget = Math.max(1, state.viewport.rows - 1);
  const emit = (lines: string[]): string =>
    `${SETUP_CLEAR_SCREEN}${lines.slice(0, budget).map((line) => truncateAnsi(line, state.viewport.columns)).join('\n')}\n`;

  // A compact header: version/byline and a muted "Step N of M" label. No word art.
  const top: string[] = [style.dim(`v${state.version} - ${state.byline}`)];
  if (state.progress !== undefined) {
    top.push(style.dim(`Step ${String(state.progress.current)} of ${String(state.progress.total)}`));
  }
  const contextLines = (state.context ?? []).length > 0
    ? ['', ...state.context!.map((line) => `  ${style.dim(line)}`)]
    : [];
  const active = state.steps[state.cursor];

  // When the active step supplies a result block (the pairing card), its question
  // is replaced in-frame by that block, split into real lines so each is
  // truncated independently. The Finish control is always reserved; the Check
  // context is dropped before any card content.
  if (active !== undefined && state.card !== undefined) {
    // Only the title — the card carries its own instruction, so the step
    // description is dropped to reserve rows for the code, URL, and expiry.
    const heading = [`${style.cyan(`(${String(state.cursor + 1)})`)} ${style.bold(active.title)}`];
    const controls = controlHints(state.controls);
    const cardLines = state.card.split('\n');
    const overhead = top.length + 1 + heading.length + controls.length; // + a blank before the heading
    const shownCard = cardLines.slice(0, Math.max(0, budget - overhead));
    const leftover = budget - overhead - shownCard.length;
    const context = leftover > 1 ? contextLines.slice(0, leftover) : [];
    return emit([...top, ...context, '', ...heading, ...shownCard, ...controls]);
  }

  const header = [...top, ...contextLines, ''];
  const stepLines = active === undefined ? [] : activeBlock(state.cursor, active, state, Math.max(1, budget - header.length));
  return emit([...header, ...stepLines, ...summaryLines(state.summary)]);
}
// harn:end setup-renders-single-active-step-installer

function truncateAnsi(line: string, columns: number): string {
  if (columns <= 0) return '';
  let visible = 0;
  let result = '';
  for (let index = 0; index < line.length;) {
    if (line[index] === '\u001B' && line[index + 1] === '[') {
      const match = line.slice(index).match(/^\u001B\[[0-?]*[ -/]*[@-~]/);
      if (match !== null) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (line[index] === '' && line[index + 1] === ']') {
      // OSC ... terminated by BEL or ST (ESC \); a hyperlink counts as zero columns.
      const match = line.slice(index).match(/^\][\s\S]*?(?:|\\)/);
      if (match !== null) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (visible >= columns) break;
    const point = String.fromCodePoint(line.codePointAt(index)!);
    result += point;
    index += point.length;
    visible += 1;
  }
  return `${result}${style.reset}`;
}

export interface PairingCardData {
  code: string;
  url: string;
  expires: string;
  qr: string;
  instruction: string;
  /** Whether the URL was copied to the clipboard, so the card can tell the truth
   *  about it. Undefined/false renders the "copy the link below" fallback. */
  copied?: boolean;
}

function wrapText(text: string, width: number): string[] {
  const chars = [...text];
  if (width <= 0 || chars.length <= width) return [text];
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += width) out.push(chars.slice(index, index + width).join(''));
  return out;
}

/** Wrap visible text in an OSC 8 terminal hyperlink to `url`. The link markers
 *  carry zero visible width (see truncateAnsi), so a wrapped URL segment can be
 *  made clickable without changing its column count. */
function osc8(url: string, text: string): string {
  return `]8;;${url}${text}]8;;`;
}

// harn:assume setup-verifies-codor-before-creating-pairing-code ref=setup-pairing-card
/** The final pairing result: a width- and height-aware bordered card. The URL
 *  and instruction wrap inside the border, every rendered line stays within the
 *  terminal width, and the QR is shown with padding only when it fits the width
 *  AND the available rows — otherwise it is omitted while the code, wrapped URL,
 *  expiry, and instruction remain. Built only from the offer, so the raw
 *  authority token can never be shown. */
export function renderPairingCard(card: PairingCardData, columns = 80, maxRows = Number.POSITIVE_INFINITY): string {
  const margin = '    ';
  const box = Math.max(16, columns - margin.length); // outer box width
  const inner = box - 4; // content width inside "│ … │"
  const label = (name: string): string => `${name}${' '.repeat(Math.max(1, 9 - name.length))}`;

  // A compact bordered card: code, wrapped URL, and expiry, no inner padding so a
  // long URL still fits a short terminal. Each wrapped URL segment is an OSC 8
  // hyperlink to the complete URL, so the whole link is clickable in the box while
  // its visible text stays the URL (copyable and width-measured on the plain text).
  const content: Array<{ plain: string; rendered: string }> = [];
  content.push({ plain: `${label('Code')}${card.code}`, rendered: `${style.gray(label('Code'))}${style.cyan(style.bold(card.code))}` });
  wrapText(card.url, Math.max(1, inner - 9)).forEach((chunk, index) => {
    const prefix = index === 0 ? label('Open') : ' '.repeat(9);
    content.push({ plain: `${prefix}${chunk}`, rendered: `${style.gray(prefix)}${osc8(card.url, style.cyan(chunk))}` });
  });
  content.push({ plain: `${label('Expires')}${card.expires}`, rendered: `${style.gray(label('Expires'))}${style.yellow(card.expires)}` });

  const border = (left: string, right: string): string => style.dim(`${left}${'─'.repeat(inner + 2)}${right}`);
  const line = (entry: { plain: string; rendered: string }): string =>
    `${style.dim('│')} ${entry.rendered}${' '.repeat(Math.max(0, inner - [...entry.plain].length))} ${style.dim('│')}`;
  const boxLines = [border('╭', '╮'), ...content.map(line), border('╰', '╯')];
  const instructionLines = wrapText(card.instruction, box).map((chunk) => `${margin}${style.dim(chunk)}`);

  // A muted status line above the box tells the operator the truth: the link was
  // copied to the clipboard, or they should copy the link (in the box) below it.
  const status = card.copied === true ? 'Pairing link copied to clipboard.' : 'Copy the pairing link below.';
  const statusLines = wrapText(status, box).map((chunk) => `${margin}${style.dim(chunk)}`);

  // The body (status, code, URL, expiry, instruction) is always kept.
  const body = [...statusLines, ...boxLines.map((boxLine) => `${margin}${boxLine}`), ...instructionLines];

  // The QR is shown below the body only when it fits the terminal width AND the
  // available rows; otherwise it is omitted and the body still carries the pairing.
  const qrLines = card.qr.split('\n');
  const qrWidth = Math.max(0, ...qrLines.map((qrLine) => [...qrLine].length));
  const qrBlock = qrWidth > 0 && qrWidth + margin.length <= columns
    ? ['', ...qrLines.map((qrLine) => `${margin}${qrLine}`)]
    : [];
  const withQr = [...body, ...qrBlock];
  return (qrBlock.length > 0 && withQr.length <= maxRows ? withQr : body).join('\n');
}
// harn:end setup-verifies-codor-before-creating-pairing-code
