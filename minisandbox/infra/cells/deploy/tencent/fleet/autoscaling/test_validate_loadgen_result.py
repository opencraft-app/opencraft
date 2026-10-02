#!/usr/bin/env python3

import argparse
import copy
import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).with_name("validate_loadgen_result.py")
SPEC = importlib.util.spec_from_file_location("validate_loadgen_result", str(MODULE))
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def arguments(mode="populate"):
    return argparse.Namespace(
        mode=mode, run_id="q01-test", cell="actor-bj-q01", target=1000, probes=256,
        batch_size=32, batch_settle_seconds=45.0, operation_rate=100.0,
        max_idempotent_retries=8, job_name="job", pod_name="pod", pod_uid="uid",
    )


def document(mode="populate"):
    states = {"dormant": 1000}
    probes = {}
    if mode == "probe":
        probes = {"deleted": 256}
    elif mode == "cleanup":
        states = {"deleted": 1000}
    return {
        "verdict": "passed", "api_mode": "workers-v1", "public_api_only": True,
        "mode": mode, "run_id": "q01-test", "cell_id": "actor-bj-q01",
        "target_actors": 1000, "batch_size": 32, "batch_settle_seconds": 45.0,
        "operation_rate": 100.0, "max_idempotent_retries": 8,
        "actor_states": states, "probe_states": probes,
        "worker_release": {
            "worker": "q01-fdb-autoscale-gate", "version_ids": ["v_fixed"],
            "deployment_id": "d_fixed", "version_pool_size": 1,
        },
    }


class ValidateLoadgenResultTests(unittest.TestCase):
    def test_accepts_every_phase_and_binds_exact_pod(self):
        for mode in ("populate", "probe", "cleanup"):
            result = VALIDATOR.validate(document(mode), arguments(mode))
            self.assertEqual(result["qualification_evidence"], {
                "jobName": "job", "podName": "pod", "podUID": "uid",
            })

    def test_rejects_private_api_or_wrong_inventory(self):
        private = document()
        private["public_api_only"] = False
        with self.assertRaisesRegex(ValueError, "public /v1"):
            VALIDATOR.validate(private, arguments())
        wrong = document()
        wrong["actor_states"] = {"dormant": 999}
        with self.assertRaisesRegex(ValueError, "inventory"):
            VALIDATOR.validate(wrong, arguments())
        unique_code = document()
        unique_code["worker_release"]["version_pool_size"] = 1000
        with self.assertRaisesRegex(ValueError, "one immutable Worker Version"):
            VALIDATOR.validate(unique_code, arguments())
        wrong_rate = document()
        wrong_rate["operation_rate"] = 99.0
        with self.assertRaisesRegex(ValueError, "operation rate"):
            VALIDATOR.validate(wrong_rate, arguments())

    def test_does_not_mutate_input(self):
        source = document()
        before = copy.deepcopy(source)
        VALIDATOR.validate(source, arguments())
        self.assertEqual(source, before)


if __name__ == "__main__":
    unittest.main()
