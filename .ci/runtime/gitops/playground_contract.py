"""Command entrypoint for checking playground environment contracts."""

from __future__ import annotations

from gitops.playground_environment import check_playground_contract_main


def main() -> int:
    return check_playground_contract_main()
