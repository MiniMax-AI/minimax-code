import path from 'node:path';

export type IdeAppFamily =
  | 'cursor'
  | 'vscode'
  | 'visual-studio'
  | 'file-explorer'
  | 'finder'
  | 'terminal'
  | 'iterm2'
  | 'ghostty'
  | 'warp'
  | 'trae'
  | 'xcode'
  | 'android-studio'
  | 'zed'
  | 'windsurf'
  | 'jetbrains';

export interface IdeAppInfo {
  id: string;
  name: string;
  family: IdeAppFamily;
  available: boolean;
  appPath?: string;
  iconDataUrl?: string;
  unavailableReason?: string;
}

export interface IdeAppsResponse {
  apps: IdeAppInfo[];
  stale: boolean;
}

export interface IdeCatalogEntry {
  id: string;
  name: string;
  family: IdeAppFamily;
  binaries: string[];
  macAppNames?: string[];
  windowsDirNames?: string[];
  windowsExecutables?: string[];
  windowsOnly?: boolean;
}

export interface ResolvedIdeAppInfo extends IdeAppInfo {
  launchKind?: 'mac-app' | 'binary' | 'windows-file-manager';
  launchTarget?: string;
}

export const IDE_APPS_CACHE_TTL_MS = 5 * 60_000;
export const IDE_APP_RESOLVE_CONCURRENCY = 4;
export const IDE_PATH_PROBE_CONCURRENCY = 8;
export const IDE_UNAVAILABLE_REASON = 'Application is not installed or not available on PATH';

