# Beijing Sandbox 2 Env

Use this directory as the greenfield template for the second Beijing sandbox.

Guidelines:

- keep `enableImport: false` in the matching Pulumi stack config for a fresh create
- keep `stacks.connectivity` disabled until we explicitly add private control-plane access for this env
- use `__SUPPORT_SUBNET_ID__` and `__TKE_NODE_SECURITY_GROUP_ID__` instead of hardcoding derived IDs
- subnet CIDRs are derived automatically from `network.vpc_cidr`
- deploy runtime facts such as kubeconfig, DB host and Redis host are generated later by `GOWORK=off go run ./cmd/infractl sync --stack beijing-sandbox-2`
- storage bucket name is generated automatically for fresh environments as `lightclawuser-<env_short>-<app_id>`
- this env currently sets `stacks.storage.manage_cam_access: false`, so infra creates the COS bucket/policy but skips CAM user provisioning
- this env now keeps only `1` primary EIP by default; treat extra EIPs as opt-in scale-out rather than a test-env baseline
- jumpserver image defaults to an auto-discovered region-local Ubuntu 24 public image when `compute.jumpserver.image_id` is omitted

Fields that may be omitted for a fresh environment:

- `stacks.networking.primary_nat_public_ips`
- `stacks.networking.secondary_nat_public_ips`
- `stacks.networking.snat_subnets.*.public_ip_addrs`
- `stacks.monitoring.ctl_cls_logs.logset_id`
- `stacks.monitoring.sandbox_cls_logs.logset_id`
