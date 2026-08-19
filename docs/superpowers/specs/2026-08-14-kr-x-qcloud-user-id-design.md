# KR X-Qcloud User ID Configuration

## Goal

Set the KR sandbox trade environment's `X-Qcloud-User-Id` source value to the
configured shadow account UIN `450860000002` for the next billing integration
test.

## Scope

- Change only `argocd/services/trade/sandbox-kr-1/trade-platform.env`.
- Keep common, JP, and other environment configuration unchanged.
- Do not patch or restart the live Deployment directly.

## Release Flow

1. Render the KR trade overlay and verify the generated `trade-config` value.
2. Commit the source change and push it to `playground/sandbox-kr-1`.
3. Let CI build and create the GitOps release change.
4. Merge the GitOps change before retrying the order flow.

## Verification

The rendered `trade-config` must contain:

```text
JIFEI_CGW_X_QCLOUD_USER_ID: "450860000002"
```

No other environment may gain this value as part of the change.
