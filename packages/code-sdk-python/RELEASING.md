# Releasing `minimax-code-sdk`

The Python SDK is published to the public PyPI index as `minimax-code-sdk` by the
`Python SDK release` workflow (`.github/workflows/python-sdk-release.yml`) using PyPI Trusted
Publishing. No PyPI token is stored in the repository or in GitHub secrets. It is versioned
independently of the CLI and of `@minimax-ai/code-sdk`.

## Rules

- Publish only from a commit on `main` that went through a reviewed pull request. The workflow
  rejects a tag whose commit is not contained in `origin/main`.
- A published version is immutable. PyPI never accepts the same file name twice, even after a
  release is deleted. Fix problems in a new version; prefer **yanking** a broken release over
  deleting it.
- Versions are stable `X.Y.Z`. There is no prerelease channel yet.
- Release tags are `code-sdk-python-vX.Y.Z`. They are separate from CLI tags (`vX.Y.Z`) and
  TypeScript SDK tags (`code-sdk-vX.Y.Z`). Never move or delete a pushed release tag.
- Do not upload from a workstation. If the workflow is unavailable, fix the workflow.

## One-time setup

1. The PyPI project `minimax-code-sdk` belongs to the `minimax-ai` PyPI organization. Every
   owner and maintainer account uses two-factor authentication.
2. On PyPI, add a Trusted Publisher (a *pending* publisher before the first upload) with:

   | Field | Value |
   | --- | --- |
   | PyPI project name | `minimax-code-sdk` |
   | Owner | `MiniMax-AI` |
   | Repository | `minimax-code` |
   | Workflow | `python-sdk-release.yml` |
   | Environment | `pypi` |

3. For rehearsals, add the same publisher on TestPyPI with environment `testpypi`. TestPyPI
   accounts and projects are separate from PyPI.
4. In the GitHub repository settings, create the environments `pypi` and `testpypi`. Give
   `pypi` required reviewers and restrict its deployment refs to `code-sdk-python-v*` tags.

## 1. Prepare the release in a pull request

1. Update `version` in `packages/code-sdk-python/pyproject.toml` and `__version__` in
   `src/minimax_code/__init__.py`.
2. Add a section at the top of `CHANGELOG.md`: `## X.Y.Z · YYYY-MM-DD` with the user-visible
   changes.
3. If the minimum supported CLI, the Python range or the event `schemaVersion` changes, update the
   README and `MIN_CLI_VERSION` in `src/minimax_code/_cli.py`.
4. Run the local checks:

   ```bash
   cd packages/code-sdk-python
   uv sync --locked
   uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -W error
   uv run python scripts/release_check.py metadata --index pypi
   ```

5. Merge the pull request into `main` after the usual review and checks.

## 2. Optional: rehearse on TestPyPI

Run the `Python SDK release` workflow manually with `repository: testpypi`. It runs every
check below and uploads to TestPyPI. Each version can be uploaded to TestPyPI only once, so
rehearse only versions you intend to release. A manual run with `repository: none` builds and
checks without uploading anywhere.

## 3. Tag and publish

```bash
git switch main
git pull --ff-only
git tag -a code-sdk-python-vX.Y.Z -m "minimax-code-sdk X.Y.Z"
git push origin code-sdk-python-vX.Y.Z
```

The tag push starts the workflow. Its `build` job:

1. checks that the tag matches `pyproject.toml`, `__version__` and the first CHANGELOG heading,
   that the tagged commit is on `origin/main`, and that the version is not on PyPI yet;
2. runs ruff, mypy and the test suite;
3. builds the wheel and sdist with `uv build` and runs `twine check --strict`;
4. runs `scripts/release_check.py dist`, which rejects unexpected wheel entries, local or
   generated files and unsafe paths in the sdist, and prints the sha256 of both files;
5. scans the extracted archives with the repository's public text policy
   (`scripts/lib/public-text-policy.mjs`) and Gitleaks;
6. installs the wheel into an empty virtual environment and checks `minimax_code.__version__`.

The `publish-pypi` job then waits for approval on the `pypi` environment and uploads exactly the
checked files with `pypa/gh-action-pypi-publish`, which also attaches PyPI attestations.

## 4. Read back

```bash
curl -fsS https://pypi.org/pypi/minimax-code-sdk/X.Y.Z/json \
  | python3 -c 'import json,sys; [print(u["digests"]["sha256"], u["filename"]) for u in json.load(sys.stdin)["urls"]]'
```

Both digests must equal the `sha256` lines printed by the `Check distribution contents` step. If
they differ, stop: the index holds different bytes than the checked files.

## 5. Smoke test the published package

```bash
smoke="$(mktemp -d)" && cd "$smoke"
uv venv -q && uv pip install -q "minimax-code-sdk==X.Y.Z"
.venv/bin/python -c "import minimax_code; print(minimax_code.__version__, minimax_code.MCode)"
```

It must print `X.Y.Z` and the `MCode` class. PyPI's CDN can take a few minutes to serve a new
version.

## Failure handling

- **The `build` job fails**: nothing was published. Fix it in a pull request, merge, and tag a new
  commit. If the version number itself was wrong, use a new version; do not reuse the tag.
- **`publish-pypi` fails before upload** (Trusted Publisher mismatch, network): fix the cause and
  re-run the failed job of the same workflow run. The artifact is the already checked build.
- **Upload accepted but read-back fails**: wait and repeat the read-back. Do not re-run the upload
  unless PyPI confirms the version does not exist.
- **Digests differ or the smoke test fails**: the version is published and cannot be replaced.
  Release a fixed version and yank the broken one on PyPI (*Manage project → Releases → Options →
  Yank*) with a reason.
