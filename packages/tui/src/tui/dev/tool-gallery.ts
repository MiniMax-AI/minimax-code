import { stripVTControlCharacters } from 'node:util';
import { TranscriptView } from '../transcript/view.js';
import { createTranscriptCell, type TranscriptCellStatus } from '../transcript/model.js';

export type TuiToolGalleryState = 'running' | 'succeeded' | 'failed';

export interface TuiToolGalleryOptions {
  readonly width?: number;
  readonly plain?: boolean;
}

const STATES: readonly TuiToolGalleryState[] = ['running', 'succeeded', 'failed'];

const CASES = [
  { name: 'bash', content: '{"command":"pnpm test"}', detail: 'PASS 42 tests\nDone in 1.2s' },
  { name: 'read', content: '{"path":"src/app.ts"}', detail: 'export function start() {}' },
  { name: 'search', content: '{"query":"createSession"}', detail: 'src/session.ts:42' },
  { name: 'write', content: '{"path":"docs/report.md"}', detail: '# Capability report' },
  {
    name: 'edit',
    content: '{"path":"src/theme.ts"}',
    detail: 'Updated terminal theme tokens',
    structuredPreview: {
      schemaVersion: 1 as const,
      state: 'applied' as const,
      blocks: [
        {
          kind: 'diff' as const,
          path: 'src/theme.ts',
          diff: '- const line = oldColor\n+ const line = newColor',
          addedLines: 1,
          removedLines: 1,
          truncated: false,
        },
      ],
    },
  },
  { name: 'task', content: '{"description":"Review auth flow"}', detail: 'Agent reviewing files' },
  {
    name: 'mcp__matrix__web_search',
    content: '{"query":"terminal interaction patterns"}',
    detail: '3 sources returned',
  },
] as const;

export function renderTuiToolGallery(options: TuiToolGalleryOptions = {}): string {
  const width = Math.max(32, Math.floor(options.width ?? 80));
  const sections = STATES.flatMap((state) => [
    `TOOL LIFECYCLE · ${state.toLocaleUpperCase()}`,
    ...new TranscriptView(() => createGalleryCells(state)).render(width),
  ]);
  const rendered = sections.join('\n');
  return options.plain ? stripVTControlCharacters(rendered) : rendered;
}

const PTC_PROGRAM = {
  code: [
    "const files = await tools.glob({ pattern: 'src/*.ts' });",
    'for (const path of files) await tools.read({ path });',
    "return tools.grep({ pattern: 'export' });",
  ].join('\n'),
  description: 'Count exported symbols',
};

const PTC_CHILDREN = [
  { id: 'glob', name: 'glob', content: '{"pattern":"src/*.ts"}', detail: 'src/app.ts' },
  { id: 'read-app', name: 'read', content: '{"path":"src/app.ts"}', detail: 'export {}' },
  {
    id: 'read-session',
    name: 'read',
    content: '{"path":"src/session.ts"}',
    detail: 'ENOENT: no such file',
  },
  { id: 'grep', name: 'grep', content: '{"pattern":"export"}', detail: 'src/app.ts:1' },
] as const;

/** Child status per lifecycle: running streams, succeeded keeps a failure, failed is cut off. */
const PTC_CHILD_STATUSES: Readonly<Record<TuiToolGalleryState, readonly TranscriptCellStatus[]>> = {
  running: ['succeeded', 'succeeded', 'succeeded', 'running'],
  succeeded: ['succeeded', 'succeeded', 'failed', 'succeeded'],
  failed: ['succeeded', 'succeeded', 'succeeded', 'running'],
};

export function createGalleryCells(state: TuiToolGalleryState) {
  return [...createToolCells(state), ...createPtcCells(state)];
}

function createPtcCells(state: TuiToolGalleryState) {
  const turnId = `gallery:${state}`;
  const programId = `gallery-ptc:${state}`;
  const offset = CASES.length + 1;
  return [
    createTranscriptCell({
      id: `gallery:${state}:run_code`,
      kind: 'tool',
      status: state,
      title: 'run_code',
      toolCallId: programId,
      content: JSON.stringify(PTC_PROGRAM),
      detail:
        state === 'running'
          ? ''
          : state === 'failed'
            ? 'wall_clock_exceeded: program stopped after 30s'
            : 'src/app.ts: 1 export\nsrc/session.ts: unreadable\n1 export total\nDone',
      ...(state === 'running' ? {} : { durationMs: 1_200 }),
      turnId,
      createdAtMs: offset,
      updatedAtMs: offset,
    }),
    ...PTC_CHILDREN.map((child, index) => {
      const status = PTC_CHILD_STATUSES[state][index] ?? 'succeeded';
      return createTranscriptCell({
        id: `gallery:${state}:run_code:${child.id}`,
        kind: 'tool',
        status,
        title: child.name,
        toolCallId: `${programId}:${child.id}`,
        parentToolCallId: programId,
        content: child.content,
        detail: status === 'running' ? '' : child.detail,
        turnId,
        createdAtMs: offset + index + 1,
        updatedAtMs: offset + index + 1,
      });
    }),
  ];
}

function createToolCells(state: TuiToolGalleryState) {
  const status: TranscriptCellStatus = state;
  return CASES.map((fixture, index) =>
    createTranscriptCell({
      id: `gallery:${state}:${fixture.name}`,
      kind: 'tool',
      status,
      title: fixture.name,
      content: fixture.content,
      detail: state === 'failed' ? `Failed: ${fixture.detail}` : fixture.detail,
      ...('structuredPreview' in fixture
        ? {
            structuredPreview: {
              ...fixture.structuredPreview,
              state:
                state === 'running' ? 'proposed' : state === 'failed' ? 'not-applied' : 'applied',
              blocks: [...fixture.structuredPreview.blocks],
            },
          }
        : {}),
      turnId: `gallery:${state}`,
      createdAtMs: index + 1,
      updatedAtMs: index + 1,
    }),
  );
}
