# Referral Beijing sandbox

This directory is intentionally not listed in the Beijing Argo catalog until
the independent MySQL database/user and `referral-runtime-secrets` SSM/SOPS
payload exist. Cataloging it earlier would publish an enabled API and worker
without usable Pulsar role tokens.

Activation order is documented in
`docs/engineering/domains/release-gitops.md#referral-北京试点交付`.
