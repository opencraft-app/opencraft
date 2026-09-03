#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("build_v4_dataset.py")


def load_module():
    spec = importlib.util.spec_from_file_location("build_v4_dataset", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def fixture_records(count: int) -> list[dict]:
    services = ("frontend", "cloudagent", "argocd", "cloudladdergateway")
    risks = ("low", "high")
    return [
        {
            "id": f"mono2-mr-{index:02d}",
            "base_commit": f"base-{index:02d}",
            "merge_commit": f"merge-{index:02d}",
            "requirement_query": f"修复 {services[index % len(services)]} {index}",
            "changed_files": [f"{services[index % len(services)]}/changed-{index}.txt"],
            "service": services[index % len(services)],
            "risk": risks[index % len(risks)],
        }
        for index in range(count)
    ]


class BuildV4DatasetTests(unittest.TestCase):
    def test_selection_is_seeded_stratified_and_excludes_v3(self) -> None:
        module = load_module()
        records = fixture_records(60)
        excluded = {f"mono2-mr-{index:02d}" for index in range(5)}

        holdout, final = module.select_v4_samples(records, excluded, seed=20260827)
        repeated_holdout, repeated_final = module.select_v4_samples(
            records, excluded, seed=20260827
        )

        self.assertEqual((len(holdout), len(final)), (5, 50))
        self.assertFalse({row["id"] for row in holdout + final} & excluded)
        self.assertEqual(len({row["id"] for row in holdout + final}), 55)
        self.assertEqual(holdout + final, repeated_holdout + repeated_final)
        self.assertEqual(
            {row["service"] for row in holdout + final},
            {"frontend", "cloudagent", "argocd", "cloudladdergateway"},
        )

    def test_selection_rejects_incomplete_or_duplicate_records(self) -> None:
        module = load_module()

        with self.assertRaisesRegex(ValueError, "at least 55"):
            module.select_v4_samples(fixture_records(54), set(), seed=20260827)

        duplicate = fixture_records(55)
        duplicate[-1]["id"] = duplicate[-2]["id"]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            module.select_v4_samples(duplicate, set(), seed=20260827)

    def test_normalized_mr_keeps_only_query_commits_and_file_paths(self) -> None:
        module = load_module()
        merge_request = {
            "id": 123,
            "iid": 456,
            "title": "修复前端运行时配置",
            "merge_commit_sha": "merge-sha",
        }
        commit = {"parent_ids": ["base-sha", "source-sha"]}

        record = module.normalize_merged_mr(
            merge_request,
            commit,
            ["frontend/src/runtime.ts", "frontend/src/old.ts", "/dev/null", "frontend/src/deleted.ts"],
        )

        self.assertEqual(record["id"], "mono2-mr-456")
        self.assertEqual(record["base_commit"], "base-sha")
        self.assertEqual(
            record["changed_files"],
            ["frontend/src/deleted.ts", "frontend/src/old.ts", "frontend/src/runtime.ts"],
        )
        self.assertNotIn("/dev/null", record["changed_files"])

    def test_fetch_merged_records_uses_only_file_list_and_first_parent(self) -> None:
        module = load_module()
        calls: list[list[str]] = []

        def fake_query(command: list[str]):
            calls.append(command)
            if command[1:3] == ["mr", "list"]:
                return [{"id": 123, "iid": 456, "title": "修复前端运行时配置", "merge_commit_sha": "merge-sha"}]
            if command[1:3] == ["commits", "get"]:
                return {"parent_ids": ["base-sha", "source-sha"]}
            raise AssertionError(command)

        records = module.fetch_merged_records(
            "wisp/mono2",
            1,
            fake_query,
            git_runner=lambda base, merge: ["frontend/src/runtime.ts"],
        )

        self.assertEqual(records[0]["changed_files"], ["frontend/src/runtime.ts"])
        self.assertEqual(len(calls), 2)

    def test_local_first_parent_diff_replaces_api_file_list_for_gold(self) -> None:
        module = load_module()

        paths = module.local_first_parent_changed_files(
            "base-sha",
            "merge-sha",
            git_runner=lambda base, merge: ["frontend/src/actual.ts", "frontend/src/deleted.ts"],
        )

        self.assertEqual(paths, ["frontend/src/actual.ts", "frontend/src/deleted.ts"])

    def test_cli_accepts_read_only_gongfeng_fetch(self) -> None:
        module = load_module()

        args = module.parse_args(
            [
                "--fetch-project",
                "wisp/mono2",
                "--exclude-jsonl",
                "previous.jsonl",
                "--max-merged-mrs",
                "80",
            ]
        )

        self.assertEqual(args.fetch_project, "wisp/mono2")
        self.assertIsNone(args.source)
        self.assertEqual(args.max_merged_mrs, 80)

    def test_legacy_exclusion_paths_cover_v3_candidates_and_results_only(self) -> None:
        module = load_module()

        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for name in (
                "candidates.jsonl",
                "repo-doc-v3-results.jsonl",
                "candidates-v4-final.jsonl",
                "v4-final-results.jsonl",
            ):
                (directory / name).write_text("\n", encoding="utf-8")
            names = {path.name for path in module.legacy_exclusion_paths(directory)}

        self.assertEqual(names, {"candidates.jsonl", "repo-doc-v3-results.jsonl"})


if __name__ == "__main__":
    unittest.main()
