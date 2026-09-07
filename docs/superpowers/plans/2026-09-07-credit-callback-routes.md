# Credit Billing Callback Routes Implementation Plan

**Goal:** Add dedicated regional Credit billing callback routes without changing any existing Pass callback route.

**Architecture:** Define eleven explicit `jifei-credit-callback-{region}` routes in the CloudLadderGateway route configuration. All eleven initially proxy POST requests to the Beijing pre-production endpoint `https://lightclaw.tech`; after validation, `jifei-credit-callback-sh` can be changed independently to `https://api.lightvela.com`.

**Tech Stack:** Go configuration loader, YAML route configuration, Go tests.

## Constraints

- Route regions: `bj`, `sh`, `gz`, `cd`, `nj`, `hk`, `jp`, `kr`, `jkt`, `sg`, `th`.
- Every new route initially uses `https://lightclaw.tech`.
- Existing `jifei-callback-*` Pass routes remain unchanged.
- Only POST is allowed and the forwarded suffix remains `/trade/jifei/callback`.

## Implementation

- [x] Extend `cloudladdergateway/internal/config/config_test.go` with a failing assertion covering all eleven route IDs, base URLs, conditions, and allowed methods.
- [x] Add the eleven routes to `cloudladdergateway/config.example.yaml` following the existing regional callback layout.
- [x] Run the focused configuration test, then `go test ./...` from `cloudladdergateway/`.
- [x] Review the diff and confirm no existing Pass route changed.