export const IDE_CATALOG: IdeCatalogEntry[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    family: 'cursor',
    binaries: ['cursor'],
    macAppNames: ['Cursor.app'],
    windowsDirNames: ['Cursor', 'cursor'],
    windowsExecutables: ['Cursor.exe'],
  },
  {
    id: 'vscode',
    name: 'VS Code',
    family: 'vscode',
    binaries: ['code'],
    macAppNames: ['Visual Studio Code.app', 'Code.app'],
    windowsDirNames: ['Microsoft VS Code'],
    windowsExecutables: ['Code.exe'],
  },
  {
    id: 'file-explorer',
    name: 'File Explorer',
    family: 'file-explorer',
    binaries: ['explorer'],
    windowsOnly: true,
  },
  {
    id: 'finder',
    name: 'Finder',
    family: 'finder',
    binaries: [],
    macAppNames: ['Finder.app'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    family: 'terminal',
    binaries: [],
    macAppNames: ['Terminal.app'],
  },
  {
    id: 'iterm2',
    name: 'iTerm2',
    family: 'iterm2',
    binaries: [],
    macAppNames: ['iTerm.app', 'iTerm2.app'],
  },
  {
    id: 'ghostty',
    name: 'Ghostty',
    family: 'ghostty',
    binaries: ['ghostty'],
    macAppNames: ['Ghostty.app'],
  },
  {
    id: 'warp',
    name: 'Warp',
    family: 'warp',
    binaries: ['warp'],
    macAppNames: ['Warp.app'],
    windowsDirNames: ['Warp'],
    windowsExecutables: ['Warp.exe'],
  },
  {
    id: 'visual-studio',
    name: 'Visual Studio',
    family: 'visual-studio',
    binaries: ['devenv'],
    macAppNames: ['Visual Studio.app'],
    windowsDirNames: [
      path.win32.join('Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE'),
      path.win32.join('Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'IDE'),
      path.win32.join('Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'IDE'),
      path.win32.join('Microsoft Visual Studio', '2019', 'Community', 'Common7', 'IDE'),
      path.win32.join('Microsoft Visual Studio', '2019', 'Professional', 'Common7', 'IDE'),
      path.win32.join('Microsoft Visual Studio', '2019', 'Enterprise', 'Common7', 'IDE'),
    ],
    windowsExecutables: ['devenv.exe'],
  },
  {
    id: 'trae',
    name: 'Trae',
    family: 'trae',
    binaries: ['trae'],
    macAppNames: ['Trae.app', 'Trae CN.app'],
    windowsDirNames: ['Trae', 'Trae CN'],
    windowsExecutables: ['Trae.exe'],
  },
  {
    id: 'xcode',
    name: 'Xcode',
    family: 'xcode',
    binaries: ['xed'],
    macAppNames: ['Xcode.app', 'Xcode Beta.app', 'Xcode-beta.app'],
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    family: 'android-studio',
    binaries: ['studio', 'android-studio'],
    macAppNames: ['Android Studio.app'],
    windowsDirNames: ['Android Studio'],
    windowsExecutables: ['studio64.exe', 'studio.exe'],
  },
  {
    id: 'zed',
    name: 'Zed',
    family: 'zed',
    binaries: ['zed'],
    macAppNames: ['Zed.app', 'Zed Preview.app'],
    windowsDirNames: ['Zed'],
    windowsExecutables: ['zed.exe', 'Zed.exe'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    family: 'windsurf',
    binaries: ['windsurf'],
    macAppNames: ['Windsurf.app'],
    windowsDirNames: ['Windsurf'],
    windowsExecutables: ['Windsurf.exe'],
  },
  {
    id: 'jetbrains-idea',
    name: 'IntelliJ IDEA',
    family: 'jetbrains',
    binaries: ['idea', 'idea64'],
    macAppNames: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'],
    windowsDirNames: ['IntelliJ IDEA'],
    windowsExecutables: ['idea64.exe', 'idea.exe'],
  },
  {
    id: 'jetbrains-webstorm',
    name: 'WebStorm',
    family: 'jetbrains',
    binaries: ['webstorm', 'webstorm64'],
    macAppNames: ['WebStorm.app'],
    windowsDirNames: ['WebStorm'],
    windowsExecutables: ['webstorm64.exe', 'webstorm.exe'],
  },
  {
    id: 'jetbrains-pycharm',
    name: 'PyCharm',
    family: 'jetbrains',
    binaries: ['pycharm', 'pycharm64'],
    macAppNames: ['PyCharm.app', 'PyCharm CE.app'],
    windowsDirNames: ['PyCharm'],
    windowsExecutables: ['pycharm64.exe', 'pycharm.exe'],
  },
  {
    id: 'jetbrains-goland',
    name: 'GoLand',
    family: 'jetbrains',
    binaries: ['goland', 'goland64'],
    macAppNames: ['GoLand.app'],
    windowsDirNames: ['GoLand'],
    windowsExecutables: ['goland64.exe', 'goland.exe'],
  },
  {
    id: 'jetbrains-clion',
    name: 'CLion',
    family: 'jetbrains',
    binaries: ['clion', 'clion64'],
    macAppNames: ['CLion.app'],
    windowsDirNames: ['CLion'],
    windowsExecutables: ['clion64.exe', 'clion.exe'],
  },
  {
    id: 'jetbrains-phpstorm',
    name: 'PhpStorm',
    family: 'jetbrains',
    binaries: ['phpstorm', 'phpstorm64'],
    macAppNames: ['PhpStorm.app'],
    windowsDirNames: ['PhpStorm'],
    windowsExecutables: ['phpstorm64.exe', 'phpstorm.exe'],
  },
  {
    id: 'jetbrains-rider',
    name: 'Rider',
    family: 'jetbrains',
    binaries: ['rider', 'rider64'],
    macAppNames: ['Rider.app'],
    windowsDirNames: ['Rider'],
    windowsExecutables: ['rider64.exe', 'rider.exe'],
  },
  {
    id: 'jetbrains-datagrip',
    name: 'DataGrip',
    family: 'jetbrains',
    binaries: ['datagrip', 'datagrip64'],
    macAppNames: ['DataGrip.app'],
    windowsDirNames: ['DataGrip'],
    windowsExecutables: ['datagrip64.exe', 'datagrip.exe'],
  },
  {
    id: 'jetbrains-rubymine',
    name: 'RubyMine',
    family: 'jetbrains',
    binaries: ['rubymine', 'rubymine64'],
    macAppNames: ['RubyMine.app'],
    windowsDirNames: ['RubyMine'],
    windowsExecutables: ['rubymine64.exe', 'rubymine.exe'],
  },
];
