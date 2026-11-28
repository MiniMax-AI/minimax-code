import type { AllowedMetricName } from '@mavis/shared/local-runtime-logging/metrics';
import { getSandboxConfigDefaults, type SandboxConfig } from '@mavis/config';
import { resolveBashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';

import { createSrtMacosBackend } from './backend/srt-macos.js';
import type { SandboxBackendDescriptorForTest } from './backend/types.js';
import type { DeferredLocalSandboxBashOperationsFactory } from './contracts.js';
import {
  createDeferredLocalSandboxBashOperationsFactory,
  createSandboxBashOperationsFactory,
} from './deferred-port.js';
import { createSandboxEvalEventSink } from './observability/eval-adapter.js';
import type { SandboxEvalReporter } from './observability/contracts.js';
import { LocalSandboxService } from './local-sandbox-service.js';
import type {
  SandboxMetricsClient,
  SandboxObservabilityOptions,
} from './observability/sandbox-observability.js';
import type { SandboxConfigCommitWriter } from './config-commit.js';

interface LocalSandboxCompositionOptions {
  readonly sandboxConfig?: SandboxConfig;
  readonly evalReporter?: SandboxEvalReporter;
  readonly logger?: { info(fields: Record<string, unknown>, message: string): void };
  readonly eventSink?: SandboxObservabilityOptions['eventSink'];
  readonly log?: SandboxObservabilityOptions['log'];
  readonly sandboxOperationsFactory?: DeferredLocalSandboxBashOperationsFactory;
  readonly configWriter: SandboxConfigCommitWriter;
  readonly metrics?: Pick<SandboxMetricsClient, 'counter' | 'histogram'>;
  readonly nowMs?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly sandboxDescriptors?: readonly SandboxBackendDescriptorForTest[];
}

const SRT_MACOS_BACKEND_DESCRIPTOR: SandboxBackendDescriptorForTest = Object.freeze({
  id: 'srt-macos',
  platform: 'darwin',
  priority: 100,
  create: () => createSrtMacosBackend(),
});

export function composeLocalSandboxService(
  input: LocalSandboxCompositionOptions,
): LocalSandboxService {
  const config =
    input.sandboxConfig ?? getSandboxConfigDefaults(input.platform ?? process.platform);
  const operationsFactory =
    input.sandboxOperationsFactory ??
    createDeferredLocalSandboxBashOperationsFactory(
      () => config.enabled,
      // Production always injects a shim-aware factory via runtime.ts, so this
      // fallback only serves tests/embedders. The v2 service layer must not
      // import v1 runtime values (depcruise: v1-runtime-values-only-runtime-or-index),
      // so the shim PATH policy cannot be resolved here.
      resolveBashEnvPolicy(),
    );
  return initializeLocalSandboxService({
    config,
    operationsFactory,
    configWriter: input.configWriter,
    eventSink: input.eventSink ?? createSandboxEvalEventSink(input.evalReporter),
    log: input.log ?? ((event) => input.logger?.info({ ...event }, event.event_type)),
    ...(input.metrics
      ? {
          metrics: {
            counter: (name: AllowedMetricName, delta, labels) =>
              input.metrics?.counter(name, delta, labels),
            histogram: (name: AllowedMetricName, value, labels) =>
              input.metrics?.histogram(name, value, labels),
          },
        }
      : {}),
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.sandboxDescriptors ? { descriptors: input.sandboxDescriptors } : {}),
  });
}

function initializeLocalSandboxService(input: {
  readonly config: SandboxConfig;
  readonly eventSink?: SandboxObservabilityOptions['eventSink'];
  readonly log?: SandboxObservabilityOptions['log'];
  readonly operationsFactory: DeferredLocalSandboxBashOperationsFactory;
  readonly metrics?: SandboxMetricsClient;
  readonly nowMs?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly descriptors?: readonly SandboxBackendDescriptorForTest[];
  readonly configWriter: SandboxConfigCommitWriter;
}): LocalSandboxService {
  const service = new LocalSandboxService({
    config: input.config,
    configWriter: input.configWriter,
    observability: { metrics: input.metrics, eventSink: input.eventSink, log: input.log },
    ...(input.nowMs ? { now: input.nowMs } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    descriptors: input.descriptors ?? [SRT_MACOS_BACKEND_DESCRIPTOR],
  });
  input.operationsFactory.bind(createSandboxBashOperationsFactory(service));
  return service;
}
