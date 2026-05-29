# shprod runtime secrets

Production credentials are sourced from Tencent Cloud SSM and exported to a
SOPS-encrypted Kubernetes Secret artifact. Do not commit plaintext secret
values in this directory.

Expected SSM secret names:

```text
mono-shprod-cloudagent-wsa-search-secrets
```

The generated encrypted artifact should be:

```text
gateway/deploy/gitops/secrets/shprod/cloudagent-wsa-search-secrets.sops.yaml
```

Required keys:

```text
GATEWAY_AGS_API_KEY
GATEWAY_TOKENHUB_API_KEY
```

Search provider keys:

```text
TENCENTCLOUD_WSA_APIKEY
```

`TENCENTCLOUD_WSA_APIKEY` is intentionally sourced from a separate SSM secret
and Kubernetes Secret (`cloudagent-wsa-search-secrets`) so search-provider
credentials cannot overwrite the core gateway runtime credentials.

Optional keys:

```text
GATEWAY_API_KEY
GATEWAY_TALOS_API_KEY
```

Non-secret deployment parameters such as templates, sidecar URLs, and checksums
belong in `gateway/deploy/k8s/gateway-shprod.yaml` or release-time ConfigMap
substitution, not in this Secret.
