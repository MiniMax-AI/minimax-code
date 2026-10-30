import type { AssistantMessage, Context } from '@earendil-works/pi-ai';

/**
 * Recent-conversation context for the next-message suggestion.
 *
 * The suggestion runs as its own small request instead of replaying the main
 * request, so its cost does not grow with the Session and it shares no cache
 * parameters with the main Turn. The shape below is the configuration that won
 * the 150-sample offline evaluation (harness-study, 2026-10-16): the last three
 * turns as plain text — user messages and the assistant's final reply. Adding
 * tool calls or truncated tool results tripled the prompt without a measurable
 * quality gain, one turn was worse, and five turns were no better.
 */
const RECENT_TURNS = 3;
const MESSAGE_CHARS = 2_000;
/** User text keeps its head: the request is usually stated first. */
const USER_HEAD_SHARE = 0.75;
/** Replies keep more of their tail: the next step is usually written last. */
const REPLY_HEAD_SHARE = 0.4;
/** Hard ceiling for the rendered transcript; oldest content goes first. */
const TRANSCRIPT_CHARS = 24_000;

const PREAMBLE =
  'The following is the recent conversation between the user and an AI assistant, in chronological order. Long content has been truncated.';

interface RecentTurn {
  users: string[];
  reply: string;
  /** The assistant answered without requesting another tool call. */
  answered: boolean;
}

type ContextMessage = Context['messages'][number];

/** Builds the single user message sent to the suggestion model. */
export function buildRecentConversationPrompt(
  messages: readonly unknown[],
  finalAssistant: AssistantMessage,
  instruction: string,
): string {
  const turns = groupTurns([...messages, finalAssistant]).slice(-RECENT_TURNS);
  return `${PREAMBLE}\n\n<conversation>\n${renderWithinBudget(turns)}\n</conversation>\n\n${instruction}`;
}

/** The latest genuine user text, cleaned the same way the transcript is. */
export function latestUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Partial<ContextMessage> | undefined;
    if (message?.role !== 'user') continue;
    const text = cleanUserText(readText(message.content));
    if (text) return text;
  }
  return '';
}

/**
 * A turn starts at a user message that follows an answered assistant reply.
 * User messages arriving while tools are still running (steering) stay in the
 * current turn. Unknown roles and non-text parts are skipped, never fatal.
 */
