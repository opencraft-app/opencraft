import os
import shlex
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class FrontendNextCacheTests(unittest.TestCase):
    def test_local_cache_round_trip_is_region_isolated_and_replaceable(self) -> None:
        guard_text = (REPO_ROOT / "frontend/checks/guard.sh").read_text()
        functions_start = guard_text.index("frontend_next_cache_sha256() {")
        functions_end = guard_text.index("\ncleanup_frontend_guard_workspace() {")
        cache_functions = guard_text[functions_start:functions_end]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_flock = fake_bin / "flock"
            fake_flock.write_text("#!/usr/bin/env sh\nexit 0\n")
            fake_flock.chmod(0o755)

            job_dir = root / "job"
            cache_namespace = root / "cache" / "v1" / "test-key"
            harness = textwrap.dedent(
                f"""
                set -euo pipefail
                {cache_functions}
                FRONTEND_GUARD_DIR={shlex.quote(str(job_dir))}
                FRONTEND_NEXT_CACHE_NAMESPACE={shlex.quote(str(cache_namespace))}
                FRONTEND_NEXT_CACHE_LOCK_TIMEOUT_SECONDS=5
                FRONTEND_NEXT_CACHE_RESTORED=0

                mkdir -p "$FRONTEND_GUARD_DIR/.next/cache"
                printf 'cn-v1\n' > "$FRONTEND_GUARD_DIR/.next/cache/value"
                save_frontend_next_cache cn
                rm -rf "$FRONTEND_GUARD_DIR/.next"
                restore_frontend_next_cache cn
                test "$FRONTEND_NEXT_CACHE_RESTORED" -eq 1
                test "$(cat "$FRONTEND_GUARD_DIR/.next/cache/value")" = cn-v1

                rm -rf "$FRONTEND_GUARD_DIR/.next"
                mkdir -p "$FRONTEND_GUARD_DIR/.next/cache"
                printf 'global-v1\n' > "$FRONTEND_GUARD_DIR/.next/cache/value"
                save_frontend_next_cache global
                rm -rf "$FRONTEND_GUARD_DIR/.next"
                restore_frontend_next_cache cn
                test "$(cat "$FRONTEND_GUARD_DIR/.next/cache/value")" = cn-v1
                rm -rf "$FRONTEND_GUARD_DIR/.next"
                restore_frontend_next_cache global
                test "$(cat "$FRONTEND_GUARD_DIR/.next/cache/value")" = global-v1

                printf 'global-v2\n' > "$FRONTEND_GUARD_DIR/.next/cache/value"
                save_frontend_next_cache global
                rm -rf "$FRONTEND_GUARD_DIR/.next"
                restore_frontend_next_cache global
                test "$(cat "$FRONTEND_GUARD_DIR/.next/cache/value")" = global-v2
                """
            )
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
            result = subprocess.run(
                ["bash"],
                input=harness,
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
