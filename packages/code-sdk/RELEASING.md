# Releasing `@minimax-ai/code-sdk`

The SDK is published manually by a maintainer to the public npm registry as
`@minimax-ai/code-sdk`, with the `latest` dist-tag only. It is versioned independently of the CLI.
This file is not part of the npm package.

## Rules

- Publish only to `https://registry.npmjs.org/`. `package.json#publishConfig.registry` and
  `--registry` only replace the **default** registry. A scoped setting such as
  `@minimax-ai:registry=<mirror>` in any npmrc still wins for this `@minimax-ai/*` package, for
  `npm publish` as well as for `npm view`. Every npm command below therefore passes both
  `--registry=https://registry.npmjs.org/` and `--@minimax-ai:registry=https://registry.npmjs.org/`,
  and `release:check` refuses to run while a different `@minimax-ai:registry` is configured.
- A published version is immutable. Never try to republish or overwrite an exact version; fix
  problems in a new version. Prefer `npm deprecate` over `npm unpublish` for a broken release.
- Versions are stable `X.Y.Z`. There is no prerelease channel yet.
- Publish only from a commit on `main` that went through a reviewed pull request.

## 1. Prepare the release in a pull request

1. Update `packages/code-sdk/package.json#version`.
2. Add a section at the top of `packages/code-sdk/CHANGELOG.md`:
   `## X.Y.Z · YYYY-MM-DD` with the user-visible changes.
3. If the minimum supported CLI, the Node.js range or the event `schemaVersion` changes, update
   the compatibility table in the README.
4. Merge the pull request into `main` after the usual review and checks.

## 2. Run the release check on a clean `main`

```bash
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @minimax-ai/code-sdk run release:check
```

`release:check` never publishes. It:

1. reads the effective npm configuration and fails if `@minimax-ai:registry` points anywhere other
   than npmjs (check with `npm config get @minimax-ai:registry`; remove it with
   `npm config delete @minimax-ai:registry` or override it for the release);
2. requires a clean working tree on `main` equal to `origin/main`;
3. checks that the version is `X.Y.Z`, matches the first CHANGELOG section, and is not on npm yet;
   that the package is not private, pins `publishConfig`, has no runtime dependencies and publishes
   only `dist`, `src`, `README.md` and `CHANGELOG.md` (npm adds `package.json` and `LICENSE`);
4. builds, type-checks and runs the SDK test suite;
5. runs `npm pack`, rejects unexpected tarball entries, and scans every packed file for internal
   host names, credentials, local user paths (`/Users/…`, `/home/<name>/`, `/root/`,
   `/private/var/folders/…`, `C:\Users\…` and the escaped `C:\\Users\\…` form), other repository
   package paths and internal package names;
6. installs the tarball into an empty project and checks both `import` and `require`;
7. prints the exact `npm publish` command for the checked tarball and the read-back commands.

Use `-- --allow-non-main` only to rehearse on a feature branch; it ends with a warning instead of a
publish command. Use `-- --offline` to skip the npm lookup when the registry is unreachable.

The check runs on macOS and Linux, where it has been exercised. It starts every tool without a
shell; on Windows it runs npm and pnpm through their JS entries (`npm-cli.js` next to Node.js and
the pnpm script that started it), which has not been exercised on a Windows machine yet.

## 3. Publish

Do not run `npm publish` in `packages/code-sdk`. That package is the first non-private workspace
package, and its `prepublishOnly` script refuses a directory publish so a fresh checkout cannot
skip `release:check` and upload a package without `dist`. Publishing the checked tarball does not
run that script.

Run the printed command yourself. It publishes the tarball that was just checked:

```bash
npm login --registry=https://registry.npmjs.org/    # if needed; 2FA is required
npm publish /tmp/code-sdk-release-XXXX/minimax-ai-code-sdk-X.Y.Z.tgz \
  --registry=https://registry.npmjs.org/ --@minimax-ai:registry=https://registry.npmjs.org/ \
  --access public --tag latest
```

npm may keep a new version in validation for a while; `npm view` can return 404 until it is
available.

## 4. Read back

```bash
npm view @minimax-ai/code-sdk@X.Y.Z version dist.integrity \
  --registry=https://registry.npmjs.org/ --@minimax-ai:registry=https://registry.npmjs.org/
npm view @minimax-ai/code-sdk dist-tags \
  --registry=https://registry.npmjs.org/ --@minimax-ai:registry=https://registry.npmjs.org/
```

The integrity must equal the value printed by `release:check`, and `latest` must point to
`X.Y.Z`. If the integrity differs, stop: the registry holds different bytes than the checked
tarball. Investigate and publish a new version; never overwrite.

## 5. Smoke test the published package

```bash
smoke="$(mktemp -d)" && cd "$smoke"
echo '{"name":"code-sdk-smoke","private":true}' > package.json
npm install @minimax-ai/code-sdk@X.Y.Z --no-package-lock \
  --registry=https://registry.npmjs.org/ --@minimax-ai:registry=https://registry.npmjs.org/
node --input-type=module -e "const sdk = await import('@minimax-ai/code-sdk'); console.log(typeof sdk.MCode)"
node -e "console.log(typeof require('@minimax-ai/code-sdk').MCode)"
```

Both commands must print `function`.

## 6. Optional: tag the release

```bash
git tag -a code-sdk-vX.Y.Z -m "@minimax-ai/code-sdk X.Y.Z" <published commit>
git push origin code-sdk-vX.Y.Z
```

The tag only records the source of a published version; no automation publishes from it. Never
move or delete a pushed release tag.

## Failure handling

- **`release:check` fails**: nothing was published. Fix it in a pull request and start over.
- **`npm publish` fails before upload** (authentication, network): fix the cause and run the same
  command again.
- **Upload accepted but read-back fails or times out**: wait and repeat the read-back. Do not
  publish again unless `npm view` confirms the version does not exist.
- **Read-back shows different integrity, or the smoke test fails**: the version is published and
  cannot be replaced. Release a fixed version; deprecate the broken one with
  `npm deprecate @minimax-ai/code-sdk@X.Y.Z "<reason>" --registry=https://registry.npmjs.org/ --@minimax-ai:registry=https://registry.npmjs.org/`
  if users should avoid it.
