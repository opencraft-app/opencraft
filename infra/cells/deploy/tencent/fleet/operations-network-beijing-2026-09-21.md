# Beijing operations-network admission — 2026-09-21

## Result

Beijing LightVela operations VPC `vpc-21gzr2dc` (`lightclaw-bj8`,
`10.0.0.0/12`) is attached to Actor CCN `ccn-o7jxphwl` through custom route
table `ccnrtb-r2ab1gef`. These IDs are live evidence only; rebuild resolves the
operations VPC by exact name and CIDR and obtains both CCN route-table IDs from
Terraform state.

The applied contract is:

- custom operations table accepts routes only from C VPC `vpc-2e07jlai`;
- default table first allows operations routes to C;
- its next policy drops operations routes to every VPC, covering A, B and any
  future Cell through first-match policy ordering;
- Workers API security-group ingress uses the qualified CLB listener port
  TCP/6688, not the container target port 8080.

Both management and operations-network Terraform roots returned `No changes`
after apply.

## Live proof

The VPC route tables converged as follows:

- C learned the seven actual LightVela subnets inside `10.0.0.0/12`;
- LightVela learned only C's `10.160.0.0/20`, `10.160.16.0/20` and
  `10.160.32.0/20` subnets;
- A (`vpc-aed27izk`) and B (`vpc-3m6m3j6s`) learned no LightVela route.

A TAT probe from LightVela node `ins-q3pioiy7` to the private Workers API
`http://10.160.0.3:6688/v1` returned the API's structured HTTP 404 response.
That proves the forward route, CLB listener, security group, backend and return
route without mutating Worker or Object state.

## Shanghai and Singapore readiness

Live read-only preflight passed production multi-zone eligibility:

- Shanghai: `ap-shanghai-2`, `ap-shanghai-5`, `ap-shanghai-8`;
- Singapore: `ap-singapore-1` through `ap-singapore-4`.

Their production operations VPCs (`lightclaw-shprod` and
`lightclaw-sgprod`) both use `10.0.0.0/12`. Therefore they must use independent
regional Actor CCNs and independent operations-network states. The reviewed
non-overlapping Actor allocations are recorded in `network/README.md`; no
Shanghai or Singapore cloud resources were created by this change.
