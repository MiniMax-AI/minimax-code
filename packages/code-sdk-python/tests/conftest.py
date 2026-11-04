from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

FAKE = Path(__file__).with_name("fake_mcode.py")


@pytest.fixture
def fake_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    if sys.platform == "win32":
        pytest.skip("the fake CLI is a POSIX script; Windows runs the resolver and option tests")
    record = tmp_path / "calls.jsonl"
    env = dict(os.environ)
    env.update({"MCODE_BIN": str(FAKE), "FAKE_MCODE_RECORD": str(record)})
    return env
