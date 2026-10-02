import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('control_topology', ROOT / 'validate-control-node-topology.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def nodes(zones):
    return {'items': [{'metadata': {'uid': f'uid-{index}', 'labels': {
        'fleet.actor.dev/cell-name': 'actor-bj-b01', 'fleet.actor.dev/control-pool': 'true',
        'kubernetes.io/hostname': f'host-{index}', 'topology.kubernetes.io/zone': zone}},
        'spec': {}, 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        for index, zone in enumerate(zones)]}


class ControlTopologyTests(unittest.TestCase):
    def test_three_ready_zones_pass(self):
        MODULE.validate(nodes(['a', 'b', 'c']), 'actor-bj-b01', 'production-multi-zone')

    def test_missing_zone_fails(self):
        with self.assertRaisesRegex(ValueError, 'has 2 zones'):
            MODULE.validate(nodes(['a', 'a', 'c']), 'actor-bj-b01', 'production-multi-zone')

    def test_qualification_single_zone_is_explicit(self):
        MODULE.validate(nodes(['a']), 'actor-bj-b01', 'qualification-single-zone')
        with self.assertRaises(ValueError):
            MODULE.validate(nodes(['a']), 'actor-bj-b01', 'production-multi-zone')

    def test_rejects_unready_cordoned_fenced_foreign_and_role_polluted_nodes(self):
        base = nodes(['a', 'b', 'c'])
        bad = []
        for reason in ('unready', 'cordoned', 'fenced', 'foreign', 'role', 'deleting', 'duplicate', 'missing'):
            document = copy.deepcopy(base)
            node = document['items'][0]
            if reason == 'unready': node['status']['conditions'][0]['status'] = 'False'
            elif reason == 'cordoned': node['spec']['unschedulable'] = True
            elif reason == 'fenced': node['spec']['taints'] = [{'effect': 'NoSchedule'}]
            elif reason == 'foreign': node['metadata']['labels']['fleet.actor.dev/cell-name'] = 'actor-bj-a01'
            elif reason == 'role': node['metadata']['labels']['rivet.dev/compute'] = 'true'
            elif reason == 'deleting': node['metadata']['deletionTimestamp'] = '2026-09-15T00:00:00Z'
            elif reason == 'duplicate': node['metadata']['labels']['kubernetes.io/hostname'] = 'host-1'
            elif reason == 'missing': del node['metadata']['uid']
            bad.append((reason, document))
        for reason, document in bad:
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                MODULE.validate(document, 'actor-bj-b01', 'production-multi-zone')

    def test_guard_precedes_runtime_auth_and_admission_mutations(self):
        installer = (ROOT / 'install.sh').read_text()
        self.assertLess(installer.index('validate-control-node-topology.py'), installer.index('create secret generic "${cell_name}-runtime-auth"'))
        self.assertLess(installer.index('validate-control-node-topology.py'), installer.index('"$script_dir/install-admission-controller.sh"'))


if __name__ == '__main__':
    unittest.main()
