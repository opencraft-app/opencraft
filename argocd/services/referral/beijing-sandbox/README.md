# Referral Beijing sandbox

This directory is listed in the Beijing Argo catalog after the independent
MySQL database/user and `referral-runtime-secrets` SSM/SOPS payload exist. The
first rollout keeps `REFERRAL_PROCESSING_ENABLED=false`; event production,
worker consumption, gateway routes, and the frontend entry are enabled only
after the API, schema, and campaign bootstrap are healthy.

Activation order is documented in
`docs/engineering/domains/release-gitops.md#referral-北京试点交付`.
