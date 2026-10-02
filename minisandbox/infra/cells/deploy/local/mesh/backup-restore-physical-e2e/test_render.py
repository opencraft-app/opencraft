#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("render.py")
SPEC = importlib.util.spec_from_file_location("backup_restore_render", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderTest(unittest.TestCase):
    def base_documents(self):
        cell = "brq-123456"
        return [
            {"kind": "ServiceAccount", "metadata": {"name": f"{cell}-runtime"}},
            {
                "kind": "ConfigMap",
                "metadata": {"name": f"{cell}-runtime-config"},
                "data": {"config.jsonc": json.dumps({"sqlite": {}})},
            },
            {
                "kind": "Service",
                "metadata": {"name": f"{cell}-engine"},
                "spec": {},
            },
            {
                "kind": "Deployment",
                "metadata": {"name": f"{cell}-engine"},
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {"name": "engine", "volumeMounts": []}
                            ],
                            "volumes": [],
                        }
                    }
                },
            },
        ]

    def test_engine_uses_real_backup_binary_and_one_bounded_repository(self):
        documents = MODULE.configure_engine(
            self.base_documents(),
            "brq-123456",
            "backup-pvc",
            "file:///var/lib/actor-runtime/fdbbackup/catalog/backup-run",
        )
        config_map = next(item for item in documents if item["kind"] == "ConfigMap")
        config = json.loads(config_map["data"]["config.jsonc"])
        controller = config["sqlite"]["backup_recovery_fence_controller"]
        self.assertEqual(controller["fdbbackup_binary"], "/opt/actor/bin/fdbbackup")
        self.assertEqual(
            controller["backup_base_urls"],
            ["file:///var/lib/actor-runtime/fdbbackup/catalog/backup-run"],
        )
        self.assertEqual(controller["max_backup_generations"], 1)
        self.assertGreaterEqual(
            controller["lease_validity_ms"],
            2 * (controller["poll_interval_ms"] + controller["command_timeout_ms"]),
        )

        deployment = next(item for item in documents if item["kind"] == "Deployment")
        containers = deployment["spec"]["template"]["spec"]["containers"]
        self.assertEqual([item["name"] for item in containers], ["engine", "fdb-backup-agent"])
        pvc = next(item for item in documents if item["kind"] == "PersistentVolumeClaim")
        self.assertEqual(pvc["metadata"]["name"], "backup-pvc")

    def test_restore_tools_points_only_at_destination_cluster(self):
        document = MODULE.restore_tools("brq-123456", "destination-fdb", "backup-pvc")[0]
        self.assertEqual(document["kind"], "Pod")
        volumes = document["spec"]["volumes"]
        fdb = next(item for item in volumes if item["name"] == "fdb-config")
        self.assertEqual(fdb["configMap"]["name"], "destination-fdb-config")
        backup = next(item for item in volumes if item["name"] == "fdbbackup")
        self.assertEqual(backup["persistentVolumeClaim"]["claimName"], "backup-pvc")


if __name__ == "__main__":
    unittest.main()
