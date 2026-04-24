# Shanghai Sandbox Env

Use this directory as the greenfield mirror template for a new Shanghai deployment.

Guidelines:

- start from `inventory.example.yaml`
- keep `enableImport: false` in the matching Pulumi stack config for a fresh create
- replace all Tencent Cloud IDs, zones and image IDs with Shanghai values
- do not copy Beijing public NAT IPs or CLS logset IDs into Shanghai
- use `__TKE_NODE_SECURITY_GROUP_ID__` for any reference that should point at the TKE node SG
- subnet CIDRs are derived automatically from `network.vpc_cidr`
- if `network.vpc_cidr` is omitted, it defaults to the shared Claw VPC range `10.0.0.0/12`
- deploy runtime facts such as kubeconfig, DB host and Redis host are generated later by `GOWORK=off go run ./cmd/infractl sync --stack <env>`
- storage bucket name is generated automatically for fresh environments as `lightclawuser-<env_short>-<app_id>`
- jumpserver image defaults to an auto-discovered region-local Ubuntu 24 public image when `compute.jumpserver.image_id` is omitted
- current default Shanghai spread uses three AZs for pool subnets:
  - `pool-a`, `pool-d` -> `ap-shanghai-2`
  - `pool-b`, `pool-e` -> `ap-shanghai-4`
  - `pool-c`, `pool-f` -> `ap-shanghai-5`
  - `support` stays in the primary AZ

Fields that may be omitted for a fresh environment:

- `stacks.networking.primary_nat_public_ips`
- `stacks.networking.secondary_nat_public_ips`
- `stacks.networking.snat_subnets.*.public_ip_addrs`
- `stacks.monitoring.ctl_cls_logs.logset_id`
- `stacks.monitoring.sandbox_cls_logs.logset_id`
