export type DesktopMatrixRegion = 'cn' | 'en';
export type DesktopMatrixBuildEnv = 'dev' | 'test' | 'staging' | 'prod';

export interface DesktopMatrixEndpoint {
  baseUrl: string;
  managed: boolean;
  explicitToken?: string;
}

const MANAGED_MATRIX_BASE_URLS: Record<
  DesktopMatrixRegion,
  Record<DesktopMatrixBuildEnv, string>
> = {
  cn: {
    dev: 'https://matrix-test.example.invalid',
    test: 'https://matrix-test.example.invalid',
    staging: 'https://matrix-pre.example.invalid',
    prod: 'https://agent.minimax.cn',
  },
  en: {
    dev: 'https://matrix-overseas-test.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    staging: 'https://matrix-overseas-pre.example.invalid',
    prod: 'https://agent.minimax.io',
  },
};

const LEGACY_MANAGED_MATRIX_BASE_URLS = new Set(['https://agent.minimaxi.com']);

export function normalizeMatrixBaseUrl(value: string): string {
  const trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end -= 1;
  return trimmed.slice(0, end);
}

export function getDesktopMatrixEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): DesktopMatrixEndpoint {
  const override = env.MATRIX_BASE_URL?.trim();
  const baseUrl = override ? normalizeMatrixBaseUrl(override) : getManagedDesktopMatrixBaseUrl(env);
  const managed = isManagedMatrixBaseUrl(baseUrl);
  const explicitToken = managed ? undefined : env.MATRIX_TOKEN?.trim();
  return {
    baseUrl,
    managed,
    ...(explicitToken ? { explicitToken } : {}),
  };
}

export function getManagedDesktopMatrixBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return MANAGED_MATRIX_BASE_URLS[normalizeRegion(env.MAVIS_REGION)][
    normalizeBuildEnv(env.MAVIS_BUILD_ENV)
  ];
}

export function isManagedMatrixBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeMatrixBaseUrl(baseUrl);
  if (LEGACY_MANAGED_MATRIX_BASE_URLS.has(normalized)) return true;
  return Object.values(MANAGED_MATRIX_BASE_URLS).some((byEnv) =>
    Object.values(byEnv).some(
      (managedBaseUrl) => normalizeMatrixBaseUrl(managedBaseUrl) === normalized,
    ),
  );
}

function normalizeRegion(value: string | undefined): DesktopMatrixRegion {
  return value === 'cn' ? 'cn' : 'en';
}

function normalizeBuildEnv(value: string | undefined): DesktopMatrixBuildEnv {
  if (value === 'dev' || value === 'test' || value === 'staging' || value === 'prod') {
    return value;
  }
  return 'dev';
}
