# Tencent CCN-ready fleet network

`ccn-plan.yaml` is the target address contract for separating the Hub (C), runtime A, and runtime B
into three Beijing VPCs. It is reviewed inventory, not an apply script, and does not alter the
existing qualification deployment in VPC `vpc-6c2snz3a` / `10.128.0.0/16`.

The new-Cell target uses non-overlapping `/20` VPCs inside one reserved regional `/12`, with
three `/22` subnets per Cell across Beijing zones 6, 7, and 8. A fourth `/22` is recorded in
`reservedSubnets` and remains unallocated. Management C retains its `/16` VPC and three `/20`
subnets. Pod and Service CIDRs are also globally distinct
for diagnostics and future migrations, but they must not be advertised through CCN. Cross-cluster
traffic terminates on private CLBs whose addresses belong to their VPC subnets:

```text
Hub C Caddy -> CCN -> runtime A private gateway CLB:443
            -> CCN -> runtime B private gateway CLB:443
Hub C Workers API -> CCN -> runtime A/B private gateway CLB:6420
Hub C Argo CD -> CCN -> runtime A/B private Kubernetes API:443
runtime A Guard -> CCN -> runtime B private gateway CLB:443
runtime B Guard -> CCN -> runtime A private gateway CLB:443
LightVela Beijing site-gateway -> CCN -> Hub C Workers API:6688
```

The LightVela operations VPC is an external existing network, not part of the
Actor regional aggregate. It is reserved from Actor allocation and binds a
custom CCN route table that imports only C. The default route table first allows
its routes to C and then drops them for every other VPC. This second rule is
future-safe: a newly attached Cell is isolated even before an operator knows its
VPC ID. Security groups and service authentication remain the authorization
boundary after routing has established reachability.

## Regional expansion review

Live inventory reviewed on 2026-09-21 confirms at least three available CVM
zones in Beijing, Shanghai, and Singapore. The create-first Terraform roots are
region-parameterized and the live-zone preflight remains mandatory. Network
deployment follows this collision-free intent:

| Region | Operations VPC | Actor VPC aggregate | Actor Pod allocation | Service allocation |
|---|---|---|---|---|
| Beijing | `lightclaw-bj8`, `10.0.0.0/12` | `10.160.0.0/12` | `10.200.0.0/16`–`10.202.0.0/16` | `172.20.0.0/22`–`172.22.0.0/22` |
| Shanghai | `lightclaw-shprod`, `10.0.0.0/12` | `10.176.0.0/12` | `10.208.0.0/16`–`10.210.0.0/16` | `172.24.0.0/22`–`172.26.0.0/22` |
| Singapore | `lightclaw-sgprod`, `10.0.0.0/12` | `10.224.0.0/12` | `10.216.0.0/16`–`10.218.0.0/16` | `172.28.0.0/22`–`172.30.0.0/22` |

The repeated operations CIDR makes separate per-region CCNs a hard invariant,
not merely a preference. Actor allocations are nevertheless distinct, which
keeps a future controlled transit or migration possible without renumbering.

## New-Cell address budget

The planning target is up to 1,024 total Cell nodes, including control, FDB, runtime,
bootstrap and temporary repair/upgrade nodes. This is not a qualified scale or an automatic
increase to any MachineSet, HPA or FDB process ceiling. A `/20` contains 4,096 raw addresses;
each active AZ `/22` contains 1,024 raw addresses. Cloud reservations, other interfaces,
CLBs and the peak replacement-node placement must be deducted per AZ, including a scenario
with one AZ unavailable. The fourth `/22` is address reserve, not a fourth deployed AZ.

GR Pod address allocation is a separate budget. The current example `/16` and
`cluster_max_pod_num=64` are retained, but must not be claimed to support 1,024 nodes.
Before raising the qualified ceiling, verify TKE's actual per-node Pod address-block size,
cluster reservations, control-plane tier and quotas; size the Pod CIDR for the peak node
count with recovery headroom. Cross-Cell Pod/Service routes remain prohibited.

The regional `/12` can be subdivided into 256 `/20` allocations mathematically. C's `/16`
occupies 16 such allocations, leaving at most 240 before other reservations. CCN attachment
and route quotas are independent limits, not implied by this address arithmetic. Expand
through reviewed network domains or quota increases rather than overlapping connected routes.

The create-first example matches this plan through its network contract tests. CIDR sizes
remain Terraform inputs, not protocol constants. Apply this allocation only to new
infrastructure with reviewed live inventory. It does not shrink an existing `/16` VPC or
authorize reusing any part of an existing allocation, even if its nodes use only one `/20`.

CCN routing establishes reachability, not authorization. The create-first
foundation deliberately owns one ordinary CCN and every management/Cell root
owns only its exact VPC attachment. This avoids relying on route-table
selection behavior for same-region traffic. The only authorized A/B path is
the pair of exact Guard-to-private-CLB flows required when a randomly selected
Guard forwards an Actor request to its owning Cell. Node security groups deny
peer-VPC node ingress, private CLBs expose only their gateway listener, and
gateway mTLS authenticates the caller. A future dedicated gateway subnet may
add route-table isolation as defense in depth, but it must not replace those
controls. In particular, only the Argo identity receives
network access to each Kubernetes API; Hub ingress, Workers API and peer Cells
do not. No Hub component receives access to Cell FDB, NATS, Pod CIDRs, or
Service CIDRs.

Before creating any VPC or attaching it to CCN, add every corporate, IDC, VPN, existing VPC, Docker,
and TKE allocation to `reservedCidrs`, then run:

```sh
python3 infra/cells/deploy/tencent/fleet/network/validate-plan.py
python3 infra/cells/deploy/tencent/fleet/network/test-plan.py
```

The historical Cell B module continues to reference its existing VPC and must not be silently
migrated or reinterpreted by this document. New infrastructure uses the contract-tested
`../terraform/create-first/cell/terraform.tfvars.example` as its starting allocation.
