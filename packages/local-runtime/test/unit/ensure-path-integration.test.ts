import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

const fsMocks = vi.hoisted(() => {
  const existsSync = vi.fn();
  const readFileSync = vi.fn();
  const appendFileSync = vi.fn();
  return { existsSync, readFileSync, appendFileSync };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    appendFileSync: fsMocks.appendFileSync,
  };
});

const osMocks = vi.hoisted(() => {
  const homedir = vi.fn();
  return { homedir };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: osMocks.homedir,
  };
});

const childProcessMocks = vi.hoisted(() => {
  const execFileSync = vi.fn();
  return { execFileSync };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return {
    ...actual,
    execFileSync: childProcessMocks.execFileSync,
  };
});

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  osMocks.homedir.mockReset();
  childProcessMocks.execFileSync.mockReset();
});

async function importModule() {
  // Dynamic import so mocks above are in place before the module evaluates.
  const mod = await import('../../src/infra/ensure-path-integration.js');
  return mod.ensurePathIntegration;
}

describe('ensurePathIntegration — Linux', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/home/testuser');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    osMocks.homedir.mockReturnValue('/home/testuser');
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes PATH export to both .bashrc and .zshrc on Linux', async () => {
    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const writtenFiles = fsMocks.appendFileSync.mock.calls.map(
      (call) => call[0] as string,
    );

    expect(writtenFiles).toContain('/home/testuser/.bashrc');
    expect(writtenFiles).toContain('/home/testuser/.zshrc');
  });

  it('uses the correct export line with the data bin directory', async () => {
    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const appendCalls = fsMocks.appendFileSync.mock.calls;
    for (const call of appendCalls) {
      const content = call[1] as string;
      expect(content).toContain('export PATH="/opt/minimax/data/bin:$PATH"');
      expect(content).toContain('# Added by MiniMax Code');
    }
  });

  it('is idempotent — does not append if PATH_MARKER already present in .bashrc', async () => {
    fsMocks.existsSync.mockImplementation(
      (p: string) => p === '/home/testuser/.bashrc',
    );
    fsMocks.readFileSync.mockImplementation((p: string) => {
      if (p === '/home/testuser/.bashrc') {
        return '# existing content\n# Added by MiniMax Code\nexport PATH="/old:$PATH"\n';
      }
      return '';
    });

    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const writtenFiles = fsMocks.appendFileSync.mock.calls.map(
      (call) => call[0] as string,
    );

    // .bashrc should be skipped because it already has the marker.
    expect(writtenFiles).not.toContain('/home/testuser/.bashrc');
    // .zshrc should still be written (it does not have the marker).
    expect(writtenFiles).toContain('/home/testuser/.zshrc');
  });

  it('is idempotent — does not append if PATH_MARKER already present in .zshrc', async () => {
    fsMocks.existsSync.mockImplementation(
      (p: string) => p === '/home/testuser/.zshrc',
    );
    fsMocks.readFileSync.mockImplementation((p: string) => {
      if (p === '/home/testuser/.zshrc') {
        return '# Added by MiniMax Code\nexport PATH="/old:$PATH"\n';
      }
      return '';
    });

    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const writtenFiles = fsMocks.appendFileSync.mock.calls.map(
      (call) => call[0] as string,
    );

    // .zshrc should be skipped.
    expect(writtenFiles).not.toContain('/home/testuser/.zshrc');
    // .bashrc should still be written.
    expect(writtenFiles).toContain('/home/testuser/.bashrc');
  });

  it('is fully idempotent — skips both files when both already contain the marker', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('# Added by MiniMax Code\nexport PATH="/old:$PATH"\n');

    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });

  it('does not throw when HOME is inaccessible', async () => {
    osMocks.homedir.mockReturnValue('/home/testuser');
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.appendFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const ensurePathIntegration = await importModule();
    expect(() => ensurePathIntegration('/opt/minimax/data')).not.toThrow();
  });
});

describe('ensurePathIntegration — macOS', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    osMocks.homedir.mockReturnValue('/Users/testuser');
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue('');
  });

  it('writes PATH export to both .zshrc and .bashrc on macOS', async () => {
    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const writtenFiles = fsMocks.appendFileSync.mock.calls.map(
      (call) => call[0] as string,
    );

    expect(writtenFiles).toContain('/Users/testuser/.zshrc');
    expect(writtenFiles).toContain('/Users/testuser/.bashrc');
    expect(writtenFiles).toHaveLength(2);
  });

  it('macOS behaviour is unchanged — .zshrc comes before .bashrc', async () => {
    const ensurePathIntegration = await importModule();
    ensurePathIntegration('/opt/minimax/data');

    const writtenFiles = fsMocks.appendFileSync.mock.calls.map(
      (call) => call[0] as string,
    );

    expect(writtenFiles[0]).toBe('/Users/testuser/.zshrc');
    expect(writtenFiles[1]).toBe('/Users/testuser/.bashrc');
  });
});

describe('ensurePathIntegration — Windows', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    osMocks.homedir.mockReturnValue('C:\\Users\\testuser');
  });

  it('uses registry, not shell rc files', async () => {
    childProcessMocks.execFileSync.mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (cmd === 'reg' && args?.[0] === 'query') {
          return 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\old\r\n';
        }
        return '';
      },
    );

    const ensurePathIntegration = await importModule();
    ensurePathIntegration('C:\\minimax\\data');

    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    // The first call should be the registry query.
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      'reg',
      ['query', 'HKCU\\Environment'],
      expect.any(Object),
    );
  });
});
