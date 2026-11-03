from __future__ import annotations

import importlib.util
import io
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Any

import pytest

import minimax_code

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "release_check.py"
_spec = importlib.util.spec_from_file_location("release_check", _SCRIPT)
assert _spec is not None and _spec.loader is not None
rc: Any = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = rc  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(rc)


def project(
    tmp_path: Path, *, version: str = "1.2.3", init: str = "1.2.3", log: str = "1.2.3"
) -> Path:
    (tmp_path / "src" / "minimax_code").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text(
        f'[build-system]\nrequires = []\n\n[project]\nname = "x"\nversion = "{version}"\n'
    )
    (tmp_path / "src" / "minimax_code" / "__init__.py").write_text(f'__version__ = "{init}"\n')
    (tmp_path / "CHANGELOG.md").write_text(
        f"# Changelog\n\n## {log} · 2026-01-02\n\n## 0.0.1 · 2025-01-01\n"
    )
    return tmp_path


def test_repository_metadata_is_consistent() -> None:
    assert rc.check_metadata() == minimax_code.__version__


def test_metadata_accepts_matching_tag(tmp_path: Path) -> None:
    assert rc.check_metadata(project(tmp_path), tag="code-sdk-python-v1.2.3") == "1.2.3"


@pytest.mark.parametrize(
    ("kwargs", "tag", "message"),
    [
        ({"init": "1.2.2"}, None, "__version__"),
        ({"log": "1.2.2"}, None, "CHANGELOG"),
        ({"version": "1.2", "init": "1.2", "log": "1.2"}, None, "X.Y.Z"),
        ({}, "v1.2.3", "does not match"),
    ],
)
def test_metadata_rejects_mismatches(
    tmp_path: Path, kwargs: dict[str, str], tag: str | None, message: str
) -> None:
    with pytest.raises(rc.ReleaseCheckError, match=message):
        rc.check_metadata(project(tmp_path, **kwargs), tag=tag)


def build_dist(
    dist: Path, version: str, *, wheel_extra: str | None = None, sdist_extra: str | None = None
) -> None:
    dist.mkdir()
    info = f"minimax_code_sdk-{version}.dist-info"
    with zipfile.ZipFile(dist / f"minimax_code_sdk-{version}-py3-none-any.whl", "w") as wheel:
        for name in (
            "minimax_code/__init__.py",
            "minimax_code/py.typed",
            f"{info}/METADATA",
            f"{info}/licenses/LICENSE",
        ):
            wheel.writestr(name, "")
        if wheel_extra:
            wheel.writestr(wheel_extra, "")
    prefix = f"minimax_code_sdk-{version}/"
    with tarfile.open(dist / f"minimax_code_sdk-{version}.tar.gz", "w:gz") as sdist:
        names = [
            prefix + n
            for n in ("PKG-INFO", "pyproject.toml", "README.md", "CHANGELOG.md", "LICENSE")
        ]
        for name in [*names, *([sdist_extra] if sdist_extra else [])]:
            info_ = tarfile.TarInfo(name)
            sdist.addfile(info_, io.BytesIO(b""))


def test_dist_accepts_expected_archives_and_extracts(tmp_path: Path) -> None:
    build_dist(tmp_path / "dist", "1.2.3")
    digests = rc.check_dist(tmp_path / "dist", "1.2.3", tmp_path / "out")
    assert sorted(digests) == [
        "minimax_code_sdk-1.2.3-py3-none-any.whl",
        "minimax_code_sdk-1.2.3.tar.gz",
    ]
    assert (tmp_path / "out" / "wheel" / "minimax_code" / "py.typed").exists()
    assert (tmp_path / "out" / "sdist" / "minimax_code_sdk-1.2.3" / "CHANGELOG.md").exists()


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"wheel_extra": "tests/test_sdk.py"}, "unexpected entry"),
        ({"wheel_extra": "minimax_code/__pycache__/x.cpython-313.pyc"}, "bytecode"),
        ({"sdist_extra": "minimax_code_sdk-1.2.3/.venv/bin/python"}, "local or generated"),
        ({"sdist_extra": "minimax_code_sdk-1.2.3/.env"}, "local or generated"),
        ({"sdist_extra": "../escape.txt"}, "not a regular relative file"),
    ],
)
def test_dist_rejects_unexpected_content(
    tmp_path: Path, kwargs: dict[str, str], message: str
) -> None:
    build_dist(tmp_path / "dist", "1.2.3", **kwargs)
    with pytest.raises(rc.ReleaseCheckError, match=message):
        rc.check_dist(tmp_path / "dist", "1.2.3")


def test_dist_rejects_wrong_version(tmp_path: Path) -> None:
    build_dist(tmp_path / "dist", "1.2.3")
    with pytest.raises(rc.ReleaseCheckError, match="exactly"):
        rc.check_dist(tmp_path / "dist", "1.2.4")
