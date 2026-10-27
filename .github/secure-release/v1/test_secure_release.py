#!/usr/bin/env python3
"""Observable-behavior tests for secure-release kit v1.

Definition:
  Exercise the public CLI in isolated Git repositories with a fake npm binary;
  no registry, credentials, or live repository is touched.

Parameters:
  Standard unittest parameters are supported.

Outputs:
  unittest results on stdout/stderr and a nonzero exit on failure.

Examples:
  python3 test_secure_release.py
  python3 -m unittest -v test_secure_release.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT = Path(__file__).with_name("secure_release.py")


class SecureReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="secure-release-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release@example.invalid")
        (self.repo / "tracked.txt").write_text("release\n", encoding="utf-8")
        self.git("add", "tracked.txt")
        self.git("commit", "-qm", "initial")
        self.git("branch", "-M", "main")
        self.git("-c", "tag.gpgSign=false", "tag", "v1.2.3")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.check_output(("git", *args), cwd=self.repo, text=True).strip()

    def cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (sys.executable, str(SCRIPT), *args),
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    @contextmanager
    def version_api(self, replies):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                status, payload = replies[min(len(requests) - 1, len(replies) - 1)]
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('CF-Cache-Status', 'DYNAMIC')
                self.end_headers()
                self.wfile.write(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}/', requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def api_smoke_npm(self, *, install_errors=(), installed=None):
        calls = self.root / 'smoke-calls.json'
        calls.write_text('[]')
        fake_npm = self.root / 'api-smoke-npm'
        fake_npm.write_text(f'''#!{sys.executable}
import json,sys
from pathlib import Path
log = Path({str(calls)!r})
calls = json.loads(log.read_text())
calls.append(sys.argv[1:])
log.write_text(json.dumps(calls))
command = sys.argv[1]
if command == 'view':
    print('npm error code E404', file=sys.stderr)
    sys.exit(1)
if command == 'init':
    Path('package.json').write_text('{{}}')
elif command == 'install':
    errors = {list(install_errors)!r}
    attempt = sum(call[0] == 'install' for call in calls) - 1
    if attempt < len(errors):
        print(errors[attempt], file=sys.stderr)
        sys.exit(1)
    output = Path('node_modules/@fixture/app/package.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({installed or {'name': '@fixture/app', 'version': '1.2.3'}!r}))
else:
    sys.exit(2)
''')
        fake_npm.chmod(0o755)
        return fake_npm, calls

    def api_smoke(self, registry, npm, retries=2):
        return self.cli('npm-smoke', '--package', '@fixture/app', '--version', '1.2.3',
                        '--registry', registry, '--npm', str(npm), '--metadata-source', 'version-api',
                        '--metadata-retries', str(retries), '--metadata-retry-delay', '0')

    def test_source_accepts_exact_reachable_tag_and_rejects_version_drift(self) -> None:
        result = self.cli(
            "source", "--tag", "v1.2.3", "--version", "1.2.3", "--primary-ref", "main"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        drift = self.cli(
            "source", "--tag", "v1.2.3", "--version", "1.2.4", "--primary-ref", "main"
        )
        self.assertNotEqual(drift.returncode, 0)
        self.assertIn("does not match", drift.stderr)

    def test_manifest_detects_changed_and_extra_artifacts(self) -> None:
        release = self.repo / "release"
        release.mkdir()
        artifact = release / "package.tgz"
        artifact.write_bytes(b"exact bytes")
        manifest = release / "manifest.json"
        created = self.cli(
            "manifest-create",
            "--tag",
            "v1.2.3",
            "--version",
            "1.2.3",
            "--artifact",
            str(artifact),
            "--output",
            str(manifest),
        )
        self.assertEqual(created.returncode, 0, created.stderr)
        verified = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        artifact.write_bytes(b"changed")
        changed = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertNotEqual(changed.returncode, 0)
        artifact.write_bytes(b"exact bytes")
        (release / ".unexpected").write_text("no\n", encoding="utf-8")
        extra = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertNotEqual(extra.returncode, 0)
        self.assertIn("artifact set mismatch", extra.stderr)

    def test_changelog_extracts_only_exact_tag_section(self) -> None:
        changelog = self.repo / "CHANGELOG.md"
        changelog.write_text(
            "# Changelog\n\n## v1.2.3\n\n- Current.\n\n## v1.2.2\n\n- Previous.\n",
            encoding="utf-8",
        )
        notes = self.repo / "release" / "notes.md"
        result = self.cli(
            "changelog", "--tag", "v1.2.3", "--changelog", str(changelog), "--notes", str(notes)
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(notes.read_text(encoding="utf-8"), "## v1.2.3\n\n- Current.\n")

    def test_npm_pack_moves_one_tarball_and_creates_manifest(self) -> None:
        package = self.repo / "package"
        package.mkdir()
        (package / "package.json").write_text(
            json.dumps({"name": "fixture-package", "version": "1.2.3"}), encoding="utf-8"
        )
        fake_npm = self.root / "npm"
        fake_npm.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "destination=''\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  if [ \"$1\" = '--pack-destination' ]; then destination=$2; shift 2; else shift; fi\n"
            "done\n"
            "printf 'packed bytes' > \"$destination/fixture-package-1.2.3.tgz\"\n"
            "printf '{\"fixture-package\":{\"filename\":\"fixture-package-1.2.3.tgz\"}}\\n'\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        release = self.repo / "release"
        result = self.cli(
            "npm-pack",
            "--tag",
            "v1.2.3",
            "--package-dir",
            str(package),
            "--output-dir",
            str(release),
            "--manifest",
            str(release / "manifest.json"),
            "--npm",
            str(fake_npm),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((release / "fixture-package-1.2.3.tgz").is_file())
        manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([item["name"] for item in manifest["artifacts"]], ["fixture-package-1.2.3.tgz"])

    def test_npm_pack_rejects_multiple_package_records(self) -> None:
        package = self.repo / "package"
        package.mkdir()
        (package / "package.json").write_text(
            json.dumps({"name": "fixture-package", "version": "1.2.3"}), encoding="utf-8"
        )
        fake_npm = self.root / "npm-multiple"
        fake_npm.write_text(
            "#!/bin/sh\n"
            "printf '{\"one\":{\"filename\":\"one.tgz\"},\"two\":{\"filename\":\"two.tgz\"}}\\n'\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        release = self.repo / "release"
        result = self.cli(
            "npm-pack",
            "--tag",
            "v1.2.3",
            "--package-dir",
            str(package),
            "--output-dir",
            str(release),
            "--manifest",
            str(release / "manifest.json"),
            "--npm",
            str(fake_npm),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must produce exactly one package", result.stderr)

    def test_registry_absence_fails_closed_on_non_404(self) -> None:
        fake_npm = self.root / "npm-error"
        fake_npm.write_text("#!/bin/sh\necho 'network timeout' >&2\nexit 1\n", encoding="utf-8")
        fake_npm.chmod(0o755)
        result = self.cli(
            "npm-absent",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--npm",
            str(fake_npm),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("absence is unproven", result.stderr)

        fake_npm.write_text(
            "#!/bin/sh\necho 'upstream mentioned E404 but timed out' >&2\nexit 1\n",
            encoding="utf-8",
        )
        incidental = self.cli(
            "npm-absent",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--npm",
            str(fake_npm),
        )
        self.assertNotEqual(incidental.returncode, 0)
        self.assertIn("absence is unproven", incidental.stderr)

        fake_npm.write_text(
            "#!/bin/sh\necho 'npm error code E404' >&2\nexit 1\n", encoding="utf-8"
        )
        absent = self.cli(
            "npm-absent",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--npm",
            str(fake_npm),
        )
        self.assertEqual(absent.returncode, 0, absent.stderr)

    def test_existing_registry_version_requires_identical_tarball_bytes(self) -> None:
        artifact = self.repo / "intended.tgz"
        artifact.write_bytes(b"published bytes")
        fake_npm = self.root / "npm-existing"
        fake_npm.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "destination=''\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  if [ \"$1\" = '--pack-destination' ]; then destination=$2; shift 2; else shift; fi\n"
            "done\n"
            "printf 'published bytes' > \"$destination/downloaded.tgz\"\n"
            "printf '{\"fixture-package\":{\"filename\":\"downloaded.tgz\"}}\\n'\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        matched = self.cli(
            "npm-existing",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--artifact",
            str(artifact),
            "--npm",
            str(fake_npm),
        )
        self.assertEqual(matched.returncode, 0, matched.stderr)
        artifact.write_bytes(b"different bytes")
        mismatched = self.cli(
            "npm-existing",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--artifact",
            str(artifact),
            "--npm",
            str(fake_npm),
        )
        self.assertNotEqual(mismatched.returncode, 0)
        self.assertIn("differ", mismatched.stderr)

    def test_existing_registry_version_rejects_multiple_package_records(self) -> None:
        artifact = self.repo / "intended.tgz"
        artifact.write_bytes(b"published bytes")
        fake_npm = self.root / "npm-existing-multiple"
        fake_npm.write_text(
            "#!/bin/sh\n"
            "printf '{\"one\":{\"filename\":\"one.tgz\"},\"two\":{\"filename\":\"two.tgz\"}}\\n'\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        result = self.cli(
            "npm-existing",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--artifact",
            str(artifact),
            "--npm",
            str(fake_npm),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must produce exactly one package", result.stderr)

    def test_npm_publish_uses_exact_tarball_and_provenance(self) -> None:
        artifact = self.repo / "intended.tgz"
        artifact.write_bytes(b"publish bytes")
        arguments = self.root / "publish-arguments"
        fake_npm = self.root / "npm-publish"
        fake_npm.write_text(
            f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{arguments}'\n", encoding="utf-8"
        )
        fake_npm.chmod(0o755)
        result = self.cli("npm-publish", "--artifact", str(artifact), "--npm", str(fake_npm))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            arguments.read_text(encoding="utf-8").splitlines(),
            [
                "publish",
                str(artifact),
                "--access",
                "public",
                "--tag",
                "latest",
                "--provenance",
                "--registry",
                "https://registry.npmjs.org/",
            ],
        )

    def test_npm_publish_private_source_disables_provenance(self) -> None:
        artifact = self.repo / "intended.tgz"
        artifact.write_bytes(b"publish bytes")
        arguments = self.root / "publish-arguments"
        fake_npm = self.root / "npm-publish"
        fake_npm.write_text(
            f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{arguments}'\n", encoding="utf-8"
        )
        fake_npm.chmod(0o755)
        result = self.cli("npm-publish", "--artifact", str(artifact), "--npm", str(fake_npm), "--provenance", "false")
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = arguments.read_text(encoding="utf-8").splitlines()
        self.assertIn("--provenance=false", observed)
        self.assertNotIn("--provenance", observed)
        self.assertEqual(observed[1], str(artifact))

    def test_npm_smoke_retries_only_missing_metadata_with_a_bound(self) -> None:
        for error, misses, retries, expected_calls, succeeds in (
            ("E404", 2, 2, 3, True),
            ("E404", 5, 2, 3, False),
            ("E401", 2, 2, 1, False),
            ("ETIMEDOUT", 2, 2, 1, False),
        ):
            with self.subTest(error=error, misses=misses):
                counter = self.root / "lookup-count"
                counter.write_text("0")
                fake_npm = self.root / "npm-eventual"
                fake_npm.write_text(
                    "#!/bin/sh\nset -eu\ncase \"$1\" in\n"
                    f"view) n=$(cat '{counter}'); n=$((n+1)); echo $n > '{counter}'; "
                    f"if [ $n -le {misses} ]; then echo 'npm error code {error}' >&2; exit 1; fi; echo 1.2.3 ;;\n"
                    "init) echo '{}' > package.json ;;\n"
                    "install) mkdir -p node_modules/fixture-package; "
                    "printf '{\"name\":\"fixture-package\",\"version\":\"1.2.3\"}' > node_modules/fixture-package/package.json ;;\n"
                    "*) exit 2 ;;\nesac\n"
                )
                fake_npm.chmod(0o755)
                result = self.cli("npm-smoke", "--package", "fixture-package", "--version", "1.2.3", "--npm", str(fake_npm),
                                  "--metadata-retries", str(retries), "--metadata-retry-delay", "0")
                self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                self.assertEqual(int(counter.read_text()), expected_calls)

    def test_npm_smoke_resolves_and_installs_exact_version(self) -> None:
        fake_npm = self.root / "npm-smoke"
        fake_npm.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "case \"$1\" in\n"
            "  view) echo '1.2.3' ;;\n"
            "  init) printf '{\"name\":\"consumer\",\"version\":\"1.0.0\"}' > package.json ;;\n"
            "  install)\n"
            "    mkdir -p node_modules/fixture-package\n"
            "    printf '{\"name\":\"fixture-package\",\"version\":\"1.2.3\"}' "
            "> node_modules/fixture-package/package.json\n"
            "    ;;\n"
            "  *) exit 2 ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        result = self.cli(
            "npm-smoke",
            "--package",
            "fixture-package",
            "--version",
            "1.2.3",
            "--npm",
            str(fake_npm),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_version_api_bypasses_stale_lookup_and_still_installs_named_version(self):
        npm, calls = self.api_smoke_npm()
        with self.version_api([(404, {}), (404, {}), (200, {'name': '@fixture/app', 'version': '1.2.3'})]) as (registry, requests):
            result = self.api_smoke(registry, npm)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests, ['/@fixture%2Fapp/1.2.3'] * 3)
        commands = json.loads(calls.read_text())
        self.assertEqual([call[0] for call in commands], ['init', 'install'])
        self.assertIn('@fixture/app@1.2.3', commands[-1])
        self.assertIn('cache=DYNAMIC', result.stdout)

    def test_version_api_rejects_errors_identity_drift_and_unbounded_absence(self):
        for status, metadata, attempts in (
            (404, {}, 3),
            (401, {}, 1),
            (500, {}, 1),
            (200, b'not JSON', 1),
            (200, {'name': '@other/app', 'version': '1.2.3'}, 1),
            (200, {'name': '@fixture/app', 'version': '1.2.4'}, 1),
        ):
            with self.subTest(status=status, metadata=metadata):
                npm, calls = self.api_smoke_npm()
                with self.version_api([(status, metadata)]) as (registry, requests):
                    result = self.api_smoke(registry, npm)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(requests), attempts)
                self.assertEqual(json.loads(calls.read_text()), [])

    def test_version_api_retries_only_the_requested_install_version_with_a_bound(self):
        missing = 'npm error code ETARGET\nnpm error notarget No matching version found for @fixture/app@1.2.3.'
        for errors, succeeds, installs in (
            ([missing, missing], True, 3),
            ([missing] * 3, False, 3),
            (['npm error code ETARGET\nnpm error notarget No matching version found for another@1.0.0.'], False, 1),
            (['npm error code E401'], False, 1),
            (['npm error code ETIMEDOUT'], False, 1),
            (['npm error code E404'], False, 1),
        ):
            with self.subTest(errors=errors):
                npm, calls = self.api_smoke_npm(install_errors=errors)
                with self.version_api([(200, {'name': '@fixture/app', 'version': '1.2.3'})]) as (registry, requests):
                    result = self.api_smoke(registry, npm)
                self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                self.assertEqual(sum(call[0] == 'install' for call in json.loads(calls.read_text())), installs)

    def test_version_api_rejects_a_different_installed_identity(self):
        for identity in ({'name': '@other/app', 'version': '1.2.3'}, {'name': '@fixture/app', 'version': '1.2.4'}):
            with self.subTest(identity=identity):
                npm, calls = self.api_smoke_npm(installed=identity)
                with self.version_api([(200, {'name': '@fixture/app', 'version': '1.2.3'})]) as (registry, requests):
                    result = self.api_smoke(registry, npm)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('does not match', result.stderr)

    @contextmanager
    def mint_and_exchange(self, mint, exchange):
        """One HTTP fixture serving both the mint URL and the registry exchange."""
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status, payload):
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("npm-request-id", "mock-request-id-1")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _serve(self, method):
                seen.append({"method": method, "path": self.path, "headers": dict(self.headers)})
                if "/idtoken" in self.path:
                    self._send(*mint)
                else:
                    index = min(sum(1 for entry in seen if entry["method"] == "POST" and "/exchange/" in entry["path"]) - 1, len(exchange) - 1)
                    self._send(*exchange[index])

            def do_GET(self):
                self._serve("GET")

            def do_POST(self):
                self._serve("POST")

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", seen
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def minted_id_token(self):
        import base64

        def encode(part):
            return base64.urlsafe_b64encode(part).rstrip(b"=").decode()

        claims = {
            "iss": "https://token.actions.githubusercontent.com",
            "aud": ["npm:registry.npmjs.org"],
            "repository": "opencraft-app/opencraft",
            "repository_id": "1423986423",
            "repository_owner_id": "330436527",
            "job_workflow_ref": "opencraft-app/opencraft/.github/workflows/release.yml@refs/heads/main",
            "ref": "refs/heads/main",
            "environment": "npm-release",
            "sub": "repo:opencraft-app@330436527/opencraft@1423986423:environment:npm-release",
            "nonAllowlistedClaim": "dev@example.invalid",
        }
        signature = encode(("mock-signature-" + "x" * 40).encode())
        return f"{encode(b'{}')}.{encode(json.dumps(claims).encode())}.{signature}"

    def run_probe(self, registry, url_token, *, npm_version="11.18.0"):
        environment = dict(os.environ)
        environment["GITHUB_ACTIONS"] = "true"
        environment["ACTIONS_ID_TOKEN_REQUEST_URL"] = f"{registry}/idtoken"
        environment["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = url_token
        environment.pop("ACTIONS_ID_TOKEN", None)
        return subprocess.run(
            (sys.executable, str(SCRIPT), "oidc-probe", "--package", "@opencraft-app/opencraft",
             "--registry", registry, "--npm-version", npm_version),
            cwd=self.repo, env=environment, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )

    def test_oidc_probe_exchanges_verbatim_and_withholds_every_issued_token(self):
        token = self.minted_id_token()
        with self.mint_and_exchange((200, {"value": token}),
                                    [(200, {"token": "ISSUED-NPM-TOKEN-never-print",
                                            "verbose": "Bearer AAA.BBB.CCC should not print either"})]) as (registry, seen):
            result = self.run_probe(registry, "mint-secret")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exchange verdict: token issued (withheld)", result.stdout)
        for secret in ("ISSUED-NPM-TOKEN", token, "mint-secret", "AAA.BBB", "dev@example.invalid"):
            self.assertNotIn(secret, result.stdout)
        exchange = seen[-1]
        sent = {key.lower(): value for key, value in exchange["headers"].items()}
        self.assertEqual(exchange["method"], "POST")
        self.assertEqual(exchange["path"], "/-/npm/v1/oidc/token/exchange/package/@opencraft-app%2fopencraft")
        self.assertEqual(sent.get("npm-command"), "publish")
        self.assertEqual(sent.get("npm-auth-type"), "web")
        self.assertEqual(sent.get("accept"), "*/*")
        self.assertNotIn("content-type", sent)
        mint = seen[0]
        self.assertIn("/idtoken", mint["path"])
        self.assertIn("audience=npm%3A", mint["path"])

    def test_oidc_probe_denial_prints_only_the_structured_registry_fields(self):
        with self.mint_and_exchange(
                (200, {"value": self.minted_id_token()}),
                [(404, {"message": "OIDC token exchange error - package not found"})]) as (registry, seen):
            result = self.run_probe(registry, "mint-secret")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exchange HTTP status: 404", result.stdout)
        self.assertIn("mock-request-id-1", result.stdout)
        self.assertIn("package not found", result.stdout)
        self.assertNotIn("ISSUED", result.stdout)
        self.assertNotIn("token\"", result.stdout.replace("exchange verdict", ""))

    def test_oidc_probe_redacts_credential_shapes_inside_registry_fields(self):
        poison = "message leaked AAAAeyJhbGciOiJIUzI1NiIsInR5cCI6.pAYLOAD-CONTENT-SIGNATURE and Bearer bb.aa.cc"
        with self.mint_and_exchange((200, {"value": self.minted_id_token()}),
                                    [(404, {"message": poison})]) as (registry, seen):
            result = self.run_probe(registry, "mint-secret")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("pAYLOAD-CONTENT-SIGNATURE", result.stdout)
        self.assertNotIn("Bearer bb.aa.cc", result.stdout)
        self.assertIn("[redacted]", result.stdout)

    def test_tagged_kit_without_oidc_probe_cannot_satisfy_the_temporary_command(self):
        tagged = self.root / "tagged-kit.py"
        source = SCRIPT.read_text(encoding="utf-8")
        renamed = source.replace('"oidc-probe"', '"oidc-probe-absent"', 1)
        if renamed == source:
            self.fail("tagged-kit fixture did not find oidc-probe")
        tagged.write_text(renamed, encoding="utf-8")
        result = subprocess.run(
            (sys.executable, str(tagged), "oidc-probe", "--package", "@opencraft-app/opencraft"),
            cwd=self.repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice: 'oidc-probe'", result.stderr)
        workflow = subprocess.run(
            (sys.executable, str(SCRIPT), "--help"),
            cwd=self.repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(workflow.returncode, 0, workflow.stderr)
        self.assertIn("oidc-probe", workflow.stdout)
        self.assertIn("oidc-dry-run", workflow.stdout)
        self.assertIn("npm-publish", workflow.stdout)

    def test_oidc_probe_help_does_not_offer_npm_publish(self):
        result = subprocess.run(
            (sys.executable, str(SCRIPT), "oidc-probe", "--help"),
            cwd=self.repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("npm-publish", result.stdout)
        self.assertIn("oidc-probe", result.stdout)

    def test_oidc_probe_requires_the_github_oidc_mint_environment(self):
        environment = dict(os.environ)
        environment.pop("ACTIONS_ID_TOKEN_REQUEST_URL", None)
        environment.pop("ACTIONS_ID_TOKEN_REQUEST_TOKEN", None)
        result = subprocess.run(
            (sys.executable, str(SCRIPT), "oidc-probe", "--package", "@opencraft-app/opencraft",
             "--registry", "http://127.0.0.1:1/"),
            cwd=self.repo, env=environment, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ACTIONS_ID_TOKEN_REQUEST_URL", result.stderr)
        self.assertIn("ACTIONS_ID_TOKEN_REQUEST_TOKEN", result.stderr)

    def write_fake_npm(self, script: str) -> tuple[Path, Path, Path]:
        artifact = self.repo / "intended.tgz"
        artifact.write_bytes(b"publish bytes")
        arguments = self.root / "dry-run-arguments"
        fake_npm = self.root / "npm-dry-run"
        fake_npm.write_text("#!/bin/sh\nset -eu\n" + script.replace("{arguments}", str(arguments)), encoding="utf-8")
        fake_npm.chmod(0o755)
        return artifact, arguments, fake_npm

    def run_dry_run(self, fake_npm: Path, artifact: Path, extra_env: dict[str, str] | None = None):
        environment = dict(os.environ)
        environment.pop("NPM_ID_TOKEN", None)
        if extra_env:
            environment.update(extra_env)
        userconfig = self.root / "isolated.npmrc"
        return subprocess.run(
            (sys.executable, str(SCRIPT), "oidc-dry-run", "--artifact", str(artifact),
             "--npm", str(fake_npm), "--userconfig", str(userconfig),
             "--registry", "https://registry.npmjs.org/"),
            cwd=self.repo, env=environment, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )

    def test_oidc_dry_run_invokes_native_publish_with_dry_run_and_ignore_scripts(self):
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'verbose cli npm/11.18.0 node/v24.15.0 linux x64 workspaces/false ci/github-actions/dotcom-hosted'\n"
            "printf '%s\\n' 'http fetch GET https://vstoken.actions.githubusercontent.com/idtoken?audience=npm:registry.npmjs.org 200 12ms'\n"
            "printf '%s\\n' 'http fetch POST 201 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@opencraft-app%2fopencraft 18ms'\n"
            "printf '%s\\n' 'verbose oidc Successfully retrieved and set token'\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = arguments.read_text(encoding="utf-8").splitlines()
        self.assertEqual(observed[0:4], ["publish", str(artifact), "--dry-run", "--ignore-scripts"])
        self.assertIn("--provenance", observed)
        self.assertIn("--access", observed)
        self.assertIn("public", observed)
        self.assertIn("--userconfig", observed)
        self.assertNotIn("ISSUED", result.stdout)
        self.assertIn("native npm dry-run: true", result.stdout)
        self.assertIn("native npm exchange verdict: token issued (withheld)", result.stdout)
        self.assertIn(
            "native npm user-agent: npm/11.18.0 node/v24.15.0 linux x64 workspaces/false ci/github-actions/dotcom-hosted",
            result.stdout,
        )
        self.assertIn("native npm exchange HTTP status: 201", result.stdout)
        self.assertIn("native npm id-token-env: absent", result.stdout)
        self.assertIn("native npm http: GET", result.stdout)
        self.assertIn("native npm http: POST", result.stdout)

    def test_oidc_dry_run_parses_mint_url_status_and_exchange_status_url_either_order(self):
        mint = "http fetch GET https://vstoken.actions.githubusercontent.com/idtoken?audience=npm:registry.npmjs.org 200 12ms"
        exchange = "http fetch POST 201 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@opencraft-app%2fopencraft 18ms"
        for first, second in ((mint, exchange), (exchange, mint)):
            with self.subTest(order=first.split()[2]):
                artifact, arguments, fake_npm = self.write_fake_npm(
                    "printf '%s\\n' \"$@\" > '{arguments}'\n"
                    f"printf '%s\\n' '{first}'\n"
                    f"printf '%s\\n' '{second}'\n"
                    "printf '%s\\n' 'verbose oidc Successfully retrieved and set token'\n"
                )
                result = self.run_dry_run(fake_npm, artifact)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("native npm exchange HTTP status: 201", result.stdout)
                self.assertNotIn("native npm exchange HTTP status: unknown", result.stdout)

    def test_oidc_dry_run_does_not_treat_cli_exit_zero_as_authentication(self):
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)'\n"
            "exit 0\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native npm exit: 0", result.stdout)
        self.assertIn("unproven", result.stdout)
        self.assertIn("dry-run exit is not authentication", result.stderr)

    def test_oidc_dry_run_reports_exchange_404_from_registry_fetch_status_url_order(self):
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'http fetch GET https://vstoken.actions.githubusercontent.com/idtoken?audience=npm:registry.npmjs.org 200 12ms'\n"
            "printf '%s\\n' 'http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@opencraft-app%2fopencraft 18ms'\n"
            "printf '%s\\n' 'verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found'\n"
            "printf '%s\\n' 'This command requires you to be logged in to https://registry.npmjs.org/ (dry-run)'\n"
            "exit 0\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native npm exchange HTTP status: 404", result.stdout)
        self.assertIn("package not found", result.stdout)
        self.assertIn("did not issue a token", result.stderr)
        self.assertNotIn("exchange verdict: token issued", result.stdout)
        observed = arguments.read_text(encoding="utf-8")
        self.assertIn("--dry-run", observed)

    def test_oidc_dry_run_body_without_status_line_reports_unknown_http_status(self):
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'http fetch GET https://vstoken.actions.githubusercontent.com/idtoken?audience=npm:registry.npmjs.org 200 12ms'\n"
            "printf '%s\\n' 'verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found'\n"
            "exit 0\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native npm exchange HTTP status: unknown", result.stdout)
        self.assertNotIn("native npm exchange HTTP status: 404", result.stdout)
        self.assertIn("package not found", result.stdout)
        self.assertIn("did not issue a token", result.stderr)

    def test_oidc_dry_run_redacts_jwt_shapes_from_cli_text(self):
        poison = "verbose oidc Failed token exchange request with body message: leaked AAAAeyJhbGciOiJIUzI1NiIsInR5cCI6.pAYLOAD-CONTENT-SIGNATURE"
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            f"printf '%s\\n' '{poison}'\n"
            "exit 0\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("pAYLOAD-CONTENT-SIGNATURE", result.stdout)
        self.assertNotIn("pAYLOAD-CONTENT-SIGNATURE", result.stderr)
        self.assertIn("[redacted]", result.stdout)
        self.assertIn("native npm exchange HTTP status: unknown", result.stdout)

    def test_oidc_dry_run_strips_preexisting_id_token_and_isolates_userconfig(self):
        envdump = self.root / "child-env"
        artifact, arguments, fake_npm = self.write_fake_npm(
            f"env | grep -E '^(NPM_ID_TOKEN|HOME|NPM_CONFIG_USERCONFIG)=' | sort > '{envdump}'\n"
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'http fetch GET https://vstoken.actions.githubusercontent.com/idtoken?audience=npm:registry.npmjs.org 200 12ms'\n"
            "printf '%s\\n' 'http fetch POST 201 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@opencraft-app%2fopencraft 18ms'\n"
            "printf '%s\\n' 'verbose oidc Successfully retrieved and set token'\n"
        )
        result = self.run_dry_run(fake_npm, artifact, extra_env={"NPM_ID_TOKEN": "must-not-survive"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("must-not-survive", result.stdout)
        self.assertNotIn("must-not-survive", result.stderr)
        self.assertIn("native npm id-token-env: absent", result.stdout)
        dumped = envdump.read_text(encoding="utf-8")
        self.assertIn("HOME=", dumped)
        self.assertIn("NPM_CONFIG_USERCONFIG=", dumped)
        self.assertNotIn("NPM_ID_TOKEN=", dumped)
        self.assertNotIn("must-not-survive", dumped)

    def test_oidc_dry_run_aborts_if_cli_writes_the_package(self):
        artifact, arguments, fake_npm = self.write_fake_npm(
            "printf '%s\\n' \"$@\" > '{arguments}'\n"
            "printf '%s\\n' 'http fetch PUT 200 https://registry.npmjs.org/-/npm/v1/packages/@opencraft-app%2fopencraft 18ms'\n"
            "printf '%s\\n' 'verbose oidc Successfully retrieved and set token'\n"
            "exit 0\n"
        )
        result = self.run_dry_run(fake_npm, artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("issued a package write", result.stderr)

    def test_oidc_dry_run_help_does_not_offer_npm_publish(self):
        result = subprocess.run(
            (sys.executable, str(SCRIPT), "oidc-dry-run", "--help"),
            cwd=self.repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("npm-publish", result.stdout)
        self.assertIn("oidc-dry-run", result.stdout)


if __name__ == "__main__":
    unittest.main()
