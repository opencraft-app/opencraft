# Singapore Production Secrets

`sgprod` secret files are generated from Tencent Cloud SSM and encrypted with SOPS.

Regenerate a file after updating its SSM entry:

```bash
python3 scripts/export_ssm_to_sops.py --manifest scripts/ssm_manifest.<service>.sgprod.yaml
python3 scripts/scan_secrets.py argocd/secrets/sgprod/<secret>.sops.yaml
```

Do not edit decrypted values in Git. Update SSM first, then export a new SOPS artifact.

OAuth provider app secrets that are not provisioned in SSM remain empty and keep the provider disabled until real values are added.
