import os
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


CHECK = Path(__file__).resolve().parents[1] / "ci" / "check-contribution-admission.py"


class ContributionAdmissionTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="opencraft-contribution-")
        self.addCleanup(scratch.cleanup)
        self.repo = Path(scratch.name)
        self.git("init", "--initial-branch=main")
        self.git("config", "commit.gpgsign", "false")
        self.base = self.commit()

    def git(self, *args, env=None):
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=env, check=True, capture_output=True, text=True
        ).stdout.strip()

    def commit(self, *, author="author@example.test", committer="committer@example.test", message="Change"):
        self.git(
            "commit", "--allow-empty", "--no-verify", "-m", message,
            env={
                **os.environ,
                "GIT_AUTHOR_NAME": "Fixture author",
                "GIT_AUTHOR_EMAIL": author,
                "GIT_COMMITTER_NAME": "Fixture committer",
                "GIT_COMMITTER_EMAIL": committer,
            },
        )
        return self.git("rev-parse", "HEAD")

    def check(self, head, base=None):
        return subprocess.run(
            [sys.executable, "-B", str(CHECK), base or self.base, head],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )

    def test_rejects_all_three_identity_fields_across_multiple_commits(self):
        first = self.commit(author="writer@Tencent.COM")
        second = self.commit(committer="integrator@tencent.com")
        head = self.commit(message=(
            "Work\n\n"
            "Co-authored-by: Allowed <allowed@example.test>\n"
            "co-authored-by: Blocked <secondary@TENCENT.COM>"
        ))
        result = self.check(head)
        self.assertEqual(result.returncode, 1, result.stderr)
        for sha, role in ((first, "author"), (second, "committer"), (head, "co-author")):
            self.assertIn(f"Commit {sha} has a @tencent.com identity in: {role}.", result.stderr)
        self.assertNotIn("secondary@", result.stderr)

    def test_allows_text_mentions_and_other_domains(self):
        result = self.check(self.commit(
            author="writer@not-tencent.com",
            committer="integrator@tencent.com.example.test",
            message="Mention contributor@tencent.com in the documentation.\n\n"
                    "Co-authored-by: Allowed <allowed@sub.tencent.com>",
        ))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ignores_existing_base_history_and_accepts_an_empty_range(self):
        legacy = self.commit(author="historical@tencent.com")
        head = self.commit()
        result = self.check(head, base=legacy)
        self.assertEqual(result.returncode, 0, result.stderr)
        empty = self.check(head, base=head)
        self.assertEqual(empty.returncode, 0, empty.stderr)

    def test_historical_exception_matches_only_the_exact_commit(self):
        address = "historical@tencent.com"
        historical = self.commit(author=address, message="Approved historical commit")
        head = self.commit(author=address, message="A later commit by the same author")
        check = runpy.run_path(str(CHECK))["violations"]
        with patch.dict(check.__globals__, {"HISTORICAL_COMMIT_EXCEPTIONS": frozenset({historical})}):
            with patch.dict(os.environ, {"GIT_DIR": str(self.repo / ".git")}):
                self.assertEqual(check(self.base, historical), [])
                self.assertEqual(check(self.base, head), [(head, ["author"])])

    def test_does_not_apply_mailmap_to_attribution(self):
        (self.repo / ".mailmap").write_text("Mapped <allowed@example.test> <original@tencent.com>\n")
        self.git("add", ".mailmap")
        result = self.check(self.commit(author="original@tencent.com"))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("identity in: author.", result.stderr)

    def test_checks_the_pr_head_on_a_diverged_base(self):
        self.git("checkout", "-b", "candidate")
        head = self.commit(author="pr-author@tencent.com")
        self.git("checkout", "main")
        newer_base = self.commit()
        result = self.check(head, base=newer_base)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(head, result.stderr)
        self.assertNotIn(newer_base, result.stderr)

    def test_fails_closed_when_a_commit_id_cannot_be_verified(self):
        for head in ("--all", "0" * 40):
            result = self.check(head)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("could not verify the commit range", result.stderr)


if __name__ == "__main__":
    unittest.main()
