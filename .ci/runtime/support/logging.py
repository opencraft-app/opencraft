"""Small logging helpers for CI runtime scripts."""

from __future__ import annotations

import sys
from collections.abc import Iterable
from typing import TextIO


SECTION_SEPARATOR = "============================================================"


def print_section(title: str, lines: Iterable[str] = (), *, stream: TextIO | None = None) -> None:
    stream = stream or sys.stderr
    print(SECTION_SEPARATOR, file=stream)
    print(title, file=stream)
    for line in lines:
        print(line, file=stream)
    print(SECTION_SEPARATOR, file=stream)
