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

/** A completed step: a green check, a bold title, and its full results kept
 *  visible — never collapsed to a one-line summary. */
function completedBlock(index: number, step: SetupStage): string[] {
  const title = `${style.green('✓')} ${style.dim(`(${String(index + 1)})`)} ${style.bold(step.title)}`;
  return [title, ...resultLines(step.logs)];
}

function skippedBlock(index: number, step: SetupStage): string[] {
  const note = step.summary !== undefined ? ` ${step.summary}` : '';
  return [`${style.yellow('◦')} ${style.dim(`(${String(index + 1)})`)} ${style.bold(step.title)} ${style.dim(`— skipped${note}`)}`];
}

function futureLine(index: number, step: SetupStage): string {
  return style.dim(`  (${String(index + 1)}) ${step.title}`);
}

/** The active step's vertical choice: a padded prompt, stacked options with an
 *  unmistakable focused row, and a navigation hint — never crowded onto one
 *  line. */
function menuLines(menu: SetupMenu): string[] {
  // The question uses the one accent color, matching the focused option below.
  const lines: string[] = ['', `    ${style.cyan(style.bold(menu.message))}`, ''];
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

// harn:assume setup-renders-progressive-wizard-with-visible-results ref=setup-frame-renderer
export function renderSetupFrame(state: SetupFrameState): string {
  const budget = Math.max(1, state.viewport.rows - 1);
  const version = style.dim(`v${state.version} - ${state.byline}`);
  const fullHeader = [...CODOR_WORD_ART.split('\n').map(style.cyan), version, ''];
  const compactHeader = [version, ''];

  // Completed and skipped steps stay visible above the cursor, each separated by
  // a blank line; future steps collapse to a numbered title below it.
  const beforeLines: string[] = [];
  const after: string[] = [];
  for (const [index, step] of state.steps.entries()) {
    if (index === state.cursor) continue;
    if (index < state.cursor) {
      const block = step.state === 'skipped' ? skippedBlock(index, step) : completedBlock(index, step);
      beforeLines.push(...block, '');
    } else {
      after.push(futureLine(index, step));
    }
  }
  const tail = summaryLines(state.summary);

  // The active block and closing summary are always kept; completed context
  // fills whatever budget remains, dropping the rows farthest above the cursor.
  const assemble = (header: string[]): string[] => {
    const activeMax = Math.max(1, budget - header.length - tail.length);
    const active = state.steps[state.cursor] === undefined
      ? []
      : ['', ...activeBlock(state.cursor, state.steps[state.cursor]!, state, activeMax)];
    let room = budget - header.length - active.length - tail.length;
    const shownBefore = room > 0 ? beforeLines.slice(Math.max(0, beforeLines.length - room)) : [];
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
// harn:end setup-renders-progressive-wizard-with-visible-results

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
