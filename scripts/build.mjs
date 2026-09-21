import { build } from "esbuild";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from "node:url";
import path from "node:path";
import { copyLocalRuntimeAssets } from "./lib/local-runtime-assets.mjs";
import { createTuiBundleModuleLocationConfig } from "./lib/tui-npm-bundle-profile.mjs";
import { shouldCopyTuiRuntimeResource } from "./lib/tui-package-privacy.mjs";
import { TUI_DISABLED_BUILTIN_SKILL_NAMES } from "./lib/builtin-skills.mjs";
import { copyMcodeToolsArtifact } from './lib/mcode-tools-artifact.mjs';
import { readExtraction } from "./lib/release-metadata.mjs";
import { cliBuildVersion, cliExternalModules } from './lib/cli-release.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = readExtraction(root);
const packages = new Map(
  metadata.packageRoots.map((directory) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    return [manifest.name, { directory, manifest }];
  }),
);
const location = createTuiBundleModuleLocationConfig();
const outdir = path.join(root, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Bundle checked-in workspace sources and resolve npm dependencies from each importer.
// Native and optional platform integrations keep their installed module locations.
const sourcePlugin = {
  name: "standalone-workspace-sources",
  setup(bundler) {
    bundler.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
      const parts = specifier.split("/");
      const name = specifier.startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0];
      const pkg = packages.get(name);
      if (!pkg) return undefined;
      const subpath =
        specifier === name ? "." : `.${specifier.slice(name.length)}`;
      const exports = pkg.manifest.exports;
      const exported =
        exports?.[subpath] ?? (subpath === "." ? exports : undefined);
      const target =
        (typeof exported === "string"
          ? exported
          : (exported?.types ?? exported?.import ?? exported?.default)) ??
        (subpath === "." ? pkg.manifest.types : undefined);
      if (typeof target !== "string" || !target.startsWith("./"))
        throw new Error(`Unmapped workspace export: ${specifier}`);
      const source = target
        .replace(/^\.\/dist\//, "./src/")
        .replace(/\.d\.ts$/, ".ts")
        .replace(/\.js$/, ".ts");
      const directory = path.join(root, pkg.directory);
      const resolved = path.resolve(directory, source);
      if (
        path.relative(directory, resolved).startsWith("..") ||
        !existsSync(resolved)
      )
        throw new Error(`Missing workspace source: ${specifier}`);
      return { path: resolved };
    });
  },
};
const version = cliBuildVersion(root);
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    cli: "packages/tui/src/index.ts",
    "image-preview-worker": "packages/tui/src/host/image-preview-worker.ts",
    'mcode-tools': 'packages/tui/src/cli/mcode-tools-entry.ts',
    'matrix-mcp-stdio': 'packages/agent-tools/src/desktop/matrix-mcp-stdio.ts',
  },
  external: cliExternalModules,
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  minifyIdentifiers: true,
  minifyWhitespace: true,
  target: "node22",
  chunkNames: "chunks/[name]-[hash]",
  banner: { js: location.banner },
  plugins: [sourcePlugin],
  metafile: true,
  define: {
    ...location.define,
    __CLI_VERSION__: JSON.stringify(version),
    __CLI_CHANNEL__: '"source"',
    __IS_NPM_BUILD__: "true",
    __BUILD_PROFILE__: '"tui"',
    __TUI_BUILD_ENV__: '"prod"',
    __TUI_BUILD_VARIANT__: '"standard"',
    __TUI_NPM_DIST_TAG__: '"latest"',
  },
  logLevel: "info",
});
copyLocalRuntimeAssets({
  repositoryRoot: root,
  outputDir: outdir,
  filter: shouldCopyTuiRuntimeResource,
  excludedBuiltinSkillNames: TUI_DISABLED_BUILTIN_SKILL_NAMES,
});
for (const name of ["configs", "native"])
  cpSync(path.join(root, "packages/tui", name), path.join(outdir, name), {
    recursive: true,
  });
for (const name of ["seccomp", "srt-win", "java-proxy-agent"]) {
  cpSync(
    path.join(root, "third_party/sandbox-runtime/vendor", name),
    path.join(outdir, "vendor", name),
    { recursive: true },
  );
}
chmodSync(path.join(outdir, "cli.js"), 0o755);
await copyMcodeToolsArtifact(root, outdir);
cpSync(path.join(root, 'packages/tui/src/cli/mcode-tools-launchers'), path.join(outdir, 'internal-bin'), { recursive: true });
for (const name of ['internal-bin/mcode-tools', 'mcode-tools.js', 'matrix-mcp-stdio.js'])
  chmodSync(path.join(outdir, name), 0o755);
writeFileSync(
  path.join(outdir, "metafile.json"),
  JSON.stringify(result.metafile, null, 2) + "\n",
);
console.log(
  `Built MiniMax Code ${version} from ${Object.keys(result.metafile.inputs).length} source files.`,
);

writeFileSync(
  path.join(outdir, "package.json"),
  JSON.stringify(
    {
      name: "@minimax-ai/code", version, type: "module", private: true,
      ...(process.env.MCODE_RELEASE_TAG ? {
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      } : {}),
    },
    null,
    2,
  ) + "\n",
);

const piRequire = createRequire(
  path.join(root, "third_party/pi-mono/packages/coding-agent/package.json"),
);
cpSync(
  piRequire.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
  path.join(outdir, "photon_rs_bg.wasm"),
);
