"""Execute the archived qualification's real jq filters without cloud mutation."""

import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).parent
ADMISSION = ROOT / "evidence/c631-runtime-tools120-admission-20261003.sh"
RUNTIME_EVIDENCE = ROOT.parent.parent / "runtime/evidence"
API_UID = "1720e900-8cf0-4151-b341-b4f8fa646463"
API_IMAGE = "actor-fleet-beijing.tencentcloudcr.com/actor-fleet/workers-api@sha256:d2e890c531e1979f74dbc83714b365ee11a43050fd45bcd5a1131c83ca95f9d5"


class ReleaseAdmissionTests(unittest.TestCase):
    admission = ADMISSION
    runtime_revision = "c631f5542f45b974455543d5bb458e0b3b3cf395"
    runtime_manifest = "a54e7daa59d1b1a48403d6766a866486630b2cb7d1187a1e0d2a4427eb82bd0c"
    control_receipt = RUNTIME_EVIDENCE / "beijing-point-read-c631f554-a01-control-20261003.json"
    admission_sha256 = "653289721ab7db2b11e5699ca22973e0a3b11cd5fe2196cca54520971d6de374"

    def setUp(self):
        self.source = self.admission.read_text()
        matches = re.findall(r"--arg uid " + API_UID + r" '\s*(.*?)' >/dev/null", self.source, re.DOTALL)
        self.assertEqual(len(matches), 1, "test must execute the unique live API workload filter")
        self.api_filter = matches[0]

    def api(self, replicas=12):
        return {"metadata": {"uid": API_UID, "generation": 4},
                "spec": {"replicas": replicas, "template": {"spec": {
                    "containers": [{"image": API_IMAGE}]}}},
                "status": {"observedGeneration": 4, "readyReplicas": replicas, "updatedReplicas": replicas}}

    def check_api(self, document):
        return subprocess.run(["jq", "-e", "--arg", "uid", API_UID,
                               "--arg", "image", API_IMAGE, self.api_filter],
                              input=json.dumps(document), capture_output=True, text=True)

    def test_hpa_owned_converged_capacity_is_not_fixed_to_three(self):
        for replicas in (3, 4, 12, 30):
            with self.subTest(replicas=replicas):
                result = self.check_api(self.api(replicas))
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_malformed_or_outside_capacity_fails_closed(self):
        for replicas in (0, 2, 31, None, "12", True, 3.5):
            with self.subTest(replicas=replicas):
                self.assertNotEqual(self.check_api(self.api(replicas)).returncode, 0)

    def test_unchanged_name_cannot_hide_replacement_or_unconverged_release(self):
        variants = []
        for key, value in (("observedGeneration", 3), ("readyReplicas", 11), ("updatedReplicas", 11)):
            document = self.api()
            document["status"][key] = value
            variants.append(document)
        document = self.api()
        document["metadata"]["uid"] = "replacement"
        variants.append(document)
        document = self.api()
        document["spec"]["template"]["spec"]["containers"][0]["image"] = "registry.invalid/runtime:latest"
        variants.append(document)
        document = self.api()
        document["metadata"].pop("generation")
        document["status"].pop("observedGeneration")
        variants.append(document)
        for document in variants:
            with self.subTest(document=document):
                self.assertNotEqual(self.check_api(document).returncode, 0)

    def test_real_native_control_filter_preserves_qualified_source_identity(self):
        matches = re.findall(r"--arg manifest \"\$runtime_manifest\" '(.*?)' \"\$control\"", self.source)
        self.assertEqual(len(matches), 1)
        payload = json.loads(self.control_receipt.read_bytes())
        command = ["jq", "-e", "--arg", "cell", "actor-bj-a01", "--arg", "revision",
                   self.runtime_revision, "--arg", "manifest", self.runtime_manifest, matches[0]]
        result = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for key, value in (("control", "block"), ("cell", "actor-bj-b01"), ("warnings", ["unknown"])):
            mutated = copy.deepcopy(payload)
            mutated[key] = value
            self.assertNotEqual(subprocess.run(command, input=json.dumps(mutated),
                                              capture_output=True, text=True).returncode, 0)
        for key, value in (("revision", "0" * 40), ("manifest_sha256", "0" * 64)):
            mutated = copy.deepcopy(payload)
            mutated["sourceIdentity"][key] = value
            self.assertNotEqual(subprocess.run(command, input=json.dumps(mutated),
                                              capture_output=True, text=True).returncode, 0)

    def test_wrapper_retains_original_load_and_shared_operation_lock(self):
        self.assertEqual(hashlib.sha256(self.admission.read_bytes()).hexdigest(), self.admission_sha256)
        self.assertIn('tools_revision=12080fbe94ac5b39324a98c7a3ec60d82b87f6c1', self.source)
        self.assertIn('with-autonomy-operation-lock.sh" -- bash "$0" "$@"', self.source)
        self.assertIn('bash "$fleet/load/ten-thousand-active/run-on-builder.sh" "$run_id"', self.source)
        self.assertNotIn("kubectl scale", self.source)
        self.assertNotIn("--ready-slo-ms", self.source)
        self.assertEqual(subprocess.run(["bash", "-n", str(self.admission)], capture_output=True).returncode, 0)


class Runtime2757AdmissionTests(ReleaseAdmissionTests):
    """Exercise the next load's exact filters, not just the historical wrapper."""

    admission = ROOT / "evidence/2757-runtime-tools120-admission-prepared-20261004.sh"
    runtime_revision = "2757fc785d8f572d1b6430e471100c4a880aefac"
    runtime_manifest = "c6785b95c7d2615bbc0fdd57e2007665bd542455fa288dc6c863e389ee107300"
    control_receipt = RUNTIME_EVIDENCE / "beijing-runtime-2757-a01-control-20261004.json"
    admission_sha256 = "2385bb343b8d549c3ca4b0acec14f804af8f413fa19ae4d423255af81425a74f"


if __name__ == "__main__":
    unittest.main()
