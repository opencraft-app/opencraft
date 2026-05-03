import sys
import unittest
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent


class TestDiscoveryTests(unittest.TestCase):
    def test_unittest_discover_loads_every_test_file(self) -> None:
        expected = {
            path.resolve()
            for path in TESTS_DIR.rglob("test_*.py")
            if path.resolve() != Path(__file__).resolve()
        }

        suite = unittest.defaultTestLoader.discover(str(TESTS_DIR))
        loaded = {
            Path(sys.modules[test_case.__class__.__module__].__file__).resolve()
            for test_case in iter_test_cases(suite)
            if test_case.__class__.__module__ in sys.modules
        }

        self.assertFalse(expected - loaded, f"unittest discover missed: {sorted(expected - loaded)}")


def iter_test_cases(suite: unittest.TestSuite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_test_cases(item)
        else:
            yield item


if __name__ == "__main__":
    unittest.main()
