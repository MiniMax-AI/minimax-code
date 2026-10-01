import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Test-only packaging infrastructure belongs to the repository root, not a runtime package.
// eslint-disable-next-line import/no-relative-packages
import { packageExportEntries } from '../../../../scripts/lib/package-exports.mjs';
// eslint-disable-next-line import/no-relative-packages -- read the source-only bundle scope
import { readExtraction } from '../../../../scripts/lib/release-metadata.mjs';
// eslint-disable-next-line import/no-relative-packages -- reuse the real bundle module-location contract
import { createTuiBundleModuleLocationConfig } from '../../../../scripts/lib/tui-npm-bundle-profile.mjs';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, open, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { loadTuiImagePreview } from '../../src/host/image-preview.js';
import { TuiComposerImagePreview } from '../../src/tui/features/composer/image-preview.js';
import {
  getCapabilities,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from '../../src/tui/engine/public.js';
import type { TuiAttachment } from '../../src/application/invocation.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4n8LwnxLMMGrAqAGjBgwXAwCOqWIfmQV0zAAAAABJRU5ErkJggg==';
const capabilities = getCapabilities();
afterEach(() => setCapabilities(capabilities));

function fixture(load = vi.fn(async () => ({ png, dimensions: { widthPx: 1, heightPx: 1 } }))) {
  let selection: { id: string; label: string } | undefined = {
    id: '/a.png',
    label: '[Image #1]',
  };
  let rows = 40;
  const attachments: TuiAttachment[] = ['/a.png', '/b.png'].map((filePath) => ({
    type: 'image',
    filePath,
    fileName: filePath.slice(1),
    mimeType: 'image/png',
    sizeBytes: 1024,
  }));
  const requestRender = vi.fn();
  const preview = new TuiComposerImagePreview({
    editor: { getAttachmentPreview: () => selection },
    terminalRows: () => rows,
    requestRender,
    load,
  });
  preview.setAttachmentSource(() => attachments);
  return {
    preview,
    load,
    requestRender,
    select: (next: typeof selection) => {
      selection = next;
    },
    resize: (next: number) => {
      rows = next;
    },
  };
}

describe('composer image preview', () => {
  it('loads an edited image by path while using its editor identity', async () => {
    const { preview, load, select } = fixture();
    select({ id: 'edit:image', label: '[Image #1]' });
    preview.setAttachmentSource(() => [
      {
        id: 'edit:image',
        type: 'image',
        filePath: '/retained.png',
        fileName: 'retained.png',
        mimeType: 'image/png',
      },
    ]);
    preview.render(100);
    expect(load).toHaveBeenCalledWith('/retained.png', 'image/png', expect.any(AbortSignal));
    await vi.waitFor(() =>
      expect(stripTerminalSequences(preview.render(100).join('\n'))).toContain('1 × 1'),
    );
    preview.dispose();
  });

  it('shows asset-only image metadata without attempting to read a fabricated path', async () => {
    const { preview, load, select } = fixture();
    select({ id: 'edit:asset', label: '[Image #1]' });
    preview.setAttachmentSource(() => [
      {
        id: 'edit:asset',
        type: 'image',
        fileName: 'retained.png',
        mimeType: 'image/png',
      },
    ]);
    const rendered = stripTerminalSequences(preview.render(100).join('\n'));
    expect(rendered).toContain('[Image #1]');
    expect(rendered).toContain('retained.png');
    expect(rendered).not.toContain('NaN');
    await vi.waitFor(() => expect(load).not.toHaveBeenCalled());
    preview.dispose();
  });

  it('shows metadata without graphics on unsupported terminals', async () => {
    setCapabilities({ ...capabilities, images: null });
    const { preview, load } = fixture();
    preview.render(100);
    await vi.waitFor(() =>
      expect(stripTerminalSequences(preview.render(100).join('\n'))).toContain('1 × 1'),
    );
    expect(preview.render(100).join('\n')).toContain('image/png');
    expect(preview.render(100).join('\n')).toContain('1 KB');
    expect(preview.render(100).join('\n')).not.toContain('\x1b_G');
    preview.render(100);
    expect(load).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it('renders PNG pixels on Kitty and stays within a short terminal', async () => {
    setCapabilities({ ...capabilities, images: 'kitty' });
    const { preview, resize } = fixture();
    preview.render(80);
    await vi.waitFor(() => expect(preview.render(80).join('\n')).toContain('\x1b_G'));
    resize(18);
    expect(preview.render(80).length).toBeLessThanOrEqual(10);
    preview.dispose();
  });

  it('does not let an old read replace the selected image or resurrect a dismissed preview', async () => {
    let finishFirst:
      | ((value: { png: string; dimensions: { widthPx: number; heightPx: number } }) => void)
      | undefined;
    const first = new Promise<{ png: string; dimensions: { widthPx: number; heightPx: number } }>(
      (resolve) => {
        finishFirst = resolve;
      },
    );
    const load = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ png, dimensions: { widthPx: 22, heightPx: 33 } });
    const { preview, select, requestRender } = fixture(load);
    preview.render(80);
    select({ id: '/b.png', label: '[Image #2]' });
    preview.render(80);
    await vi.waitFor(() =>
      expect(stripTerminalSequences(preview.render(80).join('\n'))).toContain('22 × 33'),
    );
    finishFirst?.({ png, dimensions: { widthPx: 99, heightPx: 99 } });
    await first;
    expect(stripTerminalSequences(preview.render(80).join('\n'))).not.toContain('99 × 99');
    select(undefined);
    expect(preview.render(80)).toEqual([]);
    const calls = requestRender.mock.calls.length;
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledTimes(calls);
    preview.dispose();
  });

  it('keeps a failed preview nonfatal and clips metadata at narrow widths', async () => {
    const { preview } = fixture(vi.fn().mockRejectedValue(new Error('missing')));
    preview.render(80);
    await vi.waitFor(() => expect(preview.render(80).join('\n')).not.toMatch(/Loading|正在加载/));
    expect(preview.render(80).join('\n')).toContain('a.png');
    expect(preview.render(16).every((line) => visibleWidth(line) <= 16)).toBe(true);
    expect(preview.render(5)).toEqual([]);
    preview.dispose();
  });
});

describe('preview file loader', () => {
  let bundleDir: string;
  let loadPreview: typeof loadTuiImagePreview;
  beforeAll(async () => {
    // CI runs workspace source aliases without dist/. Exercise the shipped worker
    // boundary by bundling both entries, instead of relying on a developer's build artifacts.
    bundleDir = await mkdtemp(join(tmpdir(), 'mcode-preview-bundle-'));
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const location = createTuiBundleModuleLocationConfig();
    const entries = packageExportEntries(root, readExtraction(root).packageRoots);
    const bundle = await build({
      entryPoints: {
        'image-preview': join(root, 'packages/tui/src/host/image-preview.ts'),
        'image-preview-worker': join(root, 'packages/tui/src/host/image-preview-worker.ts'),
      },
      outdir: bundleDir,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: { js: location.banner },
      define: location.define,
      // Production bundles canonical dist entries; source-only tests resolve the
      // same package entrypoints to src and verify that no Pi dist leaked in.
      metafile: true,
      plugins: [
        {
          name: 'preview-test-pi-source',
          setup(builder) {
            builder.onResolve({ filter: /^@earendil-works\/pi-/ }, ({ path }) => {
              const entry = entries.find((candidate) => candidate.specifier === path);
              if (!entry) return undefined;
              return {
                path: join(root, entry.file),
              };
            });
          },
        },
      ],
      logLevel: 'silent',
    });
    expect(
      Object.keys(bundle.metafile.inputs).some((path) =>
        /pi-mono\/packages\/[^/]+\/dist\//.test(path.split(sep).join('/')),
      ),
    ).toBe(false);
    await writeFile(join(bundleDir, 'package.json'), '{"type":"module"}');
    const require = createRequire(
      join(root, 'third_party/pi-mono/packages/coding-agent/package.json'),
    );
    await copyFile(
      require.resolve('@silvia-odwyer/photon-node/photon_rs_bg.wasm'),
      join(bundleDir, 'photon_rs_bg.wasm'),
    );
    const module = await import(
      /* @vite-ignore */ pathToFileURL(join(bundleDir, 'image-preview.js')).href
    );
    loadPreview = module.loadTuiImagePreview;
  }, 20_000);
  afterAll(async () => {
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  it('skips oversized files and excessive decoded dimensions before launching a decoder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-image-limit-'));
    try {
      const path = join(dir, 'large.png');
      const file = await open(path, 'w');
      await file.truncate(21 * 1024 * 1024);
      await file.close();
      expect(await loadPreview(path, 'image/png', new AbortController().signal)).toEqual({});
      const bytes = Buffer.from(png, 'base64');
      bytes.writeUInt32BE(100_000, 16);
      bytes.writeUInt32BE(100_000, 20);
      await writeFile(path, bytes);
      expect(await loadPreview(path, 'image/png', new AbortController().signal)).toEqual({
        dimensions: { widthPx: 100_000, heightPx: 100_000 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a real PNG without modifying it and rejects cancelled reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-image-preview-'));
    try {
      const path = join(dir, 'a.png');
      await writeFile(path, Buffer.from(png, 'base64'));
      const result = await loadPreview(path, 'image/png', new AbortController().signal);
      expect(result.dimensions).toEqual({ widthPx: 16, heightPx: 16 });
      expect(result.png).toBe(png);
      expect((await readFile(path)).toString('base64')).toBe(png);
      const jpegPath = join(dir, 'a.jpg');
      await writeFile(
        jpegPath,
        Buffer.from(
          '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAAQABADAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDIr5A/SAoAKACgD//Z',
          'base64',
        ),
      );
      const jpegResult = await loadPreview(jpegPath, 'image/jpeg', new AbortController().signal);
      expect(jpegResult.dimensions).toEqual({ widthPx: 16, heightPx: 16 });
      expect(jpegResult.png?.startsWith('iVBOR')).toBe(true);
      const abort = new AbortController();
      abort.abort();
      await expect(loadPreview(path, 'image/png', abort.signal)).rejects.toThrow();
      await writeFile(path, 'not an image');
      expect(await loadPreview(path, 'image/png', new AbortController().signal)).toEqual({
        dimensions: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
