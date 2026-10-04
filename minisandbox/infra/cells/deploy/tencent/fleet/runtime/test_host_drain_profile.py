#!/usr/bin/env python3

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_host_autoscaling as manifests


SCRIPT = Path(__file__).with_name("host-drain-profile.py")
SPEC = importlib.util.spec_from_file_location("host_drain_profile", SCRIPT)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class HostDrainProfileTests(unittest.TestCase):
    def setUp(self):
        self.production = next(
            document for document in manifests.HostAutoscalingManifestTests().render()
            if document["kind"] == "Deployment"
        )

    def test_default_production_is_structurally_unchanged(self):
        self.assertEqual(PROFILE.render_profile(self.production, "production"), self.production)
        PROFILE.check_profile(self.production, "production")

    def test_bundle_preserves_every_non_controller_resource(self):
        items = manifests.HostAutoscalingManifestTests().render()
        before = {"apiVersion": "v1", "kind": "List", "items": items}
        original = copy.deepcopy(before)
        after = PROFILE.render_bundle(before, "exploration")
        self.assertEqual(before, original)
        for old, new in zip(before["items"], after["items"]):
            if old["kind"] == "Deployment":
                PROFILE.check_profile(new, "exploration")
            else:
                self.assertEqual(old, new)
        self.assertEqual(PROFILE.render_bundle(after, "production"), before)

    def test_ambiguous_bundle_rejected(self):
        for items in (
            [], [self.production, self.production],
            [{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "not-allowed"}}, self.production],
            [{"apiVersion": "v1", "kind": "List", "items": [self.production]}],
            [{"apiVersion": "v1", "kind": "Role", "metadata": []}, self.production],
        ):
            with self.subTest(count=len(items)), self.assertRaises(ValueError):
                PROFILE.render_bundle({"apiVersion": "v1", "kind": "List", "items": items}, "exploration")

    def test_exploration_changes_only_two_timers_and_own_annotation(self):
        before = copy.deepcopy(self.production)
        explored = PROFILE.render_profile(self.production, "exploration")
        PROFILE.check_profile(explored, "exploration")
        self.assertEqual(self.production, before)
        normalized = copy.deepcopy(explored)
        annotations, env = PROFILE.controller_parts(normalized)
        self.assertEqual(annotations.pop(PROFILE.PROFILE_ANNOTATION), "exploration")
        self.assertEqual(tuple(env[name]["value"] for name in PROFILE.TIMERS), ("30s", "2s"))
        for name, value in zip(PROFILE.TIMERS, PROFILE.PROFILES["production"]):
            env[name]["value"] = value
        self.assertEqual(normalized, before)
        self.assertEqual(PROFILE.render_profile(explored, "production"), before)

    def test_marker_alone_cannot_classify_fast_as_production(self):
        explored = PROFILE.render_profile(self.production, "exploration")
        with self.assertRaises(ValueError):
            PROFILE.check_profile(explored, "production")
        explored["spec"]["template"]["metadata"]["annotations"].pop(PROFILE.PROFILE_ANNOTATION)
        with self.assertRaises(ValueError):
            PROFILE.check_profile(explored, "production")
        with self.assertRaises(ValueError):
            PROFILE.render_profile(explored, "production")

    def test_fixed_safety_guards_cannot_be_relaxed(self):
        for name in PROFILE.FIXED_GUARDS:
            with self.subTest(name=name):
                changed = copy.deepcopy(self.production)
                _, env = PROFILE.controller_parts(changed)
                env[name]["value"] = "changed"
                with self.assertRaises(ValueError):
                    PROFILE.render_profile(changed, "exploration")

    def test_duplicate_environment_and_indirect_timers_rejected(self):
        for duplicate in (True, False):
            changed = copy.deepcopy(self.production)
            _, env = PROFILE.controller_parts(changed)
            if duplicate:
                changed["spec"]["template"]["spec"]["containers"][0]["env"].append(copy.deepcopy(env[PROFILE.TIMERS[0]]))
            else:
                env[PROFILE.TIMERS[0]].pop("value")
                env[PROFILE.TIMERS[0]]["valueFrom"] = {"fieldRef": {"fieldPath": "metadata.name"}}
            with self.assertRaises(ValueError):
                PROFILE.render_profile(changed, "exploration")

    def invoke(self, action, profile, raw):
        return subprocess.run(
            [sys.executable, str(SCRIPT), action, profile], input=raw,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10,
        )

    def test_real_cli_round_trip_and_check(self):
        rendered = self.invoke("render", "exploration", json.dumps(self.production).encode())
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        for expected, code in (("production", 2), ("exploration", 0)):
            checked = self.invoke("check", expected, rendered.stdout)
            self.assertEqual(checked.returncode, code)
            self.assertEqual(checked.stdout, b"")
        restored = self.invoke("render", "production", rendered.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(json.loads(restored.stdout), self.production)

    def test_real_cli_malformed_inputs_fail_without_echoing_data(self):
        raw = json.dumps(self.production)
        for rejected in (
            b"[]", b"null", b"{", b'{} {}', b'NaN', b'"private-sentinel"',
            (raw[:-1] + ',"kind":"Deployment"}').encode(),
            (raw[:-1] + ',"unrelated":NaN}').encode(),
            b" " * (PROFILE.MAX_INPUT_BYTES + 1),
        ):
            with self.subTest(length=len(rejected)):
                result = self.invoke("render", "exploration", rejected)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"Host drain profile input rejected\n")

    def test_nonfinite_constant_also_rejected_by_check(self):
        raw = json.dumps(self.production)
        for value in ("NaN", "Infinity", "-Infinity"):
            result = self.invoke("check", "production", (raw[:-1] + ',"unrelated":' + value + '}').encode())
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")

    def test_unknown_profile_and_wrong_component_rejected(self):
        with self.assertRaises(ValueError):
            PROFILE.render_profile(self.production, "quick")
        result = self.invoke("render", "private-sentinel", json.dumps(self.production).encode())
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"private-sentinel", result.stderr)
        self.production["metadata"]["labels"]["fleet.actor.dev/component"] = "engine"
        result = self.invoke("render", "exploration", json.dumps(self.production).encode())
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
