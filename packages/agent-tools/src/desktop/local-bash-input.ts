import { Type } from '@sinclair/typebox';

export const BashDescriptionSchema = Type.Optional(
  Type.String({
    description: 'A short description of what this command does.',
  }),
);

export function resolveBashDescription(description: unknown, command: string): string {
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('Bash description must be a string.');
  }
  return description || command;
}
