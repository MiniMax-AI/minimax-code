"""Release checks for minimax-code-sdk. Never builds or publishes; see RELEASING.md.

    python scripts/release_check.py metadata [--tag TAG] [--index pypi|testpypi]
    python scripts/release_check.py dist DIST_DIR --version X.Y.Z [--extract DIR]

``metadata`` prints the checked version on stdout. Diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

PROJECT = "minimax-code-sdk"
DIST_NAME = "minimax_code_sdk"
IMPORT_NAME = "minimax_code"
TAG_PREFIX = "code-sdk-python-v"
ROOT = Path(__file__).resolve().parent.parent
INDEXES = {"pypi": "https://pypi.org", "testpypi": "https://test.pypi.org"}

_VERSION = re.compile(r"\d+\.\d+\.\d+")
_PROJECT_VERSION = re.compile(r'^version\s*=\s*"([^"]*)"\s*$', re.MULTILINE)
_INIT_VERSION = re.compile(r'^__version__\s*=\s*"([^"]*)"\s*$', re.MULTILINE)
_CHANGELOG_HEADING = re.compile(r"^## (\S+) · (\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)
_SDIST_REQUIRED = ("PKG-INFO", "pyproject.toml", "README.md", "CHANGELOG.md", "LICENSE")
_SDIST_FORBIDDEN = re.compile(
    r"(?:^|/)(?:\.venv|__pycache__|\.[a-z]+_cache|dist)(?:/|$)|(?:^|/)\.env"
)


class ReleaseCheckError(Exception):
    pass


@dataclass(frozen=True)
class Metadata:
    project_version: str | None
    init_version: str | None
    changelog_version: str | None


def _first(pattern: re.Pattern[str], text: str) -> str | None:
    match = pattern.search(text)
    return match.group(1) if match else None


def read_metadata(root: Path = ROOT) -> Metadata:
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
    project = (
        pyproject.split("[project]", 1)[1].split("\n[", 1)[0] if "[project]" in pyproject else ""
    )
    init = (root / "src" / IMPORT_NAME / "__init__.py").read_text(encoding="utf-8")
    changelog_path = root / "CHANGELOG.md"
    changelog = changelog_path.read_text(encoding="utf-8") if changelog_path.exists() else ""
    return Metadata(
        project_version=_first(_PROJECT_VERSION, project),
        init_version=_first(_INIT_VERSION, init),
        changelog_version=_first(_CHANGELOG_HEADING, changelog),
    )


def check_metadata(root: Path = ROOT, tag: str | None = None) -> str:
    """Returns the release version after checking that every declared version agrees."""
    meta = read_metadata(root)
    version = meta.project_version
    problems: list[str] = []
    if version is None or not _VERSION.fullmatch(version):
        problems.append(f"pyproject.toml [project].version must be X.Y.Z; found {version!r}.")
    if meta.init_version != version:
        problems.append(
            f"src/{IMPORT_NAME}/__init__.py __version__ is {meta.init_version!r}, "
            f"pyproject.toml has {version!r}."
        )
    if meta.changelog_version != version:
        problems.append(
            "The first CHANGELOG.md heading must be '## X.Y.Z · YYYY-MM-DD' for the release "
            f"version {version!r}; found {meta.changelog_version!r}."
        )
    if tag is not None and tag != f"{TAG_PREFIX}{version}":
        problems.append(f"Tag {tag!r} does not match version {version!r} ({TAG_PREFIX}X.Y.Z).")
    if problems:
        raise ReleaseCheckError("\n".join(problems))
    assert version is not None
    return version


def is_published(index: str, version: str, timeout: float = 30) -> bool:
    url = f"{INDEXES[index]}/pypi/{PROJECT}/{version}/json"
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise ReleaseCheckError(f"Could not query {url}: HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise ReleaseCheckError(f"Could not query {url}: {error.reason}") from error


def _safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts and "\\" not in name


def check_wheel(path: Path, version: str) -> list[str]:
    info = f"{DIST_NAME}-{version}.dist-info/"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
    problems = [
        f"wheel entry {n!r} is not a safe relative path." for n in names if not _safe_member(n)
    ]
    unexpected = [n for n in names if not (n.startswith(f"{IMPORT_NAME}/") or n.startswith(info))]
    problems += [f"wheel contains an unexpected entry {n!r}." for n in unexpected]
    for required in (f"{IMPORT_NAME}/__init__.py", f"{IMPORT_NAME}/py.typed", f"{info}METADATA"):
        if required not in names:
            problems.append(f"wheel is missing {required!r}.")
    if not any(n.startswith(f"{info}licenses/") for n in names):
        problems.append("wheel does not ship the LICENSE file.")
    problems += [f"wheel contains bytecode {n!r}." for n in names if n.endswith((".pyc", ".pyo"))]
    return problems


def check_sdist(path: Path, version: str) -> list[str]:
    prefix = f"{DIST_NAME}-{version}/"
    problems: list[str] = []
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
    names = {m.name for m in members}
    for member in members:
        if not _safe_member(member.name) or not (member.isfile() or member.isdir()):
            problems.append(f"sdist entry {member.name!r} is not a regular relative file.")
        elif not member.name.startswith(prefix):
            problems.append(f"sdist entry {member.name!r} is outside {prefix!r}.")
        elif _SDIST_FORBIDDEN.search(member.name[len(prefix) :]):
            problems.append(f"sdist contains a local or generated file {member.name!r}.")
    problems += [
        f"sdist is missing {prefix}{r}." for r in _SDIST_REQUIRED if prefix + r not in names
    ]
    return problems


def _extract(wheel: Path, sdist: Path, target: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(target / "wheel")
    with tarfile.open(sdist, "r:gz") as archive:
        if hasattr(tarfile, "data_filter"):
            archive.extractall(target / "sdist", filter="data")
        else:  # Members were already restricted to regular relative files.
            archive.extractall(target / "sdist")


def check_dist(dist: Path, version: str, extract: Path | None = None) -> dict[str, str]:
    """Checks the built wheel and sdist; returns their sha256 digests."""
    wheel = dist / f"{DIST_NAME}-{version}-py3-none-any.whl"
    sdist = dist / f"{DIST_NAME}-{version}.tar.gz"
    files = sorted(p.name for p in dist.iterdir() if p.is_file() and not p.name.startswith("."))
    if files != sorted([wheel.name, sdist.name]):
        raise ReleaseCheckError(
            f"{dist} must contain exactly {wheel.name} and {sdist.name}; found {files}."
        )
    problems = check_wheel(wheel, version) + check_sdist(sdist, version)
    if problems:
        raise ReleaseCheckError("\n".join(problems))
    if extract is not None:
        _extract(wheel, sdist, extract)
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (wheel, sdist)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    sub = parser.add_subparsers(dest="command", required=True)
    meta = sub.add_parser("metadata", help="check versions, changelog and tag")
    meta.add_argument("--tag", help=f"release tag, {TAG_PREFIX}X.Y.Z")
    meta.add_argument("--index", choices=sorted(INDEXES), help="fail if already published there")
    dist = sub.add_parser("dist", help="check the built wheel and sdist")
    dist.add_argument("dist_dir", type=Path)
    dist.add_argument("--version", required=True)
    dist.add_argument("--extract", type=Path, help="extract both archives here for scanning")
    args = parser.parse_args(argv)
    try:
        if args.command == "metadata":
            version = check_metadata(tag=args.tag)
            if args.index and is_published(args.index, version):
                raise ReleaseCheckError(
                    f"{PROJECT} {version} already exists on {args.index}; versions are immutable."
                )
            print(version)
        else:
            for name, digest in check_dist(args.dist_dir, args.version, args.extract).items():
                print(f"sha256 {digest}  {name}")
    except ReleaseCheckError as error:
        print(f"release check failed:\n{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
