"""Bound operator-side compilation before credentials or remote work are touched."""
import os
from pathlib import Path
import subprocess
import unittest


class BuildParallelismTest(unittest.TestCase):
    def test_rejects_unsafe_values_before_remote_actions(self):
        for name in ("build-runtime-via-tat.sh", "build-semantic-failure-candidate-via-tat.sh"):
            for jobs in ("0", "-1", "3", "100", "1;echo unsafe", "auto"):
                with self.subTest(script=name, jobs=jobs):
                    result = subprocess.run(["bash", str(Path(__file__).with_name(name))],
                                            env=dict(os.environ, RIVET_BUILD_JOBS=jobs),
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("RIVET_BUILD_JOBS must be 1 or 2", result.stderr)
                    self.assertEqual(result.stdout, "")

    def test_remote_environment_uses_validated_value(self):
        for name in ("build-runtime-via-tat.sh", "build-semantic-failure-candidate-via-tat.sh"):
            source = Path(__file__).with_name(name).read_text()
            self.assertIn('build_jobs=${RIVET_BUILD_JOBS:-1}', source)
            self.assertIn('printf \'export CARGO_BUILD_JOBS=%q\\n\' "$build_jobs"', source)
            self.assertIn("export CARGO_PROFILE_RELEASE_LTO=thin", source)
            self.assertIn("ACTOR_BUILD_PYTHON=python3.11", source)
            self.assertIn("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER", source)
            self.assertIn("clang-lld-linker.sh", source)

    def test_runtime_resume_unmounts_stale_read_only_source_before_chmod(self):
        source = Path(__file__).with_name("build-runtime-via-tat.sh").read_text()
        unmount = 'if mountpoint -q "$stable_source"; then umount "$stable_source"; fi'
        install = 'install -d -m 0700 "$stable_source"'
        bind = 'mount --bind "$immutable_source" "$stable_source"'
        self.assertLess(source.index(unmount), source.index(install))
        self.assertLess(source.index(install), source.index(bind))

    def test_linker_wrapper_is_fixed_to_clang_and_lld(self):
        source = Path(__file__).with_name("clang-lld-linker.sh").read_text()
        self.assertIn("test -x /usr/bin/clang", source)
        self.assertIn("test -x /usr/bin/ld.lld", source)
        self.assertIn('exec /usr/bin/clang --ld-path=/usr/bin/ld.lld "$@"', source)
        self.assertNotIn("RUSTFLAGS", source)

    def test_semantic_candidate_preserves_immutable_runtime_source(self):
        source = Path(__file__).with_name(
            "build-semantic-failure-candidate-via-tat.sh"
        ).read_text()
        self.assertIn(
            "candidate_source=/var/lib/actor-build/deploy/q01-src-"
            "${expected_revision}-${candidate_manifest_sha}",
            source,
        )
        self.assertIn(
            'install -m 0644 "$candidate_manifest" '
            '"$candidate_staging/.actor-source/RELEASE_SHA256SUMS"',
            source,
        )
        self.assertIn(
            '(cd "$candidate_staging" && sha256sum --check '
            '.actor-source/RELEASE_SHA256SUMS >/dev/null)',
            source,
        )
        self.assertIn('chmod -R a-w "$candidate_staging"', source)
        self.assertIn('"candidateSourcePath":candidate_source', source)

    def test_semantic_candidate_serializes_and_reuses_the_stable_cargo_path(self):
        source = Path(__file__).with_name(
            "build-semantic-failure-candidate-via-tat.sh"
        ).read_text()
        self.assertIn('exec 9>"$workspace_root/build.lock"', source)
        self.assertIn('flock -n 9', source)
        self.assertIn('mount --bind "$candidate" "$stable_source"', source)
        self.assertIn('mount -o remount,bind,ro "$stable_source"', source)
        self.assertIn('RIVET_SOURCE_DIR="$build_source"', source)
        self.assertIn(
            'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$build_source/', source
        )

    def test_semantic_candidate_resumes_a_published_image_without_recompile(self):
        source = Path(__file__).with_name(
            "build-semantic-failure-candidate-via-tat.sh"
        ).read_text()
        self.assertIn("printf 'repository=%q\\n' \"$repository\"", source)
        self.assertIn('buildah images --json', source)
        self.assertIn(
            'buildah push --authfile "$auth" --digestfile "$candidate_digest_file"',
            source,
        )
        self.assertNotIn(".FromImageDigest", source)
        self.assertIn(
            '.["fleet.actor.dev/source-manifest-sha256"]', source
        )
        self.assertIn('"resumedPublishedImage":resumed=="true"', source)

    def test_semantic_candidate_persists_full_build_log_and_bounds_tat_output(self):
        source = Path(__file__).with_name(
            "build-semantic-failure-candidate-via-tat.sh"
        ).read_text()
        self.assertIn(
            'build_output=$(mktemp "/data/actor-qualification/builds/'
            'semantic-runtime-${expected_revision}.XXXXXX.log")',
            source,
        )
        self.assertIn('>"$build_output" 2>&1', source)
        self.assertIn("build_status=$?", source)
        self.assertIn("tail -c 12000", source)
        self.assertIn('((build_status == 0)) || exit "$build_status"', source)

    def test_semantic_candidate_pushes_only_after_local_validation(self):
        source = Path(__file__).with_name(
            "build-semantic-failure-candidate-via-tat.sh"
        ).read_text()
        self.assertIn("RIVET_PUSH_IMAGE=0", source)
        self.assertIn(
            'buildah push --authfile "$auth" --digestfile "$candidate_digest_file"',
            source,
        )
        self.assertNotIn("ACTOR_PRODUCT_BUILD_RECEIPT=", source)
        self.assertNotIn(
            'image=$(grep -E "^${repository//./\\.}@sha256:', source
        )


if __name__ == "__main__":
    unittest.main()
