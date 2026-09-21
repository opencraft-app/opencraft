#!/usr/bin/env python3
"""Inject personal-localstack runtime values into rendered ConfigMaps."""

from __future__ import annotations

import argparse
import json
import re
import sys


CONFIG_MAPS = {
    "auth": (
        "lightclaw-auth-config",
        {
            "LIGHTVELA_SITE_KIND": "site",
            "LIGHTCLAW_FRONTEND_BASE_URL": "frontend_url",
            "LIGHTCLAW_OAUTH_RETURN_TO_ALLOWED_HOSTS": "allowed_hosts",
            "LIGHTCLAW_PUBLIC_BASE_URL": "gateway_url",
            "LIGHTCLAW_QQ_REDIRECT_URI": "qq_redirect_uri",
            "LIGHTCLAW_QQ_AUTHORIZE_URL": "qq_authorize_url",
            "LIGHTCLAW_WECHAT_REDIRECT_URI": "wechat_redirect_uri",
            "LIGHTVELA_WECHAT_WEBSITE_REDIRECT_URI": "wechat_redirect_uri",
            "LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI": "wechat_redirect_uri",
            "LIGHTCLAW_GITHUB_REDIRECT_URI": "github_redirect_uri",
            "SHADOW_BINDING_ENABLED": "shadow_binding_enabled",
            "LIGHTCLAW_PASSWORD_SIGNUP_SHADOW_PROVISIONING_ENABLED": "password_shadow_provisioning_enabled",
            "SHADOW_PLATFORM": "shadow_platform",
        },
    ),
    "trade": (
        "trade-config",
        {
            "LIGHTVELA_SITE_KIND": "site",
            "LIGHTVELA_TRADE_REGION": "trade_region",
            "JIFEI_CGW_GATEWAY_URL": "jifei_gateway",
            "JIFEI_CGW_X_QCLOUD_USER_ID": "jifei_user_id",
            "TRADE_SHADOW_MOCK_ENABLED": "trade_shadow_mock_enabled",
        },
    ),
    "ctl": (
        "ctl-platform-values",
        {"LIGHTVELA_SITE_KIND": "site"},
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", choices=CONFIG_MAPS, required=True)
    parser.add_argument("--site", choices=("cn", "intl"), required=True)
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--frontend-url", required=True)
    parser.add_argument("--gateway-url", required=True)
    parser.add_argument("--fake-qq-url", required=True)
    parser.add_argument("--jifei-gateway", required=True)
    parser.add_argument("--jifei-user-id", required=True)
    parser.add_argument("--trade-region", required=True)
    parser.add_argument("--shadow-platform", required=True)
    return parser.parse_args()


def runtime_values(args: argparse.Namespace) -> dict[str, str]:
    values = vars(args).copy()
    values.update(
        allowed_hosts=(
            f"{args.public_host},localhost,127.0.0.1,{args.frontend_url},"
            "http://localhost:5173,http://127.0.0.1:5173"
        ),
        qq_redirect_uri=f"{args.gateway_url}/auth/oauth/qq/callback",
        qq_authorize_url=f"{args.fake_qq_url}/oauth2.0/authorize",
        wechat_redirect_uri=f"{args.gateway_url}/auth/oauth/wechat/callback",
        github_redirect_uri=f"{args.gateway_url}/auth/oauth/github/callback",
        shadow_binding_enabled="true",
        password_shadow_provisioning_enabled="false",
        trade_shadow_mock_enabled="false",
    )
    for key, value in values.items():
        if isinstance(value, str) and ("\n" in value or "\r" in value):
            raise SystemExit(f"runtime value {key} contains a newline")
    return values


def transform_document(
    document: str, config_map_name: str, field_map: dict[str, str], values: dict[str, str]
) -> tuple[str, bool]:
    if not re.search(r"(?m)^kind: ConfigMap\s*$", document):
        return document, False
    if not re.search(rf"(?m)^  name: {re.escape(config_map_name)}\s*$", document):
        return document, False

    missing_lines: list[str] = []
    for yaml_key, value_key in field_map.items():
        pattern = rf"(?m)^  {re.escape(yaml_key)}: .*$"
        replacement = f"  {yaml_key}: {json.dumps(values[value_key], ensure_ascii=False)}"
        document, count = re.subn(pattern, lambda _: replacement, document)
        if count == 0:
            missing_lines.append(replacement)
        elif count != 1:
            raise SystemExit(
                f"expected one {yaml_key} field in ConfigMap/{config_map_name}, found {count}"
            )
    if missing_lines:
        document, count = re.subn(
            r"(?m)^data:\s*$",
            lambda _: "data:\n" + "\n".join(missing_lines),
            document,
            count=1,
        )
        if count != 1:
            raise SystemExit(f"ConfigMap/{config_map_name} has no unique data mapping")
    return document, True


def main() -> None:
    args = parse_args()
    config_map_name, field_map = CONFIG_MAPS[args.component]
    values = runtime_values(args)
    pieces = re.split(r"(?m)(^---\s*$)", sys.stdin.read())
    matched = 0
    for index in range(0, len(pieces), 2):
        pieces[index], changed = transform_document(
            pieces[index], config_map_name, field_map, values
        )
        matched += int(changed)
    if matched != 1:
        raise SystemExit(f"expected one ConfigMap/{config_map_name}, found {matched}")
    sys.stdout.write("".join(pieces))


if __name__ == "__main__":
    main()
