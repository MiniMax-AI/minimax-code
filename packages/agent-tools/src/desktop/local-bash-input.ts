import { Type } from '@sinclair/typebox';

export const BashDescriptionSchema = Type.Optional(
  Type.String({
    description:
      "A short description of what this command does, shown to the user and used as the background task name. Write it in the user's language, matching your replies; keep commands, paths, and identifiers verbatim.",
  }),
);

export function resolveBashDescription(description: unknown, command: string): string {
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('Bash description must be a string.');
  }
  return description || command;
}
