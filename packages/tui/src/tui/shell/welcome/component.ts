import type { Component } from '../../rendering/component.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import type { TuiShellState } from '../contracts.js';
import {
  fitLine,
  normalizeWidth,
  renderFrameBottom,
  renderFrameDivider,
  renderFrameHeader,
  renderFrameRow,
} from '../frame.js';
import { resolveTuiLayoutPolicy } from '../layout-policy.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from '../keybindings.js';
import {
  MINIMAX_CODE_WELCOME_DESIGN,
  MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT,
} from './design.js';
import { renderTuiWelcomeHero } from './hero.js';

export interface TuiWelcomeContent {
  readonly tips?: readonly string[];
  readonly changelogEntries?: readonly string[];
}

export class TuiWelcome implements Component {
  constructor(
    private state: TuiShellState,
    private readonly keybindings?: TuiKeybindingRegistry,
    private readonly content: TuiWelcomeContent = {},
  ) {}

  setState(state: TuiShellState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, Number.POSITIVE_INFINITY);
  }

  renderViewport(width: number, height: number): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    if (safeWidth < 4) return [fitLine('M', safeWidth)];

    const policy = resolveTuiLayoutPolicy(safeWidth);
    let frame =
      policy.welcome === 'compact'
        ? renderCompactWelcome(this.state, safeWidth, this.keybindings, this.content)
        : policy.welcome === 'stacked'
          ? renderStackedWelcome(this.state, safeWidth, this.keybindings, this.content)
          : renderWideWelcome(this.state, safeWidth, this.keybindings, this.content);
    if (frame.length + 2 > height && policy.welcome !== 'compact') {
      frame = renderCompactWelcome(this.state, safeWidth, this.keybindings, this.content);
    }
    return fitWelcomeHeight(['', ...frame, ''], height);
  }
}

function fitWelcomeHeight(lines: string[], height: number): string[] {
  if (!Number.isFinite(height)) return lines;
  const maxRows = Math.max(1, Math.floor(height));
  const fitted = [...lines];
  while (fitted.length > maxRows) {
    const blankIndex = fitted.findIndex((line) => line.length === 0);
    if (blankIndex < 0) break;
    fitted.splice(blankIndex, 1);
  }
  return fitted.slice(0, maxRows);
}

function renderWideWelcome(
  state: TuiShellState,
  width: number,
  keybindings: TuiKeybindingRegistry | undefined,
  content?: TuiWelcomeContent,
): string[] {
  const tips = resolveWelcomeItems(content?.tips, MINIMAX_CODE_WELCOME_DESIGN.wide.tips, 3);
  const news = resolveWelcomeItems(
    content?.changelogEntries,
    MINIMAX_CODE_WELCOME_DESIGN.wide.news,
    3,
  );
  return [
    ...renderTuiWelcomeHero(width),
    '',
    renderWelcomeHeader(state, width),
    ...renderWelcomeAccountNoticeRows(state, width),
    renderFrameRow(renderSectionTitle(MINIMAX_CODE_WELCOME_DESIGN.sectionTitles.tips), width),
    ...tips.map((text) =>
      renderFrameRow(renderWelcomeBullet(resolveWelcomeCopy(text, keybindings)), width),
    ),
    renderFrameDivider(width),
    renderFrameRow(renderSectionTitle(MINIMAX_CODE_WELCOME_DESIGN.sectionTitles.news), width),
    ...news.map((text) =>
      renderFrameRow(renderWelcomeBullet(resolveWelcomeCopy(text, keybindings)), width),
    ),
    renderFrameBottom(width),
  ];
}

function renderStackedWelcome(
  state: TuiShellState,
  width: number,
  keybindings: TuiKeybindingRegistry | undefined,
  content?: TuiWelcomeContent,
): string[] {
  const tips = resolveWelcomeItems(content?.tips, MINIMAX_CODE_WELCOME_DESIGN.stacked.tips, 2);
  const news = resolveWelcomeItems(
    content?.changelogEntries,
    MINIMAX_CODE_WELCOME_DESIGN.stacked.news,
    3,
  );
  return [
    ...renderTuiWelcomeHero(width),
    '',
    renderWelcomeHeader(state, width),
    ...renderWelcomeAccountNoticeRows(state, width),
    renderFrameDivider(width),
    renderFrameRow(renderSectionTitle(MINIMAX_CODE_WELCOME_DESIGN.sectionTitles.tips), width),
    ...tips.map((text) =>
      renderFrameRow(renderWelcomeBullet(resolveWelcomeCopy(text, keybindings)), width),
    ),
    renderFrameRow('', width),
    renderFrameRow(renderSectionTitle(MINIMAX_CODE_WELCOME_DESIGN.sectionTitles.news), width),
    ...news.map((text) =>
      renderFrameRow(renderWelcomeBullet(resolveWelcomeCopy(text, keybindings)), width),
    ),
    renderFrameRow('', width),
    renderFrameBottom(width),
  ];
}

