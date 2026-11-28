import { Type, type Static } from '@sinclair/typebox';

import type { ToolDefinition } from '@mavis/agent-core/tools';

import { prepareAskUserArguments } from './prepare-ask-user-arguments.js';

const LocalAskUserImageSchema = Type.Object({
  src: Type.String({
    description: 'HTTPS URL or local /mavis/api/... path for an image shown in the question UI.',
  }),
  alt: Type.Optional(Type.String({ description: 'Accessible alt text for the image.' })),
  caption: Type.Optional(Type.String({ description: 'Optional image caption.' })),
});

const LocalAskUserOptionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: 'Stable option id; generated when omitted.' })),
  label: Type.String({
    description:
      "Short, self-contained choice or action and its outcome, written in the user's language. This field is guaranteed to be visible; do not rely on the optional description for essential meaning. Do not write a recommendation marker such as (Recommended) or （推荐） in the label; use `recommended` instead.",
  }),
  description: Type.Optional(
    Type.String({
      description:
        'Optional explanation of the outcome or tradeoff. May be hidden in some question UIs.',
    }),
  ),
  image: Type.Optional(LocalAskUserImageSchema),
  recommended: Type.Optional(
    Type.Boolean({
      description:
        "Machine-readable recommendation highlighted in the question UI. Mark at most one option per question; outside Goal mode the runtime never selects it on the user's behalf. In Goal mode, if the user does not answer within 60 seconds, this option (or the first option if none is marked) may be selected automatically, so mark the safest reasonable choice; for a final-action confirmation, recommend leaving state unchanged.",
    }),
  ),
});

/**
 * Why the open-ended line of the `options` description asks for likely
 * values: it used to ask for "concrete input-source choices", which led models
 * to offer ways of providing the content (upload, paste, link) as options. That
 * contradicted `<ask-user-guidance>` (ask-user-reminders.ts), which asks for
 * likely choices. In the Ask User v2 eval the clinic charter task (Bench
 * V2-004) scored 0 because the model asked whether to upload, paste, or link
 * the material instead of asking for the goal, mandatory controls, and stop
 * conditions. Both texts now say the same thing.
 */
const LocalAskUserStepSchema = Type.Object({
  id: Type.Optional(Type.String({ description: 'Stable step id; generated when omitted.' })),
  header: Type.Optional(
    Type.String({ description: 'Short plain-text section label for this question.' }),
  ),
  question: Type.String({
    description: [
      "A specific, directly answerable question in the user's language.",
      '',
      '- Ask about one concrete decision; avoid compound or vague questions.',
      '- Use plain text only, without Markdown or HTML formatting. This question is displayed directly as the panel heading.',
      '- Include the context and consequences needed to decide. This field is guaranteed to be visible; title, header, and descriptions may be hidden.',
      '- Ask explicitly for a missing subject or input, such as a product, destination, or source file; do not substitute a category preference.',
      '- For final-action confirmation, state the exact action, site, account, content or recipients, file names, visibility, and other material settings. The card must stand alone without surrounding assistant prose.',
    ].join('\n'),
  }),
  description: Type.Optional(
    Type.String({
      description: 'Optional supporting context. May be hidden in some question UIs.',
    }),
  ),
  image: Type.Optional(LocalAskUserImageSchema),
  options: Type.Array(LocalAskUserOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: [
      'Provide 2-4 realistic choices as a JSON array, without an object wrapper.',
      '',
      '- Answer only this question at a consistent level of detail; do not mix a category with a product in it or encode a second decision.',
      '- Single-choice options must be mutually exclusive; multiple-choice options must allow meaningful combinations.',
      '- Put a reasonable, safe default first when one exists.',
      '- For open-ended values, offer likely values as options; the user can type a custom answer in the Other field, so never add an Other option.',
      '- Final-action confirmation requires exactly two options: confirm the exact action, or leave state unchanged.',
    ].join('\n'),
  }),
  selectionMode: Type.Optional(
    Type.Union([Type.Literal('single'), Type.Literal('multiple')], {
      description:
        'Defaults to single. Use multiple only when the user may select a combination of options. For final-action confirmation, explicitly set single.',
    }),
  ),
});

type LocalAskUserPreparedArguments = {
  mode?: 'questionnaire';
  async?: boolean;
  title?: string;
  steps: Static<typeof LocalAskUserStepSchema>[];
};

