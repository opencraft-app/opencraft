import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("engine_nats_clients", ROOT / "verify-engine-nats-clients.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EngineNatsClientsTest(unittest.TestCase):
    def setUp(self):
        self.pods = {"items": [{"metadata": {"uid": f"uid-{i}", "labels": {
            "fleet.actor.dev/cell-name": "actor-bj-a01", "fleet.actor.dev/component": "engine"}},
            "status": {"phase": "Running", "podIP": f"10.201.0.{i}",
                       "startTime": "2026-09-15T00:00:00Z",
                       "conditions": [{"type": "Ready", "status": "True"}]}}
            for i in range(1, 4)]}
        self.servers = [{"connections": [{"ip": f"10.201.0.{i}", "name": None,
                                          "start": "2026-09-15T00:00:01Z"}]} for i in range(1, 4)]

    def verify(self):
        MODULE.verify(3, "actor-bj-a01", self.pods, self.servers)

    def test_legacy_unnamed_clients_and_new_named_clients_are_accepted(self):
        self.verify()
        for server in self.servers:
            server["connections"][0]["name"] = "rivet"
        self.verify()

    def test_three_named_foreign_clients_do_not_prove_engine_connections(self):
        for server in self.servers:
            server["connections"][0] = {"ip": "10.202.0.1", "name": "rivet"}
        with self.assertRaises(ValueError):
            self.verify()

    def test_multiple_connections_from_one_engine_are_not_three_engines(self):
        for server in self.servers:
            server["connections"][0]["ip"] = "10.201.0.1"
        with self.assertRaises(ValueError):
            self.verify()

    def test_unready_replaced_or_foreign_pods_are_rejected(self):
        original = copy.deepcopy(self.pods)
        for change in ("unready", "uid", "foreign"):
            self.pods = copy.deepcopy(original)
            pod = self.pods["items"][0]
            if change == "unready":
                pod["status"]["conditions"][0]["status"] = "False"
            elif change == "uid":
                pod["metadata"]["uid"] = ""
            else:
                pod["metadata"]["labels"]["fleet.actor.dev/cell-name"] = "actor-bj-b01"
            with self.assertRaises(ValueError):
                self.verify()

    def test_malformed_server_fails_closed(self):
        self.servers[0] = {"connections": None}
        with self.assertRaises(ValueError):
            self.verify()

    def test_stale_connection_cannot_follow_reused_pod_ip(self):
        self.pods["items"][0]["metadata"]["uid"] = "replacement-uid"
        self.pods["items"][0]["status"]["startTime"] = "2026-09-15T00:00:02Z"
        with self.assertRaisesRegex(ValueError, "not every"):
            self.verify()

    def test_fractional_and_offset_timestamps_are_compared_as_instants(self):
        self.pods["items"][0]["status"]["startTime"] = "2026-09-15T08:00:00.123456789+08:00"
        self.servers[0]["connections"][0]["start"] = "2026-09-15T00:00:00.123457Z"
        self.verify()

    def test_timestamp_parser_does_not_require_datetime_fromisoformat(self):
        source = (ROOT / "verify-engine-nats-clients.py").read_text()
        self.assertNotIn("fromisoformat", source)
        with self.assertRaisesRegex(ValueError, "RFC3339"):
            MODULE.parse_timestamp("2026-09-15 00:00:00")


if __name__ == "__main__":
    unittest.main()
