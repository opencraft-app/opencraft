#!/usr/bin/env python3
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


class WorkerdShardManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        documents = list(yaml.safe_load_all((ROOT / "runtime.yaml").read_text()))
        cls.stateful_set = next(
            document
            for document in documents
            if document
            and document.get("kind") == "StatefulSet"
            and document["metadata"]["name"] == "actor-bj-k01-runtime-hosts"
        )
        cls.containers = {
            container["name"]: container
            for container in cls.stateful_set["spec"]["template"]["spec"]["containers"]
        }
        cls.documents = documents

    def test_supervisor_and_endpoint_scripts_are_valid_bash(self):
        for name in ("workerd", "workerd-host"):
            script = self.containers[name]["args"][0]
            subprocess.run(["bash", "-n", "-c", script], check=True)

    def test_sixteen_shards_skip_the_sqlite_bridge_port(self):
        ports = [18080 if index == 0 else 18081 + index for index in range(16)]
        self.assertEqual(len(ports), len(set(ports)))
        self.assertNotIn(18081, ports)
        self.assertEqual(ports[0], 18080)
        self.assertEqual(ports[-1], 18096)

    def test_probe_shard_listens_on_pod_ip_and_private_shards_use_loopback(self):
        script = self.containers["workerd"]["args"][0]
        self.assertIn("listen_address=0.0.0.0", script)
        self.assertIn("listen_address=127.0.0.1", script)
        self.assertIn('http=$listen_address:$port', script)
        self.assertEqual(
            self.containers["workerd"]["readinessProbe"]["tcpSocket"]["port"],
            "workerd",
        )

    def test_shard_count_and_bounded_cache_are_wired(self):
        for name in ("workerd", "workerd-host"):
            env = {entry["name"]: entry.get("value") for entry in self.containers[name]["env"]}
            self.assertEqual(env["RIVET_WORKERD_SHARDS"], "__RIVET_WORKERD_SHARDS__")
        script = self.containers["workerd"]["args"][0]
        self.assertIn("4294967296 / RIVET_WORKERD_SHARDS", script)
        self.assertIn("4096 / RIVET_WORKERD_SHARDS", script)

    def test_host_capacity_and_idle_policy_are_profile_bound(self):
        env = {
            entry["name"]: entry.get("value")
            for entry in self.containers["workerd-host"]["env"]
        }
        self.assertEqual(
            env["RIVET_WORKERD_MAX_ACTIVE_ACTORS"],
            "__RIVET_WORKERD_MAX_ACTIVE_ACTORS__",
        )
        self.assertEqual(
            env["RIVET_WORKERD_IDLE_SLEEP_MS"],
            "__RIVET_WORKERD_IDLE_SLEEP_MS__",
        )

    def test_drain_management_port_does_not_collide_with_workerd_shards(self):
        host = self.containers["workerd-host"]
        env = {entry["name"]: entry.get("value") for entry in host["env"]}
        self.assertEqual(env["RIVET_WORKERD_MANAGEMENT_BIND"], "0.0.0.0:19083")
        self.assertEqual(
            next(port["containerPort"] for port in host["ports"] if port["name"] == "management"),
            19083,
        )
        self.assertNotIn(19083, [18080 if index == 0 else 18081 + index for index in range(64)])

    def test_host_drain_is_wired_fail_closed_but_not_enabled_before_e2e(self):
        reporter = next(
            document
            for document in self.documents
            if document
            and document.get("kind") == "Deployment"
            and document["metadata"]["name"] == "actor-bj-k01-cell-reporter"
        )
        env = {
            entry["name"]: entry.get("value")
            for entry in reporter["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(env["HOST_DRAIN_MODE"], "Disabled")
        role = next(
            document
            for document in self.documents
            if document
            and document.get("kind") == "Role"
            and document["metadata"]["name"] == "actor-bj-k01-cell-reporter"
        )
        statefulset_rules = [
            rule
            for rule in role["rules"]
            if rule.get("apiGroups") == ["apps"] and rule.get("resources") == ["statefulsets"]
        ]
        self.assertEqual(statefulset_rules[0]["verbs"], ["get", "patch"])

    def test_pod_termination_fences_and_drains_before_v8_exits(self):
        scripts = []
        for name in ("workerd", "workerd-host"):
            command = self.containers[name]["lifecycle"]["preStop"]["exec"]["command"]
            self.assertEqual(command[:2], ["/bin/bash", "-ec"])
            script = command[2]
            scripts.append(script)
            subprocess.run(["bash", "-n", "-c", script], check=True)
            for guard in (
                '"draining":true',
                '"metadata_sent":[[:space:]]*true',
                '"host_draining":[[:space:]]*true',
                '"host_accepting_actors":[[:space:]]*false',
                '"quiescent":[[:space:]]*true',
                '"host_active_actors":[[:space:]]*0',
                '"bridge_active_actors":[[:space:]]*0',
                '"in_flight":[[:space:]]*0',
                '"queued":[[:space:]]*0',
                "while true; do sleep 10; done",
                'barrier=${RIVET_PRESTOP_BARRIER_DIR:-/tmp/rivet-host-prestop}',
                'mkdir "$barrier/leader"',
                '[[ ! -e "$barrier/quiescent" ]] || exit 0',
                ': > "$barrier/quiescent"',
                'trap \': > "$barrier/failed"\' EXIT',
                "trap - EXIT",
            ):
                self.assertIn(guard, script)
        self.assertEqual(scripts[0], scripts[1])
        for name in ("workerd", "workerd-host"):
            mounts = {
                mount["mountPath"]: mount["name"]
                for mount in self.containers[name]["volumeMounts"]
            }
            self.assertEqual(mounts["/tmp"], "tmp")
        volumes = {
            volume["name"]: volume
            for volume in self.stateful_set["spec"]["template"]["spec"]["volumes"]
        }
        self.assertEqual(volumes["tmp"]["emptyDir"], {})
        self.assertEqual(
            self.stateful_set["spec"]["template"]["metadata"]["annotations"][
                "fleet.actor.dev/runtime-auth-sha256"
            ],
            "__RIVET_RUNTIME_AUTH_SHA256__",
        )

    def test_concurrent_prestop_hooks_share_one_drain_leader(self):
        scripts = [
            self.containers[name]["lifecycle"]["preStop"]["exec"]["command"][2]
            for name in ("workerd", "workerd-host")
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            calls = root / "curl-calls"
            fake_curl = binary / "curl"
            fake_curl.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {calls}\n"
                "case \"$*\" in\n"
                "  */v1/sqlite/drain*) printf '%s\\n' "
                "'{\"metadata_sent\":true,\"stats\":{\"host_draining\":true,\"host_accepting_actors\":false}}' ;;\n"
                "  */v1/sqlite/stats*) printf '%s\\n' "
                "'{\"quiescent\":true,\"host_active_actors\":0,\"bridge_active_actors\":0,\"in_flight\":0,\"queued\":0}' ;;\n"
                "  *) exit 1 ;;\n"
                "esac\n"
            )
            fake_curl.chmod(0o700)
            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{binary}:{environment['PATH']}",
                    "RIVET_PRESTOP_BARRIER_DIR": str(root / "barrier"),
                    "RIVET_WORKERD_TOKEN": "0" * 64,
                }
            )
            processes = [
                subprocess.Popen(["bash", "-ec", script], env=environment)
                for script in scripts
            ]
            for process in processes:
                self.assertEqual(process.wait(timeout=5), 0)
            invocations = calls.read_text().splitlines()
            self.assertEqual(sum("/v1/sqlite/drain" in call for call in invocations), 1)
            self.assertEqual(sum("/v1/sqlite/stats" in call for call in invocations), 1)


if __name__ == "__main__":
    unittest.main()
