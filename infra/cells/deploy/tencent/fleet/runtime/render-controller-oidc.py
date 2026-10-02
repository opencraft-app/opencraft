#!/usr/bin/env python3
import argparse
from pathlib import Path


MARKERS = {
    "      __TKE_OIDC_VOLUMES__: null\n": "",
    "            - __TKE_OIDC_ENV__: null\n": "",
    "          __TKE_OIDC_VOLUME_MOUNTS__: null\n": "",
}


def render(path, enabled, role_arn, provider_id):
    text = path.read_text()
    replacements = dict(MARKERS)
    if enabled:
        replacements["      __TKE_OIDC_VOLUMES__: null\n"] = (
            "      volumes:\n"
            "        - name: tke-oidc-token\n"
            "          projected:\n"
            "            sources:\n"
            "              - serviceAccountToken:\n"
            "                  audience: sts.cloud.tencent.com\n"
            "                  expirationSeconds: 3600\n"
            "                  path: token\n"
        )
        replacements["            - __TKE_OIDC_ENV__: null\n"] = (
            "            - name: TKE_ROLE_ARN\n"
            "              value: {}\n".format(role_arn)
            +
            "            - name: TKE_PROVIDER_ID\n"
            "              value: {}\n".format(provider_id)
            +
            "            - name: TKE_WEB_IDENTITY_TOKEN_FILE\n"
            "              value: /var/run/secrets/cloud.tencent.com/serviceaccount/token\n"
        )
        replacements["          __TKE_OIDC_VOLUME_MOUNTS__: null\n"] = (
            "          volumeMounts:\n"
            "            - name: tke-oidc-token\n"
            "              mountPath: /var/run/secrets/cloud.tencent.com/serviceaccount\n"
            "              readOnly: true\n"
        )
    for marker, replacement in replacements.items():
        if text.count(marker) != 1:
            raise SystemExit("runtime capacity OIDC marker mismatch: {}".format(marker.strip()))
        text = text.replace(marker, replacement)
    path.write_text(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--enabled", choices=("true", "false"), required=True)
    parser.add_argument("--role-arn", required=True)
    parser.add_argument("--provider-id", required=True)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    render(args.manifest, args.enabled == "true", args.role_arn, args.provider_id)


if __name__ == "__main__":
    main()
