# Referral Singapore activation

This directory deploys the region-local Singapore Referral campaign:

- Referral API replicas: 2
- Referral worker replicas: 2
- `REFERRAL_ENABLED=true`
- `REFERRAL_PROCESSING_ENABLED=true`
- campaign bootstrap runs as an Argo PostSync hook

The environment uses its own Singapore Pulsar cluster, CynosDB database/user,
campaign, and SSM/SOPS material. It does not reuse Beijing or Shanghai runtime
credentials or campaign identity.
