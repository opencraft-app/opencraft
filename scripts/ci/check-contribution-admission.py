"""Reject newly introduced commits attributed to the blocked email domain."""

import re
import subprocess
import sys

BLOCKED_DOMAIN = "@tencent.com"
# The immutable pre-admission A2A commits in PR #602 retain their attribution.
HISTORICAL_COMMIT_EXCEPTIONS = frozenset({
    "ed6db9d1232e0fb8caf7638a7153218c9f9fcd4c",
    "c86ed0e6867bef92941b8df5c15bfe24ec791359",
    "7547baee34ae01d28e64776e0a92eaef4054e6f9",
})
SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
TRAILER_EMAIL = re.compile(r"<([^<>]+)>\s*$")
COMMIT_FORMAT = "%H%x00%ae%x00%ce%x00%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x0a)"


def violations(base: str, head: str) -> list[tuple[str, list[str]]]:
    if not (SHA.fullmatch(base) and SHA.fullmatch(head)):
        raise ValueError("Expected full base and head commit IDs")

    # Use the original identities rather than mappings from a candidate's .mailmap.
    result = subprocess.run(
        ["git", "log", "--no-show-signature", "-z", f"--format={COMMIT_FORMAT}", f"{base}..{head}", "--"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    fields = result.stdout.removesuffix("\0").split("\0") if result.stdout else []
    rejected = []
    for offset in range(0, len(fields), 4):
        commit, author, committer, trailers = fields[offset:offset + 4]
        if commit in HISTORICAL_COMMIT_EXCEPTIONS:
            continue
        identities = [("author", author), ("committer", committer)]
        for trailer in trailers.splitlines():
            match = TRAILER_EMAIL.search(trailer)
            if match:
                identities.append(("co-author", match[1]))
        roles = sorted({role for role, email in identities if email.strip().lower().endswith(BLOCKED_DOMAIN)})
        if roles:
            rejected.append((commit, roles))
    return rejected


def main(base: str, head: str) -> int:
    try:
        rejected = violations(base, head)
    except (ValueError, subprocess.CalledProcessError):
        print("Contribution admission could not verify the commit range.", file=sys.stderr)
        return 1

    for commit, roles in rejected:
        print(f"Commit {commit} has a {BLOCKED_DOMAIN} identity in: {', '.join(roles)}.", file=sys.stderr)
    if not rejected:
        print("Contribution admission passed.")
    return int(bool(rejected))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: check-contribution-admission.py BASE_SHA HEAD_SHA")
    sys.exit(main(sys.argv[1], sys.argv[2]))
