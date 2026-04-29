import ast
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"
COMMAND_DIR = RUNTIME_DIR / "commands"
ALLOWED_MAIN_MODULE_PREFIXES = ("contracts.", "gitops.", "db_gates.")


class CommandWrapperTests(unittest.TestCase):
    def test_materialize_manifest_covers_runtime_python_without_local_secrets(self) -> None:
        manifest_path = RUNTIME_DIR / "materialize-files.txt"
        manifest_entries = {
            line.split("#", 1)[0].strip()
            for line in manifest_path.read_text().splitlines()
            if line.split("#", 1)[0].strip()
        }
        expected_python = {
            str(path.relative_to(REPO_ROOT))
            for package in ("commands", "contracts", "gitops", "db_gates")
            for path in (RUNTIME_DIR / package).rglob("*.py")
        }

        self.assertFalse(any(".secret" in entry or "kubeconfig" in entry for entry in manifest_entries))
        self.assertTrue(all(entry.startswith(".ci/runtime/") for entry in manifest_entries))
        self.assertTrue(expected_python.issubset(manifest_entries))

    def test_command_wrappers_only_bootstrap_and_import_main(self) -> None:
        for path in sorted(COMMAND_DIR.glob("*.py")):
            with self.subTest(path=path.name):
                source = path.read_text()
                tree = ast.parse(source)
                if path.name == "__init__.py":
                    self.assertTrue(
                        all(isinstance(node, ast.Expr) for node in tree.body),
                        "__init__.py must only contain a module docstring",
                    )
                    continue

                self.assertFalse(
                    any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in tree.body),
                    f"{path.name} must not define command-local behavior",
                )
                self.assertTrue(
                    all(isinstance(node, (ast.Expr, ast.Import, ast.ImportFrom, ast.Assign, ast.If)) for node in tree.body),
                    f"{path.name} contains top-level logic outside wrapper bootstrap",
                )

                main_imports = [
                    node
                    for node in tree.body
                    if isinstance(node, ast.ImportFrom)
                    and node.module
                    and node.module.startswith(ALLOWED_MAIN_MODULE_PREFIXES)
                ]
                self.assertEqual(len(main_imports), 1, f"{path.name} must import exactly one semantic main")
                self.assertEqual([alias.name for alias in main_imports[0].names], ["main"])

                imported_modules = {
                    alias.name
                    for node in tree.body
                    if isinstance(node, ast.Import)
                    for alias in node.names
                }
                self.assertEqual(imported_modules, {"sys"})
                self.assertTrue(
                    any(isinstance(node, ast.ImportFrom) and node.module == "pathlib" for node in tree.body),
                    f"{path.name} must import pathlib.Path for runtime bootstrap",
                )

                if_nodes = [node for node in tree.body if isinstance(node, ast.If)]
                self.assertEqual(len(if_nodes), 2, f"{path.name} must only have sys.path and __main__ guards")
                self.assertTrue(self._is_sys_path_guard(if_nodes[0]), f"{path.name} first guard must bootstrap sys.path")
                self.assertTrue(self._is_main_guard(if_nodes[1]), f"{path.name} second guard must call main")

    def _is_sys_path_guard(self, node: ast.If) -> bool:
        return (
            isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Call)
            and isinstance(node.body[0].value.func, ast.Attribute)
            and node.body[0].value.func.attr == "insert"
        )

    def _is_main_guard(self, node: ast.If) -> bool:
        if len(node.body) != 1 or not isinstance(node.body[0], ast.Raise):
            return False
        exc = node.body[0].exc
        return (
            isinstance(exc, ast.Call)
            and isinstance(exc.func, ast.Name)
            and exc.func.id == "SystemExit"
            and len(exc.args) == 1
            and isinstance(exc.args[0], ast.Call)
            and isinstance(exc.args[0].func, ast.Name)
            and exc.args[0].func.id == "main"
        )


if __name__ == "__main__":
    unittest.main()
