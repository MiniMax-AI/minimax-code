import { CliService, type CliServiceOptions } from './cli-service.js';

/** Creates the process-local delivery surface over already composed Applications. */
export function createCliService(options: CliServiceOptions): CliService {
  return new CliService(options);
}
