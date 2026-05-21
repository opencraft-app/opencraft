# shprod runtime secrets

Production credentials are sourced from Tencent Cloud SSM and exported to a
SOPS-encrypted Kubernetes Secret artifact. Do not commit plaintext secret
values in this directory.

Expected SSM secret name:

```text
mono-shprod-cloudagent-gateway-runtime-secrets
```

The generated encrypted artifact should be:

```text
gateway/deploy/gitops/secrets/shprod/gateway-runtime-secrets.sops.yaml
```

Required keys:

```text
GATEWAY_AGS_API_KEY
GATEWAY_TOKENHUB_API_KEY
```

Optional keys:

```text
GATEWAY_API_KEY
GATEWAY_TALOS_API_KEY
```

Non-secret deployment parameters such as templates, sidecar URLs, and checksums
belong in `gateway/deploy/k8s/gateway-shprod.yaml` or release-time ConfigMap
substitution, not in this Secret.
