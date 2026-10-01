#!/usr/bin/env python3
import argparse
import http.cookiejar
import json
import re
import sys
import urllib.error
import urllib.request
import uuid


BASE_URL = "http://127.0.0.1:3080"
CN_PROVIDERS = (
    "deepseek",
    "minimax-cn",
    "moonshotai-cn",
    "qwen-token-plan-cn",
    "openrouter",
)
GLOBAL_PROVIDERS = (
    "deepseek",
    "minimax",
    "minimax-cn",
    "moonshotai",
    "moonshotai-cn",
    "openrouter",
    "anthropic",
    "groq",
    "openai",
)
ALL_PROVIDERS = frozenset((*CN_PROVIDERS, *GLOBAL_PROVIDERS))


def provider_route(provider):
    return "deepseek-official" if provider == "deepseek" else provider


def derive_credential_ref(provider):
    return re.sub(r"[^A-Z0-9]+", "_", provider.upper()) + "_API_KEY"


def get_path(value, path):
    current = value
    for segment in path:
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current


def credential_ref(namespace, path, fallback):
    profile = get_path(namespace.get("value"), path) if namespace else None
    if isinstance(profile, dict) and isinstance(profile.get("apiKeyEnv"), str) and profile["apiKeyEnv"]:
        return profile["apiKeyEnv"]
    return fallback


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never follow a redirect while carrying a credential mutation payload.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RpcClient:
    """Process-local auth and read-only protocol negotiation for DSH 0.1/0.2."""

    def __init__(self, base_url=BASE_URL):
        self.base_url = base_url
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies),
        )
        self.protocol = None

    def bootstrap(self):
        # The managed installer admits this loopback root probe and issues the
        # native signed cookie. Keep it in memory, never persist/print it.
        with self.opener.open(f"{self.base_url}/", timeout=10) as response:
            response.read(1024)
        if not any(cookie.name.startswith("dsh-") for cookie in self.cookies):
            raise RuntimeError("DSH authentication bootstrap failed; repair the managed DSH installation")

    def request(self, method, payload):
        rpc_id = f"lightvela-dsh-{uuid.uuid4().hex}"
        body = json.dumps({
            "type": "client-request", "rpcId": rpc_id,
            "method": method, "payload": payload,
        }, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/api/{method}", data=body, method="POST",
            headers={"Accept": "application/json", "Content-Type": "application/json", "Origin": self.base_url},
        )
        for attempt in range(2):
            try:
                with self.opener.open(request, timeout=20) as response:
                    envelope = json.load(response)
                break
            except urllib.error.HTTPError as error:
                error.close()
                if error.code != 401 or attempt != 0:
                    raise
                self.cookies.clear()
                self.bootstrap()
        if not isinstance(envelope, dict) or envelope.get("type") != "server-response" or envelope.get("rpcId") != rpc_id:
            raise RuntimeError(f"invalid DSH RPC response for {method}")
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"missing DSH RPC result for {method}")
        if result.get("ok") is not True:
            error = result.get("error") if isinstance(result.get("error"), dict) else {}
            # Do not expose server messages that can contain mutation inputs.
            raise RuntimeError(f"DSH RPC {method} rejected ({error.get('code') or 'unknown error'})")
        return result.get("value")

    def modern_providers(self):
        directory = self.request("llm/listConfigurableProviders", {"args": {}})
        running = self.request("llm/listProviders", {"args": {}})
        if not isinstance(directory, list) or not isinstance(running, list):
            raise RuntimeError("invalid DSH provider directory response")
        active = {entry.get("id") for entry in running if isinstance(entry, dict)}
        return {"providers": [{**entry, "active": entry.get("provider") in active}
                              for entry in directory if isinstance(entry, dict)]}

    def call(self, method, payload):
        try:
            if self.protocol is None:
                # Negotiate using a read ONLY. Never try another protocol after
                # a credential/settings write: ambiguous writes must not replay.
                try:
                    providers = self.request("llm.providers", {})
                    self.protocol = "legacy"
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    providers = self.modern_providers()
                    self.protocol = "modern"
                if method == "llm.providers":
                    return providers
            if self.protocol == "legacy":
                return self.request(method, payload)
            if method == "llm.providers":
                return self.modern_providers()
            endpoints = {
                "settings.describe": "settings/describe",
                "settings.mutate": "settings/mutate",
                "credentials.describe": "credentials/describe",
                "credentials.set": "credentials/set",
                "credentials.unset": "credentials/unset",
            }
            if method not in endpoints:
                raise RuntimeError("unsupported DSH management method")
            value = self.request(endpoints[method], {"args": payload})
            return {"credentials": value} if method == "credentials.describe" else value
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"DSH RPC {method} failed (HTTP {error.code})") from None
        except urllib.error.URLError:
            raise RuntimeError("DSH local API is unavailable; check the DSH service") from None


_RPC_CLIENT = None


def rpc_call(method, payload):
    global _RPC_CLIENT
    if _RPC_CLIENT is None:
        _RPC_CLIENT = RpcClient()
    return _RPC_CLIENT.call(method, payload)


def describe_configuration(rpc):
    provider_value = rpc("llm.providers", {})
    settings = rpc("settings.describe", {})
    return provider_value.get("providers", []), settings


