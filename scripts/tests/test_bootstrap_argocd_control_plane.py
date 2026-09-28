from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]


class ArgoCDControlPlaneBootstrapContractTest(unittest.TestCase):
    def test_bootstrap_waits_for_a_registered_node(self) -> None:
        script = (REPO_ROOT / "scripts/bootstrap_argocd_control_plane.sh").read_text()

        wait_start = script.index('node_name=""')
        taint_start = script.index('/usr/local/bin/k0s kubectl taint node')
        wait_block = script[wait_start:taint_start]

        self.assertIn("jsonpath='{.items[0].metadata.name}'", wait_block)
        self.assertIn('[[ -n "${node_name}" ]] && break', wait_block)
        self.assertIn('if [[ -z "${node_name}" ]]; then', wait_block)
        self.assertIn("k0s node was not registered before the bootstrap timeout", wait_block)


if __name__ == "__main__":
    unittest.main()
