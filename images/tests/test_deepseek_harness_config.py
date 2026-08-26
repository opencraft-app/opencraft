#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest


HELPER = pathlib.Path(__file__).resolve().parents[1] / "helpers" / "configure-deepseek-harness.py"
SPEC = importlib.util.spec_from_file_location("configure_deepseek_harness", HELPER)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeRpc:
    def __init__(self, *, pi_ai_value=None, credential_overrides=None, settings_writable=True):
        self.calls = []
        self.pi_ai_value = pi_ai_value if pi_ai_value is not None else {"providers": {}}
        self.credential_overrides = credential_overrides or {}
        self.settings_writable = settings_writable

    def __call__(self, method, payload):
        self.calls.append((method, payload))
        if method == "llm.providers":
            return {
                "providers": [
                    {"provider": "deepseek-official", "displayName": "DeepSeek", "settingsNs": "deepseek", "settingsPath": [], "active": True},
                    {"provider": "minimax-cn", "displayName": "MiniMax CN", "settingsNs": "pi-ai", "settingsPath": ["providers", "minimax-cn"], "active": True},
                    {"provider": "openai", "displayName": "OpenAI", "settingsNs": "pi-ai", "settingsPath": ["providers", "openai"], "active": True},
                ]
            }
        if method == "settings.describe":
            return {
                "writable": self.settings_writable,
                "namespaces": [
                    {"ns": "deepseek", "value": {}, "revision": 1},
                    {"ns": "pi-ai", "value": self.pi_ai_value, "revision": 7},
                ],
            }
        if method == "credentials.describe":
            return {"credentials": {
                ref: self.credential_overrides.get(
                    ref,
                    {"configured": ref == "DEEPSEEK_API_KEY", "writable": True},
                )
                for ref in payload["refs"]
            }}
        if method in {"settings.mutate", "credentials.set", "credentials.unset"}:
            return {}
        raise AssertionError(method)


class ConfigureDeepSeekHarnessTest(unittest.TestCase):
    def test_lists_only_the_region_allowlist(self):
        rpc = FakeRpc()
        result = MODULE.list_providers("cn", rpc)
        self.assertEqual([item["id"] for item in result["providers"]], ["deepseek", "minimax-cn"])
        self.assertTrue(result["providers"][0]["configured"])

    def test_configures_native_deepseek_without_mutating_settings(self):
        rpc = FakeRpc()
        result = MODULE.configure_provider("deepseek", "sk-secret", rpc)
        self.assertEqual(result, {"ok": True, "provider": "deepseek", "configured": True})
        self.assertIn(("credentials.set", {"ref": "DEEPSEEK_API_KEY", "value": "sk-secret"}), rpc.calls)
        self.assertFalse(any(method == "settings.mutate" for method, _ in rpc.calls))

    def test_materializes_pi_ai_credential_reference_before_writing(self):
        rpc = FakeRpc()
        MODULE.configure_provider("minimax-cn", "sk-secret", rpc)
        mutate = next(payload for method, payload in rpc.calls if method == "settings.mutate")
        self.assertEqual(mutate["ns"], "pi-ai")
        self.assertEqual(mutate["expectedRevision"], 7)
        self.assertEqual(mutate["ops"][0]["path"], ["providers", "minimax-cn", "apiKeyEnv"])
        self.assertEqual(rpc.calls[-1], ("credentials.set", {"ref": "MINIMAX_CN_API_KEY", "value": "sk-secret"}))

    def test_rejects_unknown_provider_and_empty_key(self):
        with self.assertRaisesRegex(ValueError, "unsupported provider"):
            MODULE.configure_provider("unknown", "key", FakeRpc())
        with self.assertRaisesRegex(ValueError, "API key is required"):
            MODULE.configure_provider("deepseek", "", FakeRpc())

    def test_removes_only_the_writable_deepseek_credential(self):
        rpc = FakeRpc()

        result = MODULE.remove_provider("deepseek", rpc)

        self.assertEqual(result, {"ok": True, "provider": "deepseek", "configured": False})
        self.assertIn(("credentials.unset", {"ref": "DEEPSEEK_API_KEY"}), rpc.calls)
        self.assertFalse(any(method == "settings.mutate" for method, _ in rpc.calls))

    def test_rejects_removing_deepseek_when_the_credential_is_environment_managed(self):
        rpc = FakeRpc(credential_overrides={
            "DEEPSEEK_API_KEY": {"configured": True, "writable": False},
        })

        with self.assertRaisesRegex(RuntimeError, "managed by the runtime environment"):
            MODULE.remove_provider("deepseek", rpc)

        self.assertFalse(any(method == "credentials.unset" for method, _ in rpc.calls))

    def test_removes_owned_catalog_credential_before_unsetting_the_profile(self):
        rpc = FakeRpc(
            pi_ai_value={"providers": {"minimax-cn": {"apiKeyEnv": "MINIMAX_CN_API_KEY"}}},
            credential_overrides={
                "MINIMAX_CN_API_KEY": {"configured": True, "writable": True},
            },
        )

        result = MODULE.remove_provider("minimax-cn", rpc)

        self.assertEqual(result, {"ok": True, "provider": "minimax-cn", "configured": False})
        unset_index = rpc.calls.index(("credentials.unset", {"ref": "MINIMAX_CN_API_KEY"}))
        mutate_index = next(index for index, (method, _) in enumerate(rpc.calls) if method == "settings.mutate")
        self.assertLess(unset_index, mutate_index)
        mutate = rpc.calls[mutate_index][1]
        self.assertEqual(mutate, {
            "ns": "pi-ai",
            "ops": [{"op": "unset", "path": ["providers", "minimax-cn"]}],
            "expectedRevision": 7,
        })

    def test_keeps_custom_credentials_and_unsets_only_the_catalog_profile(self):
        rpc = FakeRpc(
            pi_ai_value={"providers": {"minimax-cn": {"apiKeyEnv": "TEAM_MINIMAX_KEY"}}},
            credential_overrides={
                "TEAM_MINIMAX_KEY": {"configured": True, "writable": True},
            },
        )

        MODULE.remove_provider("minimax-cn", rpc)

        self.assertFalse(any(method == "credentials.unset" for method, _ in rpc.calls))
        self.assertTrue(any(method == "settings.mutate" for method, _ in rpc.calls))

    def test_remove_is_idempotent_when_no_managed_configuration_exists(self):
        rpc = FakeRpc(credential_overrides={
            "DEEPSEEK_API_KEY": {"configured": False, "writable": True},
        })

        self.assertEqual(
            MODULE.remove_provider("deepseek", rpc),
            {"ok": True, "provider": "deepseek", "configured": False},
        )
        self.assertFalse(any(method in {"credentials.unset", "settings.mutate"} for method, _ in rpc.calls))


if __name__ == "__main__":
    unittest.main()
