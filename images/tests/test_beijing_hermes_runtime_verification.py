import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('beijing_verify', Path(__file__).parents[2] / '.ci/runtime/support/pin_beijing_hermes_existing_vms.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class TerminalProofTests(unittest.TestCase):
    def test_without_execute_flag_has_no_vm_actions(self):
        with patch('sys.argv', ['pin_beijing_hermes_existing_vms.py']), patch.object(verify, 'run') as run:
            self.assertEqual(verify.main(), 0)
            run.assert_not_called()

    def proof(self):
        return {'TaskStatus': 'SUCCESS', 'ExitCode': 0, 'probe': dict.fromkeys(('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion', 'expectedVersion'), '0.21.5') | {'passed': True}}

    def test_runtime_versions_must_match_even_when_command_reports_success(self):
        for field in ('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'):
            proof = self.proof()
            proof['probe'][field] = '0.21.3'
            self.assertFalse(verify.task_verified(proof, '0.21.5'))

    def test_invoked_or_running_cannot_pass(self):
        for status in ('INVOKED', 'RUNNING', 'TIMEOUT', 'FAILED'):
            proof = self.proof()
            proof['TaskStatus'] = status
            self.assertFalse(verify.task_verified(proof, '0.21.5'))

    def test_zero_exit_code_and_probe_required(self):
        proof = self.proof()
        self.assertTrue(verify.task_verified(proof, '0.21.5'))
        proof['ExitCode'] = 1
        self.assertFalse(verify.task_verified(proof, '0.21.5'))
        proof['ExitCode'] = 0
        proof['probe'] = None
        self.assertFalse(verify.task_verified(proof, '0.21.5'))


if __name__ == '__main__':
    unittest.main()
