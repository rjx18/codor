export type SetupStageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export const SETUP_STAGE_TITLES = [
  'Check this computer',
  'Prepare private files',
  'Choose access',
  'Start Codor',
  'Create pairing code',
] as const;

export const SETUP_SPINNER_FRAMES = [
  '\u280B', '\u2819', '\u2839', '\u2838', '\u283C',
  '\u2834', '\u2826', '\u2827', '\u2807', '\u280F',
] as const;
export const MAX_SETUP_STAGE_LOGS = 4;
export const SETUP_CLEAR_SCREEN = '\u001B[H\u001B[J';
export const SETUP_CURSOR_HIDE = '\u001B[?25l';
export const SETUP_CURSOR_SHOW = '\u001B[?25h';

// Codor emblem word art, byte-exact from the codor-art.txt attachment (Richard, #436).
export const CODOR_WORD_ART = [
  '                                           ',
  '                                           ',
  '                █████████████████            ',
  '              █████████████████████          ',
  '             ███                 ███         ',
  '            ███    █             ███         ',
  '            ███    ███           ███         ',
  '          ████       ███         ███         ',
  '         ████        ██          ███         ',
  '          ████     ██            ███         ',
  '            ███        ████████  ███         ',
  '            ███                  ███         ',
  '             ███                ███          ',
  '              █████████████   ████           ',
  '               ██████████   ████                             ',
  '',
  '',
  '   █████████               █████                   ',
  '  ███░░░░░███             ░░███                    ',
  ' ███     ░░░   ██████   ███████   ██████  ████████ ',
  '░███          ███░░███ ███░░███  ███░░███░░███░░███',
  '░███         ░███ ░███░███ ░███ ░███ ░███ ░███ ░░░ ',
  '░░███     ███░███ ░███░███ ░███ ░███ ░███ ░███     ',
  ' ░░█████████ ░░██████ ░░████████░░██████  █████    ',
  '  ░░░░░░░░░   ░░░░░░   ░░░░░░░░  ░░░░░░  ░░░░░     ',
  '                                                   ',
  '                                                   ',
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
  /** One-line recap shown when the step is collapsed after completion. */
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

export interface SetupMenu {
  message: string;
  options: SetupAccessOption[];
  focused: number;
  selected?: string;
}

export interface SetupSummary {
  endpoint: string;
  harnesses: string[];
  nextAction: string;
}

/** Which navigation actions the active step currently offers. */
export interface SetupControls {
  back: boolean;
  next: boolean;
  retry: boolean;
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

function menuLines(menu: SetupMenu): string[] {
  const lines = [
    style.dim(menu.message),
    style.dim('Use \u2191/\u2193 to move, Space to select, Enter to continue, q to cancel.'),
    '',
  ];
  for (const [index, option] of menu.options.entries()) {
    const pointer = index === menu.focused ? style.cyan('\u276F') : ' ';
    const chosen = menu.selected === option.id ? style.green('\u25C9') : style.gray('\u25CB');
    const availability = option.available ? style.dim(' detected') : style.yellow(' unavailable');
    lines.push(`${pointer} ${chosen} ${style.bold(option.label)}${availability}`);
    lines.push(`  ${style.dim(option.description)}`);
  }
  return lines.map((line) => `    ${line}`);
}

function truncateAnsi(line: string, columns: number): string {
  if (columns <= 0) return '';
  let visible = 0;
  let result = '';
  for (let index = 0; index < line.length && visible < columns;) {
    if (line[index] === '\u001B' && line[index + 1] === '[') {
      const match = line.slice(index).match(/^\u001B\[[0-?]*[ -/]*[@-~]/);
      if (match !== null) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    const point = String.fromCodePoint(line.codePointAt(index)!);
    result += point;
    index += point.length;
    visible += 1;
  }
  return `${result}${style.reset}`;
}

/** A completed or future step, collapsed to a single line. */
function collapsedLine(index: number, step: SetupStage): string {
  if (step.state === 'done') {
    const head = `${style.green('✓')} ${style.dim(`(${String(index + 1)})`)} ${step.title}`;
    return step.summary !== undefined ? `${head} ${style.dim(`— ${step.summary}`)}` : head;
  }
  if (step.state === 'skipped') {
    return `${style.yellow('◦')} ${style.dim(`(${String(index + 1)}) ${step.title} — skipped`)}`;
  }
  return style.dim(`  (${String(index + 1)}) ${step.title}`);
}

function controlHints(controls: SetupControls | undefined): string | undefined {
  if (controls === undefined) return undefined;
  const parts: string[] = [];
  if (controls.back) parts.push('← Back');
  if (controls.retry) parts.push('r Retry');
  if (controls.next) parts.push('Enter/→ Next');
  parts.push('q Cancel');
  return `    ${style.dim(parts.join('   '))}`;
}

/** The expanded active step. Its title, menu, error and controls are the
 *  essential parts kept visible; the rolling logs are clamped to whatever line
 *  budget remains so the actionable content survives on a small terminal. */
function activeBlock(index: number, step: SetupStage, state: SetupFrameState, maxLines: number): string[] {
  const title = `${style.cyan(`(${String(index + 1)})`)} ${style.bold(step.title)}  ${status(step.state, state.spinnerFrame)}`;
  const menu = state.menu !== undefined ? menuLines(state.menu) : [];
  const errorLines = step.error !== undefined ? ['', `    ${style.red(step.error)}`] : [];
  const hints = controlHints(state.controls);
  const hintLines = hints !== undefined ? ['', hints] : [];
  const essential = 1 + menu.length + errorLines.length + hintLines.length;
  const logRoom = Math.max(0, Math.min(MAX_SETUP_STAGE_LOGS, maxLines - essential));
  const logs = logRoom <= 0 ? [] : step.logs.slice(-logRoom).map((log) => `    ${style.dim(`> ${log}`)}`);
  return [title, ...logs, ...menu, ...errorLines, ...hintLines];
}

function summaryLines(summary: SetupSummary | undefined): string[] {
  if (summary === undefined) return [];
  return [
    '',
    style.green('Codor is ready.'),
    `Open ${style.cyan(summary.endpoint)}`,
    summary.harnesses.length > 0
      ? `Detected ${summary.harnesses.join(', ')}`
      : 'No supported coding agents detected on PATH',
    summary.nextAction,
  ];
}

// harn:assume setup-renders-accordion-wizard-from-state ref=setup-frame-renderer
export function renderSetupFrame(state: SetupFrameState): string {
  const budget = Math.max(1, state.viewport.rows - 1);
  const version = style.dim(`v${state.version} - ${state.byline}`);
  const fullHeader = [...CODOR_WORD_ART.split('\n').map(style.cyan), version, ''];
  const compactHeader = [version, ''];

  const before: string[] = [];
  const after: string[] = [];
  for (const [index, step] of state.steps.entries()) {
    if (index === state.cursor) continue;
    (index < state.cursor ? before : after).push(collapsedLine(index, step));
  }
  const tail = summaryLines(state.summary);

  // The active block and the closing summary are always kept; collapsed context
  // fills whatever budget remains, dropping the rows farthest from the cursor.
  const assemble = (header: string[]): string[] => {
    const activeMax = Math.max(1, budget - header.length - tail.length);
    const active = state.steps[state.cursor] === undefined
      ? []
      : activeBlock(state.cursor, state.steps[state.cursor]!, state, activeMax);
    let room = budget - header.length - active.length - tail.length;
    const shownBefore = room > 0 ? before.slice(Math.max(0, before.length - room)) : [];
    room -= shownBefore.length;
    const shownAfter = room > 0 ? after.slice(0, room) : [];
    return [...header, ...shownBefore, ...active, ...shownAfter, ...tail];
  };

  const full = assemble(fullHeader);
  const lines = (full.length <= budget ? full : assemble(compactHeader))
    .slice(0, budget)
    .map((line) => truncateAnsi(line, state.viewport.columns));
  return `${SETUP_CLEAR_SCREEN}${lines.join('\n')}\n`;
}
// harn:end setup-renders-accordion-wizard-from-state
