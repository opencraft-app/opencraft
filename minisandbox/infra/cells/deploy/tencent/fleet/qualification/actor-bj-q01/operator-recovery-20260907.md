# q01 operator management outage, 2026-09-07

This is an incident record, not a production qualification receipt. All times are UTC.

## Evidence

- The exact q01 bootstrap operator is `ins-rk1burif`, private IP `10.128.6.45`, in
  cluster `cls-ike1rebd`. CVM reports the name `actor-bj-q01-bootstrap`; TKE reports
  only `fleet.actor.dev/bootstrap=true` and `fleet.actor.dev/cell-name=actor-bj-q01`
  as its advanced-setting labels. It is not a dedicated runtime or FDB node.
- Runtime build `inv-f8c9n2g6n5` started at 05:39:18 from source
  `669e4dd5ffd53a234ef257c25cfc837a76120582`, with source manifest
  `6f5aaad8c9b948eca1262edddf80a9a5d187ed9324d75c332acb4e865a665b4d`.
- CVM monitoring returned its last CPU/memory/load samples at 05:43:00:
  CPU 99.65%, memory 81.408%, load 3.935 on a 4-core, 8 GiB instance.
  A later explicitly bounded query through 06:02:12 returned no newer samples.
  This is not evidence that the machine remained at those utilization levels.
- Read-only commands `inv-h8c9t9gpxu`, `inv-h8c9vsg2fx`, and `inv-f8ca7k0rwq`
  ended `DELIVER_FAILED`, although TAT continued reporting an Online agent with
  recent heartbeats. An Online heartbeat is insufficient management-readiness evidence.
- TKE `DescribeClusterInstances` subsequently reported the exact instance as `failed`:
  `K8SNODE is NOTREADY=MemoryPressure:Unknown,DiskPressure:Unknown,PIDPressure:Unknown,Ready:Unknown`.
  The root cause is not yet established. In particular, OOM has not been proven.

## Actions and safety boundaries

1. Fixed the TAT waiter to wait through `DELIVERING`, `DELIVER_DELAYED`, and
   `CANCELLING`. Terminal non-success states still fail even with exit code zero.
2. Requested cancellation of only the candidate build, request ID
   `6ff4474f-6f47-4546-b6d9-50c5b7710304`. Its observed state was `CANCELLING`,
   not confirmed termination. No replacement build was submitted.
3. Checked the exact CVM identity and q01 membership before recovery. With the node
   confirmed NotReady and repeated management delivery failures, requested `SOFT`
   reboot of only `ins-rk1burif`, request ID `29e63692-5b7f-46fe-97fd-e58965d75070`.
   The caller held the shared operation lock while observing completion. This first
   attempt did not request a hard-reboot fallback, instance deletion, disk deletion,
   or business rollout.
4. Future q01 builds default to one Cargo job, with at most two explicitly selected.
   This is a parallelism bound, not a memory cgroup limit or proof of the incident cause.

At 06:13 UTC the CVM returned to `RUNNING`, but the matching `LatestOperationRequestId`
reported `LatestOperationState=FAILED`; TKE still reported the node NotReady. The
observer's `soft_reboot_cycle=completed` message describes only a state transition,
not successful reboot. Always check the exact cloud operation result as well.

After confirming this failed soft reboot, a separate explicit `HARD` reboot was
requested for only the same bootstrap instance, request ID
`1609e24b-626a-4f72-a750-bfe372ea5b4d`. It retains the instance and disks and may lose
unflushed local build state. The caller holds the shared lock until observation ends
and checks this exact request's operation outcome, not just CVM state. It does not
retry a failed hard reboot automatically. Successful recovery is still unproven.

## Recovery outcome and controlled build evidence

- The hard reboot's exact cloud operation reached `SUCCESS`; the boot ID changed and a
  fresh TAT command executed. TKE returned the node to Ready with no MemoryPressure,
  and the business Engine, Workers API, and runtime workloads remained fully Ready.
- The interrupted build had no surviving compiler process after the boot-ID change. Its
  stale TAT cancellation record is not used as execution state or release evidence.
- The independently reviewed publisher recovery rotated only the release-publisher token,
  preserved the reader and Argo credentials, and verified repository identity 1.
- A later GNU-linker build and an lld build were each run inside an exact 6 GiB build
  cgroup. Both reached the final `rivet-engine` fat-LTO link and were killed by that
  cgroup. Kernel evidence named `CONSTRAINT_MEMCG` and the exact build scope; the lld
  attempt's rustc process had 6,101,240 KiB anonymous RSS. The node remained Ready and
  the business workloads remained fully Ready. Thus these two controlled failures prove
  the fat-LTO build does not fit this boundary; they do not retroactively prove the cause
  of the original outage.
- No image was produced or pushed by either failed controlled build. The follow-up build
  keeps opt-level 3 and one codegen unit, uses ThinLTO plus lld, and retains the same
  `MemoryMax=6G` fail-closed boundary.

The remaining release qualification is the successful bounded candidate build, immutable
digest publication, and the Argo-driven public `/v1` user-transparent upgrade gate. FDB
backup/restore, HA, and autonomy receipts remain separate production gates.

Do not reuse this interrupted build as a passed release. Do not treat a CVM `RUNNING`
state alone as successful node recovery or public service availability.
