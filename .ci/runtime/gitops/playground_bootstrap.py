"""Command entrypoint for bootstrapping playground runtime dependencies."""

from __future__ import annotations

from gitops.playground_environment import bootstrap_playground_main


def main() -> int:
    return bootstrap_playground_main()
