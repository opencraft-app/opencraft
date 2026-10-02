"""Exercise both real nodepool installers against a kubectl protocol double."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


FLEET = Path(__file__).resolve().parent.parent
KUBECTL = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:1] == ['--kubeconfig']:
    if len(args) < 3 or not args[1]:
        raise SystemExit('invalid --kubeconfig arguments: ' + repr(args))
    args = args[2:]
if args[0] == 'kustomize':
    print(os.environ['NODEPOOL_TEST_MANIFEST'])
elif args[0] == 'apply':
    print('machineset applied')
elif args[:2] == ['get', 'machineset']:
    if args[-2:] == ['-o', 'json']:
        print(os.environ['NODEPOOL_TEST_MACHINESET'])
    else:
        print('3' if 'readyReplicas' in args[-1] else '2')
elif args[:2] == ['get', 'machines']:
    print(os.environ['NODEPOOL_TEST_MACHINES'])
elif args[:2] == ['get', 'nodes']:
    print(os.environ['NODEPOOL_TEST_NODES'])
else:
    raise SystemExit('unexpected kubectl arguments: ' + repr(args))
"""


class InstallTopologyTests(unittest.TestCase):
    def run_installer(self, kind, zones, forbidden=False, unready=False, stale_type=False):
        role = 'control' if kind == 'control' else 'runtime'
        prefix = role.upper()
        labels = {f'fleet.actor.dev/{role}-pool': 'true'}
        taints = []
        if kind == 'runtime':
            labels['rivet.dev/compute'] = 'true'
            taints = [{'key': 'rivet.dev/compute', 'value': 'true', 'effect': 'NoSchedule'}]
        manifest = '\n'.join([
            'apiVersion: node.tke.cloud.tencent.com/v1beta1',
            'kind: MachineSet', f'name: np-{role}0', 'replicas: 3',
            'createPolicy: ZoneEquality', f'fleet.actor.dev/{role}-pool: "true"',
        ])
        if kind == 'runtime':
            manifest += '\nrivet.dev/compute: "true"\nkey: rivet.dev/compute\neffect: NoSchedule\nkey: fleet.actor.dev/runtime-admission\nvalue: pending'
        machine_set_uid = 'machineset-test-uid'
        desired_type = 'SA9.4XLARGE32'
        machine_set = {
            'metadata': {'uid': machine_set_uid},
            'spec': {'instanceTypes': [desired_type]},
        }
        machines = []
        nodes = []
        for index, zone in enumerate(zones):
            node_labels = dict(labels, **{'topology.kubernetes.io/zone': zone, 'kubernetes.io/hostname': f'node-{index}'})
            if forbidden and index == 0:
                node_labels['fleet.actor.dev/fdb-dedicated'] = 'true'
            nodes.append({'metadata': {'labels': node_labels}, 'spec': {'taints': taints},
                          'status': {'conditions': [{'type': 'Ready', 'status': 'False' if unready and index == 0 else 'True'}]}})
            machines.append({
                'metadata': {'ownerReferences': [{'uid': machine_set_uid}]},
                'spec': {'providerSpec': {'value': {
                    'instanceType': 'SA9.2XLARGE16' if stale_type and index == 0 else desired_type,
                }}},
                'status': {'phase': 'Running', 'nodeRef': {'name': f'node-{index}'}},
            })
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'kubectl'
            executable.write_text(KUBECTL)
            executable.chmod(0o700)
            environment = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                               NODEPOOL_TEST_MANIFEST=manifest, NODEPOOL_TEST_NODES=json.dumps({'items': nodes}),
                               NODEPOOL_TEST_MACHINESET=json.dumps(machine_set),
                               NODEPOOL_TEST_MACHINES=json.dumps({'items': machines}),
                               TMPDIR=str(root))
            environment[prefix + '_NODE_READY_TIMEOUT_SECONDS'] = '1'
            result = subprocess.run(['bash', str(FLEET / f'tke-native-{role}-nodepool/install.sh'), directory],
                                    env=environment, capture_output=True, text=True, timeout=20)
        return result

    def test_balanced_ready_nodes_pass(self):
        for kind in ('control', 'runtime'):
            with self.subTest(kind=kind):
                result = self.run_installer(kind, ['zone-a', 'zone-b', 'zone-c'])
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_cloud_ready_does_not_hide_missing_zone_at_timeout(self):
        for kind in ('control', 'runtime'):
            with self.subTest(kind=kind):
                result = self.run_installer(kind, ['zone-a', 'zone-a', 'zone-c'])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('node topology did not converge', result.stderr)

    def test_cloud_ready_does_not_hide_unready_node_at_timeout(self):
        for kind in ('control', 'runtime'):
            with self.subTest(kind=kind):
                result = self.run_installer(kind, ['zone-a', 'zone-b', 'zone-c'], unready=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('node topology did not converge', result.stderr)

    def test_cloud_ready_does_not_hide_wrong_node_role_at_timeout(self):
        for kind in ('control', 'runtime'):
            with self.subTest(kind=kind):
                result = self.run_installer(kind, ['zone-a', 'zone-b', 'zone-c'], forbidden=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('node topology did not converge', result.stderr)

    def test_cloud_ready_does_not_hide_stale_control_instance_type(self):
        result = self.run_installer('control', ['zone-a', 'zone-b', 'zone-c'], stale_type=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('node topology did not converge', result.stderr)


if __name__ == '__main__':
    unittest.main()