function groupTurns(messages: readonly unknown[]): RecentTurn[] {
  const turns: RecentTurn[] = [];
  for (const raw of messages) {
    const message = raw as Partial<ContextMessage> | undefined;
    if (message?.role === 'user') {
      const text = cleanUserText(readText(message.content));
      const current = turns.at(-1);
      if (!current || current.answered) turns.push({ users: [], reply: '', answered: false });
      if (text) turns.at(-1)!.users.push(text);
    } else if (message?.role === 'assistant') {
      let current = turns.at(-1);
      if (!current) {
        current = { users: [], reply: '', answered: false };
        turns.push(current);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      const text = readText(content).trim();
      if (text) current.reply = text;
      current.answered = !content.some((part) => part?.type === 'toolCall');
    }
  }
  return turns.filter((turn) => turn.users.length || turn.reply);
}

function renderWithinBudget(turns: RecentTurn[]): string {
  const blocks = turns.map((turn) => ({
    users: turn.users.map((text) => headTail(text, MESSAGE_CHARS, USER_HEAD_SHARE)),
    reply: headTail(turn.reply, MESSAGE_CHARS, REPLY_HEAD_SHARE),
  }));
  const render = () =>
    blocks
      .map((block) =>
        [
          '<turn>',
          ...block.users.map((text) => `<user>${text}</user>`),
          `<assistant>${block.reply}</assistant>`,
          '</turn>',
        ].join('\n'),
      )
      .join('\n\n');
  let rendered = render();
  // Drop whole oldest turns first, then the earliest user messages of the one
  // remaining turn (long steering bursts), keeping at least its latest message.
  while (rendered.length > TRANSCRIPT_CHARS) {
    if (blocks.length > 1) blocks.shift();
    else if (blocks[0] && blocks[0].users.length > 1) blocks[0].users.shift();
    else break;
    rendered = render();
  }
  return rendered;
}

function readText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function squeeze(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function headTail(value: string, limit: number, headShare: number): string {
  const text = squeeze(value);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * headShare);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[省略 ${text.length - limit} 字]…\n${text.slice(text.length - tail)}`;
}

/**
 * Removes runtime-injected reminders and the machine part of a questionnaire
 * answer (its readable Q/A follows the block), and reduces a selection-context
 * block to the user's own comments so the budget is spent on what they said.
 */
/** Drops every `open…close` block (non-greedy, unclosed tail kept), in linear time. */
function removeTaggedBlocks(value: string, open: string, close: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = value.indexOf(open, cursor);
    if (start === -1) break;
    const end = value.indexOf(close, start + open.length);
    if (end === -1) break;
    out += value.slice(cursor, start);
    cursor = end + close.length;
  }
  return out + value.slice(cursor);
}

function firstTaggedBlock(value: string, open: string, close: string): string | undefined {
  const start = value.indexOf(open);
  if (start === -1) return undefined;
  const end = value.indexOf(close, start + open.length);
  return end === -1 ? undefined : value.slice(start, end + close.length);
}

const REQUESTED_CHANGE_MARKER = 'User comment (requested change):';

function isBlank(char: string): boolean {
  return char.trim() === '';
}

/**
 * Comment bodies after each requested-change marker: the marker's trailing
 * whitespace up to its last newline is skipped, and the body runs to the first
 * blank line. Index scans keep this linear on untrusted text.
 */
function requestedChangeComments(block: string): string[] {
  const comments: string[] = [];
  let cursor = 0;
  for (;;) {
    const marker = block.indexOf(REQUESTED_CHANGE_MARKER, cursor);
    if (marker === -1) break;
    let index = marker + REQUESTED_CHANGE_MARKER.length;
    let bodyStart = -1;
    while (index < block.length && isBlank(block[index] ?? '')) {
      if (block[index] === '\n') bodyStart = index + 1;
      index += 1;
    }
    if (bodyStart === -1) {
      cursor = index;
      continue;
    }
    const bodyEnd = blankLineStart(block, bodyStart);
    if (bodyEnd === undefined) break;
    comments.push(block.slice(bodyStart, bodyEnd.start));
    cursor = bodyEnd.end;
  }
  return comments;
}

/** First `\n<whitespace>*\n` at or after `from`, as the span it covers. */
function blankLineStart(value: string, from: number): { start: number; end: number } | undefined {
  let newline = value.indexOf('\n', from);
  while (newline !== -1) {
    let index = newline + 1;
    let lastNewline = -1;
    while (index < value.length && isBlank(value[index] ?? '')) {
      if (value[index] === '\n') lastNewline = index;
      index += 1;
    }
    if (lastNewline !== -1) return { start: newline, end: lastNewline + 1 };
    newline = value.indexOf('\n', newline + 1);
  }
  return undefined;
}

function cleanUserText(value: string): string {
  let text = removeTaggedBlocks(
    removeTaggedBlocks(value, '<system-reminder>', '</system-reminder>'),
    '<questionnaire-response>',
    '</questionnaire-response>',
  );
  const block = firstTaggedBlock(text, '<user-provided-context>', '</user-provided-context>');
  if (block) {
    const comments = requestedChangeComments(block)
      .map((comment) => comment.trim())
      .filter(Boolean);
    text = text.replace(
      block,
      comments.length
        ? `[对引用内容的批注] ${comments.map((comment, index) => `(${index + 1}) ${comment}`).join(' ')}`
        : '',
    );
  }
  return squeeze(text);
}
