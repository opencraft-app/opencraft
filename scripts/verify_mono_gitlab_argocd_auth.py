#!/usr/bin/env python3
"""
Verify the mono repo GitLab -> ArgoCD auth model for Beijing sandbox and Shanghai production.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.parse import quote_plus
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


@dataclass
class Config:
    gitlab_url: str
    argocd_url: str
    kubeconfig_hk: str
    expected_apps: list[str]
    forbidden_apps: list[str]
    sync_probe_app: str


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout


def verify_discovery(cfg: Config) -> None:
    with urlopen(f"{cfg.gitlab_url}/.well-known/openid-configuration", timeout=20) as resp:
        data = json.loads(resp.read().decode())
    assert data["issuer"] == cfg.gitlab_url
    assert "groups" in data["claims_supported"]
    assert "groups_direct" in data["claims_supported"]
    print("PASS discovery")


def verify_projects(cfg: Config) -> None:
    bj = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "appprojects.argoproj.io", "beijing-sandbox", "-o", "json"]))
    sh = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "appprojects.argoproj.io", "shprod", "-o", "json"]))
    bj_root = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "appprojects.argoproj.io", "beijing-root", "-o", "json"]))
    sh_root = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "appprojects.argoproj.io", "shprod-root", "-o", "json"]))
    root_bj = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "applications.argoproj.io", "root-beijing-sandbox", "-o", "json"]))
    root_sh = json.loads(run(["kubectl", f"--kubeconfig={cfg.kubeconfig_hk}", "-n", "argocd", "get", "applications.argoproj.io", "root-shprod", "-o", "json"]))

    bj_roles = {r["name"] for r in bj["spec"]["roles"]}
    sh_roles = {r["name"] for r in sh["spec"]["roles"]}
    assert {"mono-observe", "mono-logs", "mono-sync"} <= bj_roles
    assert {"mono-observe", "mono-logs", "mono-sync"} <= sh_roles
    assert bj_root["spec"]["destinations"][0]["namespace"] == "argocd"
    assert sh_root["spec"]["destinations"][0]["namespace"] == "argocd"
    assert root_bj["spec"]["project"] == "beijing-root"
    assert root_sh["spec"]["project"] == "shprod-root"
    print("PASS projects")


def verify_sso_scope(cfg: Config, username: str | None, password: str | None) -> None:
    if not username or not password:
        print("SKIP sso-scope (missing GitLab credentials)")
        return

    jar = CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar))
    signin_html = opener.open(f"{cfg.gitlab_url}/users/sign_in", timeout=20).read().decode()
    token_match = re.search(r'name=\"authenticity_token\" value=\"([^\"]+)\"', signin_html)
    if not token_match:
        raise RuntimeError("failed to locate GitLab authenticity_token")

    payload = (
        f"authenticity_token={quote_plus(token_match.group(1))}"
        f"&user%5Blogin%5D={quote_plus(username)}"
        f"&user%5Bpassword%5D={quote_plus(password)}"
        "&user%5Bremember_me%5D=0"
    ).encode()
    opener.open(
        Request(
            f"{cfg.gitlab_url}/users/sign_in",
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": f"{cfg.gitlab_url}/users/sign_in"},
            method="POST",
        ),
        timeout=20,
    )

    login_resp = opener.open(f"{cfg.argocd_url}/auth/login", timeout=20)
    final_url = login_resp.geturl()
    login_html = login_resp.read().decode()

    token = None
    for cookie in jar:
        if cookie.name == "argocd.token":
            token = cookie.value
            break
    if not token:
        callback_url = final_url if final_url.startswith(f"{cfg.argocd_url}/auth/callback") else None
        if not callback_url:
            match = re.search(rf"{re.escape(cfg.argocd_url)}/auth/callback\\?[^\"<]+", login_html)
            if match:
                import html
                callback_url = html.unescape(match.group(0))
        if not callback_url:
            raise RuntimeError("failed to locate Argo callback URL")
        opener.open(callback_url, timeout=20)
        for cookie in jar:
            if cookie.name == "argocd.token":
                token = cookie.value
                break
    if not token:
        raise RuntimeError("missing argocd.token cookie after callback")

    def authed(url: str, method: str = "GET", body: bytes | None = None) -> tuple[int, str]:
        req = Request(url, headers={"Authorization": f"Bearer {token}"}, data=body, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with opener.open(req, timeout=20) as resp:
                return resp.status, resp.read().decode()
        except HTTPError as exc:
            return exc.code, exc.read().decode()

    status, body = authed(f"{cfg.argocd_url}/api/v1/applications")
    if status != 200:
        raise RuntimeError(f"applications list failed: {status} {body}")
    data = json.loads(body)
    visible = [item["metadata"]["name"] for item in data.get("items", [])]
    for expected in cfg.expected_apps:
        assert expected in visible, (expected, visible)
    for forbidden in cfg.forbidden_apps:
        assert forbidden not in visible, (forbidden, visible)

    for forbidden in cfg.forbidden_apps:
        status, _ = authed(f"{cfg.argocd_url}/api/v1/applications/{forbidden}")
        assert status == 403, (forbidden, status)

    sync_target = cfg.sync_probe_app
    status, body = authed(
        f"{cfg.argocd_url}/api/v1/applications/{sync_target}/sync",
        method="POST",
        body=b'{"revision":"main","prune":false}',
    )
    assert status == 200, (status, body)

    print("PASS sso-scope")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--gitlab-url", default="https://code.lightclaw.tech")
    p.add_argument("--argocd-url", default="https://argocd.lightclaw.tech")
    p.add_argument("--kubeconfig-hk", default="/Users/skipzhang/code/mono/hk-cls-mp5b5r0y-extranet.kubeconfig")
    p.add_argument("--gitlab-username", default=os.getenv("GITLAB_USERNAME"))
    p.add_argument("--gitlab-password", default=os.getenv("GITLAB_PASSWORD"))
    return p.parse_args()


def main() -> int:
    args = parse_args()
    cfg = Config(
        gitlab_url=args.gitlab_url,
        argocd_url=args.argocd_url,
        kubeconfig_hk=args.kubeconfig_hk,
        expected_apps=["service-gateway-beijing-sandbox", "service-gateway-shprod"],
        forbidden_apps=["root-beijing-sandbox", "root-shprod"],
        sync_probe_app="service-gateway-beijing-sandbox",
    )
    verify_discovery(cfg)
    verify_projects(cfg)
    verify_sso_scope(cfg, args.gitlab_username, args.gitlab_password)
    print("PASS overall")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
