import configparser
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class SubmoduleMappingTests(unittest.TestCase):
    def test_every_tracked_gitlink_has_a_module_mapping(self):
        tracked = subprocess.check_output(
            ["git", "ls-files", "--stage"], cwd=REPO_ROOT, text=True,
        )
        gitlinks = {
            line.split("\t", 1)[1]
            for line in tracked.splitlines()
            if line.startswith("160000 ")
        }

        modules = configparser.ConfigParser(interpolation=None)
        self.assertTrue(modules.read(REPO_ROOT / ".gitmodules"))
        mapped = [modules[section].get("path", "") for section in modules.sections()]
        self.assertEqual(len(mapped), len(set(mapped)), "duplicate .gitmodules paths")
        self.assertEqual(set(mapped), gitlinks)
        for section in modules.sections():
            self.assertTrue(modules[section].get("url"), f"{section} is missing a URL")

        self.assertEqual(
            modules['submodule "shadow/tencentcloud-sdk-go"']["url"],
            "git@git.woa.com:tencentcloud-internal/tencentcloud-sdk-go.git",
        )


if __name__ == "__main__":
    unittest.main()
