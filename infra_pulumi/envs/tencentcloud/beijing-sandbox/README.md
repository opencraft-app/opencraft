# Beijing Sandbox Env

This directory records the non-secret environment facts for the Beijing sandbox.

Current status:

- `infra_pulumi/` is the active infrastructure control plane for Beijing
- the inventory here is the single non-secret source of truth consumed by Pulumi
- the old OpenTofu environment code has been retired from the main path

Use this directory for:

- environment identity and naming
- shared network and service endpoints
- kubeconfig and domain conventions
- stack-level sizing, naming, network and monitoring parameters
- cross-stack references that should not be duplicated in workload manifests