def list_providers(region, rpc=rpc_call):
    if region not in {"cn", "global"}:
        raise ValueError("unsupported region")
    providers, settings = describe_configuration(rpc)
    entries = {entry.get("provider"): entry for entry in providers}
    namespaces = {entry.get("ns"): entry for entry in settings.get("namespaces", [])}
    selected = []
    refs = []
    for provider in CN_PROVIDERS if region == "cn" else GLOBAL_PROVIDERS:
        entry = entries.get(provider_route(provider))
        if not entry:
            continue
        namespace = namespaces.get(entry.get("settingsNs"))
        path = entry.get("settingsPath") or []
        fallback = "DEEPSEEK_API_KEY" if provider == "deepseek" else derive_credential_ref(entry["provider"])
        selected.append((provider, entry))
        refs.append(credential_ref(namespace, path, fallback))

    credential_value = rpc("credentials.describe", {"refs": list(dict.fromkeys(refs))}) if refs else {"credentials": {}}
    credentials = credential_value.get("credentials", {})
    result = []
    for (provider, entry), ref in zip(selected, refs):
        info = credentials.get(ref, {})
        namespace = namespaces.get(entry.get("settingsNs"))
        profile = get_path(namespace.get("value"), entry.get("settingsPath") or []) if namespace else None
        result.append({
            "id": provider,
            "displayName": entry.get("displayName") or provider,
            "configured": info.get("configured") is True and (
                provider == "deepseek" or isinstance(profile, dict)
            ),
            "active": entry.get("active") is True,
            "writable": settings.get("writable") is True and info.get("writable") is not False,
        })
    return {"providers": result}


def configure_provider(provider, api_key, rpc=rpc_call):
    if provider not in ALL_PROVIDERS:
        raise ValueError("unsupported provider")
    value = api_key.strip()
    if not value:
        raise ValueError("API key is required")

    providers, settings = describe_configuration(rpc)
    if settings.get("writable") is not True:
        raise RuntimeError("DeepSeek Harness settings are read-only")
    route = provider_route(provider)
    entry = next((item for item in providers if item.get("provider") == route), None)
    if not entry:
        raise RuntimeError(f"provider {provider} is unavailable")
    namespace = next(
        (item for item in settings.get("namespaces", []) if item.get("ns") == entry.get("settingsNs")),
        None,
    )
    path = entry.get("settingsPath") or []
    fallback = "DEEPSEEK_API_KEY" if provider == "deepseek" else derive_credential_ref(route)
    ref = credential_ref(namespace, path, fallback)
    profile = get_path(namespace.get("value"), path) if namespace else None
    has_ref = isinstance(profile, dict) and isinstance(profile.get("apiKeyEnv"), str) and bool(profile["apiKeyEnv"])

    if provider != "deepseek" and not has_ref:
        if not namespace:
            raise RuntimeError(f"settings namespace {entry.get('settingsNs')} is unavailable")
        rpc("settings.mutate", {
            "ns": entry["settingsNs"],
            "ops": [{"op": "set", "path": [*path, "apiKeyEnv"], "value": ref}],
            "expectedRevision": namespace["revision"],
        })
    rpc("credentials.set", {"ref": ref, "value": value})
    return {"ok": True, "provider": provider, "configured": True}


def remove_provider(provider, rpc=rpc_call):
    if provider not in ALL_PROVIDERS:
        raise ValueError("unsupported provider")

    providers, settings = describe_configuration(rpc)
    route = provider_route(provider)
    entry = next((item for item in providers if item.get("provider") == route), None)
    if not entry:
        raise RuntimeError(f"provider {provider} is unavailable")

    namespace = next(
        (item for item in settings.get("namespaces", []) if item.get("ns") == entry.get("settingsNs")),
        None,
    )
    path = entry.get("settingsPath") or []
    profile = get_path(namespace.get("value"), path) if namespace else None

    if provider == "deepseek":
        ref = "DEEPSEEK_API_KEY"
        credential_value = rpc("credentials.describe", {"refs": [ref]})
        info = credential_value.get("credentials", {}).get(ref, {})
        if info.get("configured") is not True:
            return {"ok": True, "provider": provider, "configured": False}
        if info.get("writable") is not True:
            raise RuntimeError(
                "DeepSeek credential is managed by the runtime environment and cannot be removed here"
            )
        rpc("credentials.unset", {"ref": ref})
        return {"ok": True, "provider": provider, "configured": False}

    if not isinstance(profile, dict):
        return {"ok": True, "provider": provider, "configured": False}
    if settings.get("writable") is not True:
        raise RuntimeError("DeepSeek Harness settings are read-only")
    if not namespace or not path:
        raise RuntimeError(f"settings namespace {entry.get('settingsNs')} is unavailable")

    ref = profile.get("apiKeyEnv")
    derived_ref = derive_credential_ref(route)
    if ref == derived_ref:
        credential_value = rpc("credentials.describe", {"refs": [ref]})
        info = credential_value.get("credentials", {}).get(ref, {})
        if info.get("configured") is True and info.get("writable") is True:
            rpc("credentials.unset", {"ref": ref})

    rpc("settings.mutate", {
        "ns": entry["settingsNs"],
        "ops": [{"op": "unset", "path": path}],
        "expectedRevision": namespace["revision"],
    })
    return {"ok": True, "provider": provider, "configured": False}


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    providers_parser = subparsers.add_parser("providers")
    providers_parser.add_argument("--region", choices=("cn", "global"), required=True)
    configure_parser = subparsers.add_parser("configure")
    configure_parser.add_argument("--provider", choices=sorted(ALL_PROVIDERS), required=True)
    remove_parser = subparsers.add_parser("remove-provider")
    remove_parser.add_argument("--provider", choices=sorted(ALL_PROVIDERS), required=True)
    args = parser.parse_args()

    if args.action == "providers":
        result = list_providers(args.region)
    elif args.action == "configure":
        api_key = sys.stdin.read(65537)
        if len(api_key) > 65536:
            raise ValueError("API key is too long")
        result = configure_provider(args.provider, api_key)
    else:
        result = remove_provider(args.provider)
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
