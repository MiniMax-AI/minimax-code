import { parseRequestMediaConfig } from '@mavis/config';

import {
  initializeBrowserUseService,
  type BrowserUseService,
} from '../../service/browser-use/index.js';

type BrowserUseServiceOptions = Parameters<typeof initializeBrowserUseService>[0];

interface RuntimeBrowserUseBetaConfig {
  readonly filePanelBrowser?: boolean;
  readonly browserUseTooling?: boolean;
}

export interface RuntimeBrowserUseOptions {
  readonly browserUse?: Pick<BrowserUseServiceOptions, 'adapter' | 'toolExposure'>;
  readonly runtimeOwnerKind?: string;
  readonly compatibility: {
    readonly agentHost: {
      readonly preparation: {
        readonly configBuilder: {
          config(): {
            readonly beta?: RuntimeBrowserUseBetaConfig;
            readonly requestMedia?: unknown;
          };
        };
      };
    };
    readonly generatedAssets: {
      readonly registerGeneratedAsset: BrowserUseServiceOptions['registerGeneratedAsset'];
    };
    readonly questionnaires: {
      bindRequestAdmission(admission: BrowserUseService['admitQuestionnaireRequest']): void;
    };
  };
}

export interface RuntimeBrowserUseComposition {
  readonly service: BrowserUseService;
  close(): void;
}

export function ownsElectronRuntimeCapabilities(runtimeOwnerKind: string | undefined): boolean {
  return runtimeOwnerKind === undefined || runtimeOwnerKind === 'electron';
}

export function createRuntimeBrowserUseComposition(
  options: RuntimeBrowserUseOptions,
): RuntimeBrowserUseComposition {
  const service = initializeBrowserUseService({
    ...(options.browserUse?.adapter ? { adapter: options.browserUse.adapter } : {}),
    ...(options.browserUse?.toolExposure ? { toolExposure: options.browserUse.toolExposure } : {}),
    readConfig: () => {
      const beta = options.compatibility.agentHost.preparation.configBuilder.config().beta;
      return {
        ...(beta?.filePanelBrowser === undefined
          ? {}
          : { filePanelBrowserEnabled: beta.filePanelBrowser }),
        ...(beta?.browserUseTooling === undefined
          ? {}
          : { browserUseToolingEnabled: beta.browserUseTooling }),
      };
    },
    getImageEncoding: () => {
      let requestMedia: unknown;
      try {
        requestMedia =
          options.compatibility.agentHost.preparation.configBuilder.config().requestMedia;
      } catch {
        requestMedia = undefined;
      }
      const { image } = parseRequestMediaConfig(requestMedia);
      return {
        maxWidth: image.max_width,
        maxHeight: image.max_height,
        maxBase64Bytes: image.max_base64_bytes,
      };
    },
    registerGeneratedAsset: options.compatibility.generatedAssets.registerGeneratedAsset,
    activationMode: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
      ? 'desktop-plugin'
      : 'explicit-config',
  });
  options.compatibility.questionnaires.bindRequestAdmission((input) =>
    service.admitQuestionnaireRequest(input),
  );
  return {
    service,
    close(): void {
      service.close();
    },
  };
}
