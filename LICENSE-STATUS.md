# License status

The default license for first-party code is [MIT](LICENSE), including the root workspace and first-party package manifests. The root `LICENSE` and `NOTICE` use the maintainer-supplied attribution **MiniMax Code**. Existing third-party and file-level declarations take precedence for those materials; this change does not relicense upstream code, dependencies or assets.

## Third-party exceptions

- `third_party/sandbox-runtime` remains **Apache-2.0**, including its retained upstream copyright and modification notices. Its `LICENSE` must accompany distributions containing that component; retain any applicable upstream notices.
- Pi, derived terminal code, the model catalog and bundled assets retain their original declarations. See [Third-party notices](THIRD_PARTY_NOTICES.md) and the relevant file/package notices.
- `release/dependency-licenses.json` records dependencies' declared licenses without changing their terms. Binary or installer distributions must retain applicable license texts and notices, including those for bundled native dependencies.

The root MIT license is not a statement that every file or bundled component is MIT-licensed.

## Publication scope

The reviewed repository boundary is recorded in [Publication scope](docs/publication-authorization.md) and `release/public-source.json`. It covers the committed source tree under its existing licenses. npm packages, installers, paid services, third-party accounts, and internal Git history remain separate from this source distribution.

## Attribution history

On 2026-09-12, review found that the original root license had been copied from Sandbox Runtime and contained Anthropic's attribution. It was corrected to the standard Apache-2.0 text; the subsequently supplied first-party attribution was recorded in `NOTICE`. The first-party default is now MIT, using that same attribution. Sandbox Runtime's original Apache-2.0 license and copyright remain unchanged.

The source gate pins the reviewed MIT license hash so a vendor-specific license cannot silently replace the root license during source synchronization.
