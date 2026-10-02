import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("qualify_workerd_density.py")


class QualificationFailureReceiptTests(unittest.TestCase):
    def test_validation_failure_writes_atomic_terminal_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "failed.json"
            result = subprocess.run(
                ["python3", str(SCRIPT), "--actors", "0", "--output", str(receipt)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            self.assertNotEqual(result.returncode, 0)
            evidence = json.loads(receipt.read_text())
            self.assertEqual(evidence["verdict"], "failed")
            self.assertEqual(evidence["error"]["type"], "ValueError")
            self.assertIn("actors must be between", evidence["error"]["message"])
            self.assertIsNone(evidence["inflight"])


if __name__ == "__main__":
    unittest.main()
