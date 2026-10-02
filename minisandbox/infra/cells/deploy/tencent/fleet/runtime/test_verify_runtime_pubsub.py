import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("runtime_pubsub", ROOT / "verify-runtime-pubsub.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimePubsubTest(unittest.TestCase):
    def test_resolved_nats_is_accepted(self):
        MODULE.verify('{"nats":{"addresses":["nats:4222"]}}',
                      'Root {\n    pubsub: Some(\n        Nats(\n            Nats {\n            },\n        ),\n    ),\n}\n')

    def test_successful_parse_with_dropped_nats_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "did not resolve"):
            MODULE.verify('{"nats":{"addresses":["nats:4222"],"unsupported":true}}',
                          'Root {\n    pubsub: None,\n}\n')

    def test_memory_and_ambiguous_drivers_are_rejected(self):
        for config, resolved in [
            ('{"nats":{}}', 'Root {\n    pubsub: Some(\n        Memory(\n        ),\n    ),\n}\n'),
            ('{"nats":{},"memory":{}}', 'Root {\n    pubsub: Some(Nats()),\n}\n'),
        ]:
            with self.assertRaises(ValueError):
                MODULE.verify(config, resolved)

    def test_logs_strings_and_nested_fields_do_not_prove_selection(self):
        for resolved in [
            'loaded config Root { pubsub: Some(Nats()) }',
            'Root {\n        pubsub: Some(Nats()),\n}\n',
            'Root {\n    pubsub: Some(Nats()),\n}\nRoot {\n    pubsub: None,\n}\n',
        ]:
            with self.assertRaises(ValueError):
                MODULE.verify('{"nats":{}}', resolved)


if __name__ == "__main__":
    unittest.main()
