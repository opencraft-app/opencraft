import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(
    parent
    for parent in Path(__file__).resolve().parents
    if (parent / "user/auth").is_dir() and (parent / "argocd").is_dir()
)
KR_AUTH_ROUTING = (
    REPO_ROOT
    / "argocd/services/lightclaw-auth/sandbox-kr-1/patch-shadow-routing.yaml"
)


class KoreaAuthGitHubRegistrationContractTests(unittest.TestCase):
    def test_github_registration_is_explicitly_enabled(self) -> None:
        documents = list(yaml.safe_load_all(KR_AUTH_ROUTING.read_text()))
        config_map = next(
            document
            for document in documents
            if document.get("kind") == "ConfigMap"
            and document.get("metadata", {}).get("name") == "lightclaw-auth-config"
        )

        self.assertEqual(
            config_map["data"].get("LIGHTCLAW_GITHUB_REGISTRATION_ENABLED"),
            "true",
        )


if __name__ == "__main__":
    unittest.main()
