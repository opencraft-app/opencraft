# Chengdu regional bootstrap and disposal

## Regional availability contract

The live CVM `DescribeZones` response for `ap-chengdu` on 2026-09-15 contained
only `ap-chengdu-1`, with state `AVAILABLE` and zone ID `160001`.
`DescribeZoneInstanceConfigInfos` also returned all 580 configurations in that
one zone. These APIs prove current CVM node availability for this account and
service, not the number of physical datacenters Tencent operates in Chengdu.

A region name must never imply multi-AZ eligibility. Run
`preflight-region-zones.sh` before creating billable regional infrastructure.
The production contract requires at least three live `AVAILABLE` CVM zones;
single-zone qualification may run functional and recovery tests but must retain
`readyForPlacement=false` with reason `QualificationOnly`.

## Reusable implementation and evidence

The region-portable fixes are recorded in commit
`e2c083b45c45f8769f5af3b6caeb5b9a7370b851`:

- COS endpoint and signing region derive from the bound regional Profile.
  Runtime release rejects conflicting overrides.
- The explicit qualification topology retains hostname isolation without
  requiring three nonexistent CVM zones. Production topology remains strict.
- Builder bootstrap, digest-pinned TCR supply, COS relay, TKE MachineSets,
  Argo adoption and runtime receipts use the create-first template.
- The permanent Counter Host-replacement verifier tests native SQLite-backed
  Durable Object state and stable Actor identity.

The real public-API qualification passed with 48 Actors and 6,240 persistent
writes, natural cold transition, sleep/wake and three workerd Hosts. Cold wake
p95 was 679 ms; p99/max was 2,704 ms. The Counter test observed `1 -> 2 -> 3`
across sleep and Host Pod replacement with an unchanged Actor ID.

Receipts are archived under
`/data/actor-rebuild/chengdu-v5-20260915/`. Cloud IDs belong only in those
operational inventories and receipts, not in reusable Terraform/YAML inputs.

## Disposal ownership lessons

The Cell had nine TKE MachineSet-owned nodes in addition to its Terraform
bootstrap CVM. Deleting Machines while the capacity reconciler remained active
caused three replacement runtime Machines. Removing Argo registration is not
enough: stop capacity/Fleet reconcilers before retiring their desired state.
TKE `DeleteClusterMachines` accepts only Machines from one node pool per
request. Retire with scale-down enabled and wait for an empty cloud Machine
inventory.

Late regional FDB backup writes recreated 19 zero-byte objects after an early
bucket-empty pass. Stop all writers first, then empty the exact bucket and
generate the final destroy plan.

TKE deletion intentionally left seven `Retain` CBS disks: three 200 GiB Cell
FDB disks, three 50 GiB regional Registry FDB disks and one 10 GiB Git disk.
They were separately verified as unattached and bound to the exact deleted
cluster IDs before explicit deletion. No snapshots existed.

TCR instance deletion without `delete_bucket=true` left its physical COS
backing bucket with 714 objects and 3,066,902,503 bytes. The template now enables
backing-bucket deletion for an explicitly authorized TCR destroy.

The TKE OIDC role-policy attachment is account-scoped. The disposable regional
state released that address without deleting the cloud attachment, because
Beijing TKE still requires it. Multi-region bootstrap must have one account
owner for this prerequisite; separate regional states must not detach it.

Final disposal evidence, exact deletion requests and zero-resource states are
archived under the `teardown/` directory. The final cloud audit must check
retained disks, CLBs and backing buckets as well as Terraform state.

Disposal completed on 2026-09-15. The exact targeted TKE, VPC, CVM, TCR,
CCN, CLB and CBS inventories are empty; all three remote Terraform states
have zero resources. Regional data buckets, the versioned state bucket and
the TCR backing bucket were deleted. Beijing A/B/C remain `Running`; the
unrelated July Chengdu bucket and shared account OIDC policy were preserved.
The summary receipt is `teardown/teardown-complete.json` in the archive above.
Deleted cloud test data and disks are not recoverable; local receipts and
source remain available.
