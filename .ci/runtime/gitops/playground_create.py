"""Command entrypoint for creating GitOps-only playground environments."""

from __future__ import annotations

from gitops.playground_environment import create_playground_main


def main() -> int:
    return create_playground_main()
