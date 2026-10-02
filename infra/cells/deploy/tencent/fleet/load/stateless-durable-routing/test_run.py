#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cloud_stateless_do_smoke", ROOT / "run.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class RoutingIdentityTests(unittest.TestCase):
    def test_object_id_is_stable_and_namespace_scoped(self):
        first = MODULE.object_id("default", "counter", "alice")
        self.assertEqual(first, MODULE.object_id("default", "counter", "alice"))
        self.assertEqual(len(first), 64)
        self.assertNotEqual(first, MODULE.object_id("tenant-b", "counter", "alice"))

    def test_rendezvous_selection_uses_cell_uid(self):
        cells = {"a": "uid-a", "b": "uid-b"}
        selected = MODULE.selected_cell("counter", "a" * 64, cells)
        self.assertIn(selected, cells)
        changed = {"a": "uid-a-replaced", "b": "uid-b"}
        observed = {
            MODULE.selected_cell("counter", f"{index:064x}", cells)
            != MODULE.selected_cell("counter", f"{index:064x}", changed)
            for index in range(100)
        }
        self.assertIn(True, observed)

    def test_generates_one_key_per_cell(self):
        cells = {"a": "uid-a", "b": "uid-b", "c": "uid-c"}
        result = MODULE.names_for_cells("default", "counter", cells)
        self.assertEqual(set(result), set(cells))
        for cell, (_, object_value) in result.items():
            self.assertEqual(MODULE.selected_cell("counter", object_value, cells), cell)

    def test_fixture_source_is_immutable_for_idempotent_reuse(self):
        self.assertEqual(
            MODULE.sha256(MODULE.WORKER_SOURCE.encode()),
            "17f80ed0ef5d7254be623065fa8e3b3060eab5ef6286251d424cec08115b1013",
        )


if __name__ == "__main__":
    unittest.main()
