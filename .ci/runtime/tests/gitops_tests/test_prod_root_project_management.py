import unittest
from pathlib import Path

import yaml


class ProdRootProjectManagementTests(unittest.TestCase):
    def test_production_roots_manage_leaf_apps_and_projects(self) -> None:
        for env in ("sgprod", "shprod"):
            with self.subTest(env=env):
                manifest = yaml.safe_load(Path(f"argocd/root/{env}.yaml").read_text())
                sources = manifest["spec"]["sources"]

                self.assertEqual(
                    sources[0],
                    {
                        "repoURL": "git@git.woa.com:wisp/mono2.git",
                        "targetRevision": "gitops",
                        "path": f"argocd/apps/{env}",
                    },
                )
                self.assertEqual(
                    sources[1],
                    {
                        "repoURL": "git@git.woa.com:wisp/mono2.git",
                        "targetRevision": "gitops",
                        "path": "argocd/projects",
                        "directory": {"include": f"{env}*.yaml"},
                    },
                )

                project = yaml.safe_load(Path(f"argocd/projects/{env}-root.yaml").read_text())
                self.assertEqual(
                    project["spec"]["namespaceResourceWhitelist"],
                    [
                        {"group": "argoproj.io", "kind": "Application"},
                        {"group": "argoproj.io", "kind": "AppProject"},
                    ],
                )


if __name__ == "__main__":
    unittest.main()