function renderCompactWelcome(
  state: TuiShellState,
  width: number,
  keybindings: TuiKeybindingRegistry | undefined,
  content?: TuiWelcomeContent,
): string[] {
  const tips = resolveWelcomeItems(content?.tips, MINIMAX_CODE_WELCOME_DESIGN.compact.tips, 2);
  const news = resolveWelcomeItems(
    content?.changelogEntries,
    MINIMAX_CODE_WELCOME_DESIGN.compact.news,
    3,
  );
  return [
    ...renderTuiWelcomeHero(width),
    '',
    renderFrameHeader(
      `${chalk.bold.hex(colors.brand)('MCode')} ${chalk.hex(colors.muted)(`v${state.version}`)}`,
      renderActivity(state),
      width,
    ),
    ...renderWelcomeAccountNoticeRows(state, width),
    renderFrameRow(renderSectionTitle('Tips'), width),
    ...tips.map((text) =>
      renderFrameRow(chalk.hex(colors.muted)(resolveWelcomeCopy(text, keybindings)), width),
    ),
    renderFrameRow(renderSectionTitle(MINIMAX_CODE_WELCOME_DESIGN.sectionTitles.news), width),
    ...news.map((text) => renderFrameRow(chalk.hex(colors.muted)(text), width)),
    renderFrameBottom(width),
  ];
}

function renderWelcomeHeader(state: TuiShellState, width: number): string {
  return renderFrameHeader(
    chalk.hex(colors.muted)(`v${state.version}`),
    renderActivity(state),
    width,
  );
}

function resolveWelcomeItems(
  selected: readonly string[] | undefined,
  fallback: readonly string[],
  count: number,
): readonly string[] {
  return selected?.length ? selected.slice(0, count) : fallback;
}

function renderSectionTitle(title: string): string {
  return chalk.bold.hex(colors.brand)(title);
}

function renderWelcomeBullet(text: string): string {
  return `${chalk.bold.hex(colors.orbit)('›')} ${chalk.hex(colors.text)(text)}`;
}

function resolveWelcomeCopy(value: string, keybindings: TuiKeybindingRegistry | undefined): string {
  return value.replaceAll(
    MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT,
    formatTuiKeybinding('composer.paste-image', keybindings),
  );
}

function renderWelcomeAccountNoticeRows(state: TuiShellState, width: number): string[] {
  const message =
    state.accountStatus === 'Sign in with /login'
      ? state.accountStatus
      : state.accountStatus === 'Connected with warnings'
        ? 'Check /provider or /status for details.'
        : state.accountStatus === 'Account unavailable'
          ? 'Check /status for details.'
          : undefined;
  if (!message) return [];
  const notice = `${chalk.bold.hex(colors.warning)('○')} ${chalk.bold.hex(colors.warning)(message)}`;
  return [renderFrameRow(notice, width)];
}

function renderActivity(state: TuiShellState): string {
  if (state.accountStatus === 'Sign in with /login') {
    return chalk.bold.hex(colors.warning)('○ Login required');
  }
  if (state.runtimeStatus === 'error') {
    return chalk.bold.hex(colors.error)('× Error');
  }
  if (state.accountStatus === 'Checking account') {
    return chalk.bold.hex(colors.signal)('◌ Checking account');
  }
  if (state.accountStatus === 'Connected with warnings') {
    return chalk.bold.hex(colors.warning)('○ Setup warning');
  }
  if (state.accountStatus === 'Account unavailable') {
    return chalk.bold.hex(colors.warning)('○ Account unavailable');
  }
  if (state.runtimeStatus === 'ready') {
    return chalk.bold.hex(colors.orbit)('● Ready');
  }
  if (state.runtimeStatus === 'starting') {
    return chalk.bold.hex(colors.signal)('◌ Starting');
  }
  if (state.runtimeStatus === 'offline') {
    return chalk.bold.hex(colors.warning)('○ Offline');
  }
  return chalk.bold.hex(colors.error)('× Error');
}