/**
 * Why the `async` wording asks for a choice on every call: in the 2026-10-13
 * Ask User v2 eval, none of 34 ask_user calls set `async: true` and 28 left it
 * out. A model that does not want to be blocked simply guesses instead of
 * asking, so the description makes it pick a mode each time and says to ask
 * asynchronously, rather than guess, while independent work remains.
 *
 * Why `async: true` forbids assuming only direction-deciding answers:
 * fca4da2e27 said "Never assume the answer" outright, which left a model two
 * choices for a non-urgent question with a likely answer: stop and wait, or
 * not ask at all. Asking asynchronously while proceeding on the likely answer
 * is the point of `async: true`, so only an answer that decides the
 * deliverable's direction must not be assumed, and any other answer the model
 * proceeds on must be stated as an assumption. This matches the wording before
 * fca4da2e27, which only forbade assuming irreversible choices.
 *
 * `async` stays optional in the schema on purpose: prompt rules are
 * recommendations, and a required field would turn every call that forgets it
 * into a schema validation failure.
 */
export const LocalAskUserToolDef = {
  name: 'ask_user',
  executionMode: 'sequential',
  prepareArguments: prepareAskUserArguments,
  description: [
    'Ask the local desktop user structured questions, either waiting for the answer or returning immediately (see `async`).',
    '',
    '**When to use**',
    '',
    '- Collect user decisions that determine the deliverable, such as its direction, one of several exclusive versions, facts only the user knows, or scope and permissions. Ask before building on a guess.',
    '- Request user input, takeover, or final-action confirmation required by the current workflow.',
    '- Resolve discoverable uncertainty first. Respect requests not to ask ordinary clarifying questions; required confirmations still apply.',
    '- Do not ask a choice that a dedicated user-action card already collects (for example, whether to install, enable, or connect a plugin).',
    '',
    '**Interaction**',
    '',
    '- Call the actual tool. Prose or simulated tool calls do not display a questionnaire or pause execution.',
    '- Gather related decisions in one concise questionnaire, even when conversational preferences favor one question at a time.',
    '- Set `async` on every call; omitting it waits like `false`.',
    '- `async: false` when your next step depends on the answer: the call waits and returns the answer as the tool result.',
    "- `async: true` when independent work remains: the call returns immediately. Continue only work that does not depend on the answer; when nothing independent is left, end the turn. Never assume an answer that decides the deliverable's direction; where you proceed on a likely answer for anything else, state it as an assumption. It arrives later as a new message; do not ask the same question again. Prefer this to guessing when you still have other work to do.",
    '- User settings may override `async`. Follow what the tool result reports.',
  ].join('\n'),
  schema: Type.Object(
    {
      mode: Type.Optional(Type.Literal('questionnaire')),
      async: Type.Optional(
        Type.Boolean({
          description:
            "Set on every call. false: wait for the user's reply and receive it as the tool result; use it when your next step depends on the answer. true: show the questions and return immediately, and any answer arrives later as a new message; use it when independent work remains. Omitted behaves like false. User settings may override this value; the tool result is authoritative.",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            'Optional plain-text questionnaire title; do not use Markdown or HTML formatting.',
        }),
      ),
      steps: Type.Array(LocalAskUserStepSchema, {
        minItems: 1,
        maxItems: 4,
        description: [
          'One to four questions covering unresolved decisions the user must make.',
          '',
          '- Use the fewest questions needed; each answer must materially change execution or the result. Do not repeat supplied information.',
          '- Cover blocking inputs, outcome, scope, constraints, and risk before preferences about tone, style, or length.',
          '- Final-action confirmation requires exactly one step.',
        ].join('\n'),
      }),
    },
    { additionalProperties: false },
  ),
} as const satisfies ToolDefinition;
export type LocalAskUserToolInput = Static<typeof LocalAskUserToolDef.schema>;

export const LocalFeatureEnableToolDef = {
  name: 'request_feature_enable',
  executionMode: 'sequential',
  description:
    'Request a product-owned feature enable card and pause this turn until the local desktop user responds. Call this tool only when a trusted system reminder explicitly requests it. Pass the feature key from that reminder verbatim; never invent a feature key. This tool requests user consent and does not enable the feature directly.',
  schema: Type.Object(
    {
      featureKey: Type.String({
        minLength: 1,
        description: 'Product feature key supplied verbatim by a trusted system reminder.',
      }),
    },
    { additionalProperties: false },
  ),
} as const satisfies ToolDefinition;
export type LocalFeatureEnableToolInput = Static<typeof LocalFeatureEnableToolDef.schema>;
