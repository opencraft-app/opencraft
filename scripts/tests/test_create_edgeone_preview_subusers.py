import importlib.util
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / "scripts").is_dir())
SCRIPT_PATH = REPO_ROOT / "scripts" / "create_edgeone_preview_subusers.py"

spec = importlib.util.spec_from_file_location("create_edgeone_preview_subusers", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class CreateEdgeOnePreviewSubusersTests(unittest.TestCase):
    def test_run_command_rejects_empty_command_parts(self) -> None:
        with mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "non-empty strings"):
                module.run_command(["tccli", ""])

        run.assert_not_called()

    def test_run_tccli_parses_response_payload(self) -> None:
        # Test fixture only; no subprocess is launched here.
        completed = subprocess.CompletedProcess(
            ["tccli"],
            0,
            stdout='{"Response":{"Uin":123,"Uid":456}}',
            stderr="",
        )  # nosemgrep: dangerous-subprocess-use-audit
        with mock.patch.object(module.subprocess, "run", return_value=completed) as run:
            payload = module.run_tccli("secret-id", "secret-key", ["cam", "GetUser", "--Name", "demo"])

        self.assertEqual(payload["Response"]["Uin"], 123)
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["tccli", "cam", "GetUser"])
        self.assertIn("--secretId", command)
        self.assertIn("--secretKey", command)

    def test_utc_timestamp_uses_z_suffix(self) -> None:
        self.assertRegex(module.utc_timestamp(), re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"))


if __name__ == "__main__":
    unittest.main()
