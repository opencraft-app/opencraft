#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


PATH = pathlib.Path(__file__).with_name("verify_approved_release_commands.py")
SPEC = importlib.util.spec_from_file_location("verify_approved_release_commands", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def identity(prefix):
    return {
        "image": f"registry.invalid/{prefix}@sha256:" + "a" * 64,
        "sourceRevision": "b" * 40,
        "sourceManifestSHA256": "c" * 64,
    }


def receipt():
    return {
        "schema": "actor-approved-release-commands/v2",
        "cell": "actor-bj-q01",
        "runID": "d" * 32,
        "control": {
            "sourceRevision": "e" * 40,
            "sourceManifestSHA256": "f" * 64,
        },
        "upgrade": {"commandID": "cmd-upgr4de1", "contentSHA256": "1" * 64},
        "rollback": {"commandID": "cmd-r0llback", "contentSHA256": "2" * 64},
        "candidate": {"runtime": identity("runtime-new"), "reporter": identity("reporter-new")},
        "previous": {"runtime": identity("runtime-old"), "reporter": identity("reporter-old")},
        "imageInventorySHA256": "3" * 64,
        "coldBucket": "actor-depot-cold-prod-bj-q01-nv1-1234567890",
        "approvalTag": "actor-release-approved=true",
        "parameterized": False,
        "verdict": "passed",
    }


class ApprovedReleaseCommandsTest(unittest.TestCase):
    def test_accepts_exact_upgrade_and_rollback(self):
        value = receipt()
        for phase, command_id, release in (
            ("upgrade", "cmd-upgr4de1", value["candidate"]),
            ("rollback", "cmd-r0llback", value["previous"]),
        ):
            result = MODULE.verify(
                value,
                phase=phase,
                command_id=command_id,
                run_id="d" * 32,
                runtime=release["runtime"],
                reporter=release["reporter"],
            )
            self.assertEqual(result["phase"], phase)

    def test_rejects_cross_release_command_before_invocation(self):
        value = receipt()
        with self.assertRaisesRegex(ValueError, "runtime identity mismatch"):
            MODULE.verify(
                value,
                phase="upgrade",
                command_id="cmd-upgr4de1",
                run_id="d" * 32,
                runtime=value["previous"]["runtime"],
                reporter=value["candidate"]["reporter"],
            )

    def test_rejects_parameterized_or_wrong_command(self):
        value = receipt()
        value["parameterized"] = True
        with self.assertRaisesRegex(ValueError, "parameterized"):
            MODULE.verify(
                value,
                phase="rollback",
                command_id="cmd-wrong000",
                run_id="d" * 32,
                runtime=value["previous"]["runtime"],
                reporter=value["previous"]["reporter"],
            )


if __name__ == "__main__":
    unittest.main()
