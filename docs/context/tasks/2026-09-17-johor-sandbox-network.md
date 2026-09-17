---
id: johor-sandbox-network
type: task
scope: Dedicated Pulumi-managed Johor network fabric for Singapore production Sandbox pools.
triggers: ["johor sandbox network", "sandbox-network", "ap-johorbahru vpc"]
status: active
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - infra_pulumi/pkg/app/program.go
  - infra_pulumi/pkg/components/networking/networking.go
  - infra_pulumi/envs/tencentcloud/sgprod-johor-sandbox-network/inventory.yaml
  - sandbox/cmd/worker/main.go
  - .ci/runtime/commands/refresh_hermes_sandbox_pools.sh
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.4.0
precedence: task
derived: false
---

# Johor Sandbox Network

## goal

Add a fail-closed Pulumi network-only stack for dedicated Johor Sandbox capacity, apply it after explicit authorization, and define the first staged Pool without admission or refill.

## non_goals

- Creating TKE, databases, Redis, TCR, CLS, internal CLB, storage, or jumpserver resources.
- Activating/refilling the staged Sandbox Pool or changing CTL admission.
- Reusing the existing Johor LLMGateway support VPC.

## requirement_ids / requirement_refs / requirement_excerpt

- User requirement, 2026-09-17: Johor needs a Singapore-style dedicated VPC with NAT before it can host Sandbox pools.
- User direction, 2026-09-17: preserve the useful Singapore Pulumi experience, then modify Pulumi and preview before any apply.

## interface_refs / data_structure_refs

- `infra_pulumi/pkg/config.Inventory.Profile` and `RuntimeConfig.ComponentScope`.
- `infra_pulumi/pkg/app.selectedSteps`.
- `infra_pulumi/pkg/components/networking.Ensure`.
- `infra_pulumi/pkg/components/securitygroup.EnsureSandbox`.
- Invariant: profile and component scope must both be `sandbox-network`.
- Invariant: scoped `up` never runs TKE/deploy-output sync.

## history_context

- `current_design_refs`: `infra_pulumi/README.md`, `docs/engineering/domains/release-gitops.md`.
- `relevant_evolution`: master already supports scoped notify/pulsar updates and skips deploy sync for explicit scopes.
- `superseded_refs`: copying the full `sgprod` inventory or reusing `llmgateway-sgprod-jhb` is not valid.

## acceptance

- Network-only inventory loads without TKE or platform Secrets.
- Preview contains only provider plus VPC, subnets, primary NAT/EIPs, route/SNAT, and Sandbox SG resources.
- Existing full inventories keep secondary NAT enabled by default.
- Authorized apply converges to 19 managed resources with a subsequent no-change preview.

## affected_paths

- `infra_pulumi/pkg/app/`
- `infra_pulumi/pkg/config/`
- `infra_pulumi/pkg/components/networking/`
- `infra_pulumi/cmd/infractl/`
- `infra_pulumi/envs/tencentcloud/sgprod-johor-sandbox-network/`
- `infra_pulumi/Pulumi.sgprod-johor-sandbox-network.yaml`
- `infra_pulumi/README.md`
- `docs/engineering/domains/release-gitops.md`
- `sandbox/cmd/worker/`
- `.ci/runtime/commands/refresh_hermes_sandbox_pools.sh`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- `docs/agent-guides/sandbox-agent-guide.md`
- `images/README.md`

## required_context

- `release-gitops`
- `service-infra-pulumi`
- `infra_pulumi/AGENTS.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `infra_pulumi/AGENTS.md@3fa42786e` | Pulumi ownership and validation rules | Keep Automation API and inventory authority |
| `infra_pulumi/README.md@3fa42786e` | Current scopes and network model | Reuse scoped-update conventions |
| `docs/engineering/domains/release-gitops.md@3fa42786e` | Formal delivery boundary | Keep preview/apply and infra/workload separate |

## evidence

- Singapore live VPC uses one custom default-NAT route and five effective SNAT EIPs per subnet.
- Singapore secondary NAT has no default route; Johor therefore omits it initially.
- Johor has zones 1 and 2, no existing NAT/EIP, and 20 total EIP quota.
- `SA9.MEDIUM4` is currently available in both Johor zones.
- First apply exposed the provider's default `isMulticast=true`; Johor rejected it after creating the subnets. Explicitly setting `false` and reconciling the recorded resources completed safely.
- Final live verification shows one available NAT with five bound EIPs, three SNAT rules, all three subnets on the managed route table, no Sandbox SG ingress, and broadcast disabled.
- Sandbox API created staged Pool `pool-1789611181051332051-1` with `sku-hermes-2c4g`, `SA9.MEDIUM4`, 50GB system disk, Johor zone 1 network IDs, `paused`, and desired capacity 0.
- Post-create verification shows zero Pool instances, no matching Johor CVM, and the SKU binding remains region-affine to `ap-singapore`.
- An explicitly authorized activation to desired capacity 20 exposed a separate control-plane blocker: the SKU rollout controller replaced Johor image `img-2299bown` with Singapore-only `img-2lu4wxsc`, producing `InvalidImageId.NotFound` before any CVM was created.
- The refill circuit breaker paused the Pool after six failures; failed placeholders were cleaned, Pool instance count returned to zero, and no matching Johor CVM exists.
- Local source fix now treats Pool images as authoritative for a SKU spanning multiple regions, preserves legacy single-region rollout, filters CI Pool refresh by `pool.zone`, and skips one global SKU image update for multi-region Pool sets.

## risks

- Missing scope creates a full platform stack; mitigate with matching profile/scope validation.
- Scoped `up` succeeds then fails on absent TKE outputs; mitigate by resolving scope from stack config before deploy sync.
- NAT/EIP cost is incurred accidentally; preview and explicit `up` approval remain separate gates.

## validation

- `cd infra_pulumi && GOWORK=off go test ./...`
- `cd infra_pulumi && GOWORK=off go build ./...`
- `cd infra_pulumi && GOWORK=off go run ./cmd/infractl preview --stack sgprod-johor-sandbox-network`
- Documentation and change-impact validation.

## decisions

- VPC CIDR is `10.80.0.0/12`; pool subnets are zones 1/2 and support is zone 1.
- Five primary EIPs match Singapore's effective SNAT set.
- Johor starts with one managed NAT and no private ingress path.

## scan_scope

- `infra_pulumi/pkg/app`, `pkg/config`, `pkg/components/networking`, `cmd/infractl`, and the Singapore/Johor inventories.

## scan_output

- Source and live-cloud query summaries are recorded in the task discussion and planning artifacts.

## handoff

- Status: implementation, authorized apply, recovery, and live verification complete.
- Final Pulumi state: 19 managed resources and `19 unchanged` on the post-apply preview.
- Live IDs: VPC `vpc-e8pn0e4z`, NAT `nat-a7l9xf1q`, route table `rtb-ijp3uz94`, Sandbox SG `sg-lu5evfp1`.
- Pool subnets: `subnet-542lxtpi` (zone 1) and `subnet-5rimbo9a` (zone 2); support subnet: `subnet-nc273ivg` (zone 1).
- Staged Pool: `pool-1789611181051332051-1`; currently `paused` by the refill circuit breaker, desired capacity 20, instance count 0, and not admitted outside Singapore.
- Recovery gate: the multi-region Pool-image fix is implemented and locally tested but not yet released; do not resume the Pool until the fixed worker is live, then restore `img-2299bown` and run a one-instance canary.
