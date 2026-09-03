#!/usr/bin/env python3
"""Load the pinned CC Switch GLM5.3 provider without persisting its API key."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tomllib
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit


EXPECTED_PROVIDER_ID = "ccf642d4-1927-4769-a8f7-e2882c488455"
EXPECTED_PROVIDER_NAME = "腾讯云Token Plan 企业版 GLM5.3"
EXPECTED_MODEL = "glm-5.3"
EXPECTED_REASONING_EFFORT = "high"
EXPECTED_WIRE_API = "responses"
API_KEY_ENV = "OPENAI_API_KEY"


class ProviderSpec:
    def __init__(
        self,
        *,
        provider_id: str,
        name: str,
        model: str,
        reasoning_effort: str,
        wire_api: str,
        base_url: str,
        api_key_env: str,
        api_key: str,
        model_catalog: Any,
    ) -> None:
        self.provider_id = provider_id
        self.name = name
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.wire_api = wire_api
        self.base_url = base_url
        self.api_key_env = api_key_env
        self.api_key = api_key
        self.model_catalog = model_catalog

    def redacted_summary(self) -> dict[str, Any]:
        endpoint = urlsplit(self.base_url)
        return {
            "provider_id": self.provider_id,
            "name": self.name,
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
            "wire_api": self.wire_api,
            "endpoint_host": endpoint.hostname,
            "api_key_env": self.api_key_env,
            "api_key_present": bool(self.api_key),
        }


def _provider_error(message: str) -> ValueError:
    return ValueError(f"GLM5.3 provider contract violation: {message}")


def _load_settings(database_path: Path, provider_id: str) -> tuple[str, dict[str, Any]]:
    if provider_id != EXPECTED_PROVIDER_ID:
        raise _provider_error(f"provider id must be {EXPECTED_PROVIDER_ID}")
    if not database_path.is_file():
        raise FileNotFoundError(database_path)
    uri = f"{database_path.resolve().as_uri()}?mode=ro"
    database = sqlite3.connect(uri, uri=True)
    try:
        rows = database.execute(
            "SELECT name, settings_config FROM providers WHERE id = ? AND app_type = 'codex'",
            (provider_id,),
        ).fetchall()
    finally:
        database.close()
    if len(rows) != 1:
        raise _provider_error(f"expected one Codex provider row, found {len(rows)}")
    name, raw_settings = rows[0]
    try:
        settings = json.loads(raw_settings)
    except (TypeError, json.JSONDecodeError) as exc:
        raise _provider_error("settings_config must be valid JSON") from exc
    if not isinstance(settings, dict):
        raise _provider_error("settings_config must contain an object")
    return str(name), settings


def _load_model_catalog(
    config: dict[str, Any],
    settings: dict[str, Any],
    model: str,
    catalog_root: Path,
) -> dict[str, Any]:
    raw_catalog_path = config.get("model_catalog_json")
    if not isinstance(raw_catalog_path, str) or not raw_catalog_path:
        raise _provider_error("config must reference model_catalog_json")
    relative_catalog_path = Path(raw_catalog_path)
    if relative_catalog_path.is_absolute() or relative_catalog_path.name != raw_catalog_path:
        raise _provider_error("model_catalog_json must be a file name inside the Codex home")

    resolved_root = catalog_root.resolve()
    catalog_path = (resolved_root / relative_catalog_path).resolve()
    if catalog_path.parent != resolved_root:
        raise _provider_error("referenced model catalog is outside the Codex home")
    if catalog_path.is_file():
        try:
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            catalog = None
        models = catalog.get("models") if isinstance(catalog, dict) else None
        if isinstance(models, list):
            matching = [item for item in models if isinstance(item, dict) and item.get("slug") == model]
            if len(matching) == 1:
                return {"models": [matching[0]]}

    raw_provider_catalog = settings.get("modelCatalog")
    provider_models = raw_provider_catalog.get("models") if isinstance(raw_provider_catalog, dict) else None
    matching_provider_models = [
        item
        for item in provider_models if isinstance(item, dict) and item.get("model") == model
    ] if isinstance(provider_models, list) else []
    if len(matching_provider_models) != 1:
        raise _provider_error(
            f"active and pinned provider catalogs must contain exactly one {model!r} entry"
        )

    legacy_model = matching_provider_models[0]
    display_name = legacy_model.get("displayName")
    context_window = legacy_model.get("contextWindow")
    if not isinstance(display_name, str) or not display_name:
        raise _provider_error("pinned provider catalog entry must contain displayName")
    if not isinstance(context_window, int) or context_window <= 0:
        raise _provider_error("pinned provider catalog entry must contain a positive contextWindow")
    return {
        "models": [
            {
                "slug": model,
                "display_name": display_name,
                "description": None,
                "default_reasoning_level": EXPECTED_REASONING_EFFORT,
                "supported_reasoning_levels": [
                    {"effort": EXPECTED_REASONING_EFFORT, "description": EXPECTED_REASONING_EFFORT}
                ],
                "shell_type": "shell_command",
                "visibility": "list",
                "supported_in_api": True,
                "priority": 1000,
                "availability_nux": None,
                "upgrade": None,
                "base_instructions": "You are Codex, a coding agent.",
                "supports_reasoning_summaries": False,
                "support_verbosity": False,
                "default_verbosity": None,
                "apply_patch_tool_type": None,
                "truncation_policy": {"mode": "tokens", "limit": 10_000},
                "supports_parallel_tool_calls": True,
                "supports_image_detail_original": False,
                "context_window": context_window,
                "max_context_window": context_window,
                "experimental_supported_tools": [],
                "input_modalities": ["text"],
                "supports_search_tool": False,
            }
        ]
    }


def load_provider(
    database_path: Path,
    provider_id: str,
    *,
    catalog_root: Path | None = None,
) -> ProviderSpec:
    """Read and validate the pinned CC Switch provider in SQLite read-only mode."""
    name, settings = _load_settings(database_path, provider_id)
    if name != EXPECTED_PROVIDER_NAME:
        raise _provider_error(f"unexpected provider name {name!r}")

    raw_config = settings.get("config")
    if not isinstance(raw_config, str):
        raise _provider_error("config must be TOML text")
    try:
        config = tomllib.loads(raw_config)
    except tomllib.TOMLDecodeError as exc:
        raise _provider_error("config must be valid TOML") from exc

    model = config.get("model")
    reasoning_effort = config.get("model_reasoning_effort")
    provider_name = config.get("model_provider")
    provider_config = config.get("model_providers", {}).get(provider_name, {})
    if not isinstance(provider_config, dict):
        raise _provider_error("selected model provider table is missing")
    wire_api = provider_config.get("wire_api")
    base_url = provider_config.get("base_url")
    requires_openai_auth = provider_config.get("requires_openai_auth")
    api_format = settings.get("apiFormat")
    if (
        model != EXPECTED_MODEL
        or reasoning_effort != EXPECTED_REASONING_EFFORT
        or wire_api != EXPECTED_WIRE_API
        or requires_openai_auth is not True
        or (api_format not in (None, "", EXPECTED_WIRE_API))
    ):
        raise _provider_error(
            "expected model=glm-5.3, reasoning=high, wire_api=responses, requires_openai_auth=true"
        )
    if not isinstance(base_url, str):
        raise _provider_error("base_url must be a string")
    endpoint = urlsplit(base_url)
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
        raise _provider_error("base_url must be an absolute HTTP(S) URL")
    if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise _provider_error("base_url must not embed credentials, query parameters, or fragments")

    auth = settings.get("auth")
    api_key = auth.get(API_KEY_ENV) if isinstance(auth, dict) else None
    if not isinstance(api_key, str) or not api_key:
        raise _provider_error(f"auth must contain non-empty {API_KEY_ENV}")
    if api_key in raw_config:
        raise _provider_error("API key must not be embedded in config TOML")

    model_catalog = _load_model_catalog(
        config,
        settings,
        model,
        catalog_root or Path.home() / ".codex",
    )

    return ProviderSpec(
        provider_id=provider_id,
        name=name,
        model=model,
        reasoning_effort=reasoning_effort,
        wire_api=wire_api,
        base_url=base_url,
        api_key_env=API_KEY_ENV,
        api_key=api_key,
        model_catalog=model_catalog,
    )


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _isolated_config(provider: ProviderSpec, model_catalog_path: Path) -> str:
    return "\n".join(
        [
            'model_provider = "ccswitch_glm53"',
            f"model = {_toml_string(provider.model)}",
            f"model_reasoning_effort = {_toml_string(provider.reasoning_effort)}",
            "disable_response_storage = true",
            f"model_catalog_json = {_toml_string(str(model_catalog_path))}",
            "",
            "[model_providers.ccswitch_glm53]",
            f"name = {_toml_string(provider.name)}",
            f"wire_api = {_toml_string(provider.wire_api)}",
            f"env_key = {_toml_string(provider.api_key_env)}",
            "requires_openai_auth = false",
            f"base_url = {_toml_string(provider.base_url)}",
            "",
        ]
    )


def prepare_isolated_codex_home(
    provider: ProviderSpec,
    codex_home: Path,
    *,
    base_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Write a minimal provider config and return a child-process-only environment."""
    codex_home.mkdir(parents=True, exist_ok=True)
    model_catalog_path = codex_home / "cc-switch-model-catalog.json"
    catalog_text = json.dumps(provider.model_catalog, ensure_ascii=False, indent=2) + "\n"
    config_text = _isolated_config(provider, model_catalog_path)
    if provider.api_key in config_text or provider.api_key in catalog_text:
        raise _provider_error("API key would be persisted in isolated CODEX_HOME")

    config_path = codex_home / "config.toml"
    config_path.write_text(config_text, encoding="utf-8")
    model_catalog_path.write_text(catalog_text, encoding="utf-8")
    config_path.chmod(0o600)
    model_catalog_path.chmod(0o600)

    environment = dict(base_environment) if base_environment is not None else os.environ.copy()
    environment.pop("OPENAI_BASE_URL", None)
    environment["CODEX_HOME"] = str(codex_home)
    environment[provider.api_key_env] = provider.api_key
    return environment


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path.home() / ".cc-switch/cc-switch.db")
    parser.add_argument("--provider-id", default=EXPECTED_PROVIDER_ID)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    provider = load_provider(args.database, args.provider_id)
    summary = provider.redacted_summary()
    if args.output_dir:
        prepare_isolated_codex_home(provider, args.output_dir, base_environment={})
        summary["isolated_codex_home"] = str(args.output_dir)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
