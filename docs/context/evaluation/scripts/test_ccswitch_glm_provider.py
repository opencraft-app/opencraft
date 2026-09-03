#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import gc
import json
import sqlite3
import tempfile
import unittest
import warnings
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("ccswitch_glm_provider.py")
PROVIDER_ID = "ccf642d4-1927-4769-a8f7-e2882c488455"
SECRET = "test-secret-that-must-never-be-written"


def load_module():
    if not SCRIPT.exists():
        raise AssertionError(f"CC Switch provider helper is missing: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("ccswitch_glm_provider", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_model_catalog(root: Path) -> None:
    catalog = {
        "models": [
            {
                "slug": "glm-5.3",
                "display_name": "GLM 5.3",
                "marker": "catalog-file-contract",
            }
        ]
    }
    (root / "cc-switch-model-catalog.json").write_text(
        json.dumps(catalog),
        encoding="utf-8",
    )


def write_provider_database(path: Path, *, model: str = "glm-5.3", effort: str = "high", wire_api: str = "responses") -> None:
    config = f'''model_provider = "custom"
model = "{model}"
model_reasoning_effort = "{effort}"
disable_response_storage = true
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.custom]
name = "Tencent GLM Test"
wire_api = "{wire_api}"
requires_openai_auth = true
base_url = "https://example.invalid/v1"
'''
    settings = {
        "auth": {"OPENAI_API_KEY": SECRET},
        "config": config,
        "modelCatalog": {
            "models": [
                {
                    "model": "glm-5.3",
                    "displayName": "outdated lightweight catalog",
                    "contextWindow": 1000000,
                }
            ]
        },
        "apiFormat": "responses",
    }
    database = sqlite3.connect(path)
    try:
        database.execute(
            """
            CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            )
            """
        )
        database.execute(
            "INSERT INTO providers(id, app_type, name, settings_config) VALUES (?, 'codex', ?, ?)",
            (
                PROVIDER_ID,
                "腾讯云Token Plan 企业版 GLM5.3",
                json.dumps(settings),
            ),
        )
        database.commit()
    finally:
        database.close()
    write_model_catalog(path.parent)


class CcSwitchGlmProviderTests(unittest.TestCase):
    def test_loads_only_the_expected_glm_responses_high_contract(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temp:
            database = Path(temp) / "cc-switch.db"
            write_provider_database(database)

            provider = module.load_provider(database, PROVIDER_ID, catalog_root=Path(temp))
            summary = provider.redacted_summary()

        self.assertEqual(provider.model, "glm-5.3")
        self.assertEqual(provider.reasoning_effort, "high")
        self.assertEqual(provider.wire_api, "responses")
        self.assertEqual(provider.api_key_env, "OPENAI_API_KEY")
        self.assertNotIn(SECRET, json.dumps(summary, ensure_ascii=False))

    def test_isolated_codex_home_never_persists_the_api_key(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database = root / "cc-switch.db"
            codex_home = root / "isolated-codex-home"
            write_provider_database(database)
            provider = module.load_provider(database, PROVIDER_ID, catalog_root=root)

            environment = module.prepare_isolated_codex_home(
                provider,
                codex_home,
                base_environment={"PATH": "/usr/bin"},
            )
            persisted = "\n".join(
                path.read_text(encoding="utf-8")
                for path in codex_home.rglob("*")
                if path.is_file()
            )

        self.assertEqual(environment["OPENAI_API_KEY"], SECRET)
        self.assertEqual(environment["CODEX_HOME"], str(codex_home))
        self.assertNotIn(SECRET, persisted)
        self.assertFalse((codex_home / "auth.json").exists())
        self.assertIn('wire_api = "responses"', persisted)
        self.assertIn('model_reasoning_effort = "high"', persisted)
        self.assertIn('env_key = "OPENAI_API_KEY"', persisted)
        self.assertIn("requires_openai_auth = false", persisted)
        self.assertNotIn("requires_openai_auth = true", persisted)

    def test_rejects_a_non_responses_or_non_high_provider(self) -> None:
        module = load_module()
        for effort, wire_api in (("low", "responses"), ("high", "chat")):
            with self.subTest(effort=effort, wire_api=wire_api):
                with tempfile.TemporaryDirectory() as temp:
                    database = Path(temp) / "cc-switch.db"
                    write_provider_database(database, effort=effort, wire_api=wire_api)
                    with self.assertRaisesRegex(ValueError, "GLM5.3 provider contract"):
                        module.load_provider(database, PROVIDER_ID, catalog_root=Path(temp))

    def test_read_only_database_connection_is_closed(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temp:
            database = Path(temp) / "cc-switch.db"
            write_provider_database(database)
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always", ResourceWarning)
                module.load_provider(database, PROVIDER_ID, catalog_root=Path(temp))
                gc.collect()

        self.assertEqual(
            [warning for warning in caught if issubclass(warning.category, ResourceWarning)],
            [],
        )

    def test_uses_the_cli_catalog_file_referenced_by_provider_config(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database = root / "cc-switch.db"
            write_provider_database(database)

            provider = module.load_provider(database, PROVIDER_ID, catalog_root=root)

        self.assertEqual(provider.model_catalog["models"][0]["slug"], "glm-5.3")
        self.assertEqual(
            provider.model_catalog["models"][0]["marker"],
            "catalog-file-contract",
        )
        self.assertNotIn("model", provider.model_catalog["models"][0])

    def test_falls_back_to_the_pinned_provider_catalog_when_active_catalog_is_overwritten(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database = root / "cc-switch.db"
            write_provider_database(database)
            (root / "cc-switch-model-catalog.json").write_text(
                json.dumps({"models": [{"slug": "another-active-model"}]}),
                encoding="utf-8",
            )

            provider = module.load_provider(database, PROVIDER_ID, catalog_root=root)

        entry = provider.model_catalog["models"][0]
        self.assertEqual(entry["slug"], "glm-5.3")
        self.assertEqual(entry["display_name"], "outdated lightweight catalog")
        self.assertEqual(entry["supported_reasoning_levels"], [{"effort": "high", "description": "high"}])
        self.assertEqual(entry["context_window"], 1_000_000)


if __name__ == "__main__":
    unittest.main()
