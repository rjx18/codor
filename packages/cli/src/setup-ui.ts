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

const BLOCK = '\u2588';
const GLYPHS: Record<string, string[]> = {
  C: [' #### ', '##    ', '##    ', '##    ', ' #### '],
  O: [' #### ', '##  ##', '##  ##', '##  ##', ' #### '],
  D: ['##### ', '##  ##', '##  ##', '##  ##', '##### '],
  R: ['##### ', '##  ##', '##### ', '##  ##', '##  ##'],
};

export const CODOR_WORD_ART = [0, 1, 2, 3, 4]
  .map((row) => [...'CODOR'].map((letter) => GLYPHS[letter]![row]!).join(''))
  .join('\n')
  .replaceAll('#', BLOCK);

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

export interface SetupFrameState {
  version: string;
  byline: string;
  title: string;
  stages: SetupStage[];
  spinnerFrame: number;
  viewport: { rows: number; columns: number };
  menu?: SetupMenu;
  summary?: SetupSummary;
  failure?: string;
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

// harn:assume setup-renders-five-stage-interactive-session ref=setup-frame-renderer
export function renderSetupFrame(state: SetupFrameState): string {
  const budget = Math.max(1, state.viewport.rows - 1);
  const version = style.dim(`v${state.version} - ${state.byline}`);
  const fullHeader = [
    ...CODOR_WORD_ART.split('\n').map(style.cyan),
    version,
    '',
    style.bold(state.title),
    '',
  ];
  const compactHeader = [version, ''];
  const priority: string[] = [];
  if (state.menu !== undefined) priority.push(...menuLines(state.menu));
  if (state.failure !== undefined) priority.push('', style.red(state.failure));
  if (state.summary !== undefined) {
    priority.push(
      '',
      style.green('Codor is ready.'),
      `Open ${style.cyan(state.summary.endpoint)}`,
      state.summary.harnesses.length > 0
        ? `Detected ${state.summary.harnesses.join(', ')}`
        : 'No supported coding agents detected on PATH',
      state.summary.nextAction,
    );
  }

  const header = fullHeader.length + state.stages.length + priority.length <= budget
    ? fullHeader
    : compactHeader;
  const stageBudget = Math.max(0, budget - header.length - priority.length);
  const stageLines: string[] = [];
  let remaining = stageBudget;
  for (const [index, stage] of state.stages.entries()) {
    if (remaining <= 0) break;
    stageLines.push(`${style.cyan(`[${String(index + 1)}]`)} ${stage.title}  ${status(stage.state, state.spinnerFrame)}`);
    remaining -= 1;
    const logs = stage.logs.slice(-Math.min(MAX_SETUP_STAGE_LOGS, remaining));
    for (const log of logs) stageLines.push(`    ${style.dim(`> ${log}`)}`);
    remaining -= logs.length;
  }

  const lines = [...header, ...stageLines, ...priority]
    .slice(0, budget)
    .map((line) => truncateAnsi(line, state.viewport.columns));
  return `${SETUP_CLEAR_SCREEN}${lines.join('\n')}\n`;
}
// harn:end setup-renders-five-stage-interactive-session
