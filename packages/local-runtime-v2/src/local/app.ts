import { CliService, type CliServiceOptions } from './cli-service.js';
import type { CreateLocalRuntimeHostOptions } from './host-contract.js';

/** Creates the process-local delivery surface over already composed Applications. */
export function createCliService(
  options: CliServiceOptions,
  hostOptions: Partial<
    Pick<CreateLocalRuntimeHostOptions, 'runtimeOwnerKind' | 'capabilities' | 'cliPtcEntrypoint'>
  > = {},
): CliService {
  const trustedPtcEntrypoint =
    hostOptions.runtimeOwnerKind === 'tui' &&
    hostOptions.capabilities?.cliEmbedded === true &&
    (hostOptions.cliPtcEntrypoint === 'interactive' || hostOptions.cliPtcEntrypoint === 'exec');
  return new CliService(options, trustedPtcEntrypoint);
}
