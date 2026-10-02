#!/usr/bin/env python3
"""Reject unschedulable control capacity before mutating the runtime."""

import json
import sys


def validate(document, cell, mode):
    if mode not in ('production-multi-zone', 'qualification-single-zone'):
        raise ValueError('unknown runtime availability mode')
    expected_zones = 3 if mode == 'production-multi-zone' else 1
    nodes = document.get('items', [])
    if len(nodes) < expected_zones:
        raise ValueError('runtime control topology has insufficient Nodes')
    zones, hosts, identities = set(), set(), set()
    for node in nodes:
        metadata, spec = node.get('metadata', {}), node.get('spec', {})
        labels = metadata.get('labels', {})
        conditions = {item['type']: item['status'] for item in node.get('status', {}).get('conditions', [])}
        if metadata.get('deletionTimestamp') or spec.get('unschedulable') or conditions.get('Ready') != 'True':
            raise ValueError('runtime control Node is not schedulable and Ready')
        if labels.get('fleet.actor.dev/cell-name') != cell or labels.get('fleet.actor.dev/control-pool') != 'true':
            raise ValueError('runtime control Node belongs to a different Cell or pool')
        if any(labels.get(key) == 'true' for key in ('rivet.dev/compute', 'rivet.dev/pvm', 'fleet.actor.dev/fdb-dedicated')):
            raise ValueError('runtime control Node carries an incompatible role')
        if any(taint.get('effect') in ('NoSchedule', 'NoExecute') for taint in spec.get('taints', [])):
            raise ValueError('runtime control Node retains a scheduling fence')
        zone, host, identity = labels.get('topology.kubernetes.io/zone'), labels.get('kubernetes.io/hostname'), metadata.get('uid')
        if not zone or not host or not identity or host in hosts or identity in identities:
            raise ValueError('runtime control Node has missing or duplicate topology identity')
        zones.add(zone)
        hosts.add(host)
        identities.add(identity)
    if len(zones) != expected_zones:
        raise ValueError(f'runtime control topology has {len(zones)} zones; requires {expected_zones}')


if __name__ == '__main__':
    try:
        with open(sys.argv[1]) as stream:
            validate(json.load(stream), sys.argv[2], sys.argv[3])
    except (IndexError, KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error))
