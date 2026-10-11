import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
remote=module('recovery_remote','images/helpers/recover-hermes-runtime.py')
ci=module('recovery_ci','.ci/runtime/support/recover_hermes_production.py')

class RecoveryTests(unittest.TestCase):
 def test_uncertain_dispatch_is_not_replayed(self):
  with tempfile.TemporaryDirectory() as directory:
   out=Path(directory)
   with patch.object(ci,'tasks',return_value=[]), patch.object(ci,'cloud',side_effect=RuntimeError('network outcome unknown')) as api:
    with self.assertRaises(RuntimeError):ci.ensure_invoked('cmd-test','ins-test',out)
    with self.assertRaisesRegex(RuntimeError,'reconcile'):ci.ensure_invoked('cmd-test','ins-test',out)
    self.assertEqual(api.call_count,1)
   with patch.object(ci,'tasks',return_value=[{'instance':'ins-test','status':'RUNNING'}]), patch.object(ci,'cloud') as api:
    ci.ensure_invoked('cmd-test','ins-test',out);api.assert_not_called()
 def test_preflight_rejects_paused_and_successful_targets(self):
  plan=json.loads((ROOT/'images/hermes-production-recovery-targets.json').read_text())
  inventory=[{'cloud_id':i,'state':'ALLOCATED','pool_base_image':plan['image_id']} for i in plan['instances']]
  previous=[{'instance':i,'status':'SUCCESS','created':'2026-10-12'} for i in plan['instances']]
  def inventory_result():return SimpleNamespace(returncode=0,stdout='\n'.join(json.dumps(x) for x in inventory))
  with patch.object(ci.subprocess,'run',side_effect=lambda *a,**kw:inventory_result()),patch.object(ci,'tasks',return_value=previous),patch.object(ci,'cloud') as api:
   with self.assertRaisesRegex(RuntimeError,'terminal failed'):ci.preflight(plan)
   inventory[0]['state']='PAUSED'
   with self.assertRaisesRegex(RuntimeError,'target state'):ci.preflight(plan)
   api.assert_not_called()
 def test_incomplete_upgrade_not_skipped_when_versions_match(self):
  versions={k:'0.21.5' for k in ['cliVersion','importVersion','distributionVersion','identityVersion']}
  self.assertFalse(remote.completed('PROGRESSING:stage6:Node.js',versions))
  self.assertFalse(remote.completed('FAILED',versions))
  self.assertTrue(remote.completed('COMPLETED:2026.9.24',versions))
  versions['identityVersion']='0.21.3';self.assertFalse(remote.completed('COMPLETED:2026.9.24',versions))
 def test_identity_confusion_rejected(self):
  from pathlib import Path
  identity='runtime: hermes\nrun_as: agentuser\nruntime_home: /home/agentuser/.hermes\n'
  self.assertTrue(remote.identity_valid(identity,Path('/home/agentuser')))
  self.assertFalse(remote.identity_valid(identity.replace('run_as: agentuser','run_as: root'),Path('/home/agentuser')))
  self.assertFalse(remote.identity_valid(identity.replace('/home/agentuser/.hermes','/root/.hermes'),Path('/home/agentuser')))
 def test_scope_and_duplicates(self):
  p=json.loads((ROOT/'images/hermes-production-recovery-targets.json').read_text());ci.validate_plan(p)
  for change in [{'region':'ap-shanghai'},{'instances':[]},{'instances':['ins-a','ins-a']},{'instances':['ins-x;echo nope']}]:
   with self.assertRaises(ValueError):ci.validate_plan(dict(p,**change))
 def test_terminal_success_requires_all_layers(self):
  p=dict(probe='hermes-production-recovery',passed=True,gatewayActive=True,upgradeCompleted=True,expectedVersion='0.21.5',cliVersion='0.21.5',importVersion='0.21.5',distributionVersion='0.21.5',identityVersion='0.21.5')
  row={'status':'SUCCESS','exit':0,'probe':p};self.assertTrue(ci.verified(row))
  for key in ['passed','gatewayActive','upgradeCompleted','identityVersion']:
   self.assertFalse(ci.verified(dict(row,probe=dict(p,**{key:False}))))
  self.assertFalse(ci.verified(dict(row,status='RUNNING')))
 def test_payload_embeds_only_reviewed_helpers(self):
  shell=ci.payload();self.assertTrue(shell.startswith('#!/bin/bash\nset -euo pipefail\n'))
  python=shell.split("python3 - <<'RECOVERY_PY'\n",1)[1].rsplit('RECOVERY_PY',1)[0]
  compile(python,'payload','exec')
 def test_official_target_is_fixed(self):
  c=remote.upgrade_command();self.assertEqual(c[:3],['/usr/local/bin/acli','backend','upgrade-start'])
  self.assertIn('hermes-agent-v20260928',c);self.assertIn('--force=true',c)

if __name__=='__main__':unittest.main()
