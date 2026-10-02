#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workerd_host_drain_e2e", MODULE)
e2e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e2e)


class HostDrainHelpersTest(unittest.TestCase):
	def test_ordinal(self):
		self.assertEqual(e2e.ordinal("local-runtime-a-runtime-hosts-17"), 17)
		with self.assertRaises(ValueError):
			e2e.ordinal("not-a-stateful-pod")

	def test_retained_actor_set_keeps_one_actor_per_side(self):
		actors = [e2e.capacity.Actor("a", "a"), e2e.capacity.Actor("b", "b")]
		keep, migrating = e2e.retained_actor_set(
			actors, {"a": ["host-0"], "b": ["host-1"]}, "host-1"
		)
		self.assertEqual(keep, {"a", "b"})
		self.assertEqual(migrating.actor_id, "b")

	def test_retained_actor_set_rejects_one_sided_placement(self):
		actors = [e2e.capacity.Actor("a", "a")]
		with self.assertRaises(ValueError):
			e2e.retained_actor_set(actors, {"a": ["host-0"]}, "host-1")


if __name__ == "__main__":
	unittest.main()
