import copy
import hashlib
import importlib.util
import json
import pathlib
from types import SimpleNamespace
import unittest
from unittest import mock


PATH = pathlib.Path(__file__).with_name("render_control_plane.py")
SPEC = importlib.util.spec_from_file_location("render_control_plane", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderControlPlaneTest(unittest.TestCase):
    def test_profile_binding_is_canonical(self):
        profile = {"spec": {"b": 2, "a": 1}}
        expected = "sha256:" + hashlib.sha256(b'{"a":1,"b":2}').hexdigest()
        self.assertEqual(MODULE.spec_digest(profile), expected)

    def test_sync_waves_preserve_dependency_order(self):
        self.assertLess(int(MODULE.wave({"kind": "CustomResourceDefinition"})), int(MODULE.wave({"kind": "RivetCellProfile"})))
        self.assertLess(int(MODULE.wave({"kind": "RivetCellProfile"})), int(MODULE.wave({"kind": "RivetCell"})))
        self.assertLess(int(MODULE.wave({"kind": "RivetCell"})), int(MODULE.wave({"kind": "Deployment"})))

    def test_unknown_resource_kind_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unowned"):
            MODULE.wave({"kind": "Secret"})

    def test_render_binds_cell_and_profile_to_complete_image_inventory(self):
        profile = {
            "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "RivetCellProfile",
            "metadata": {"name": "profile"},
            "spec": {"driverABI": "test-v1", "region": "ap-beijing"},
        }
        digest = MODULE.spec_digest(profile)
        shard_class = {
            "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "ShardClass",
            "metadata": {"name": "class"},
            "spec": {"profileRef": {"name": "profile", "digest": digest}},
        }
        cell = {
            "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "RivetCell",
            "metadata": {"name": "actor-bj-q01"},
            "spec": {"className": "class"},
        }
        deployment = {
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "fdb-operator-actor-fleet-controller"},
            "spec": {"template": {"metadata": {}, "spec": {"containers": [{"name": "manager"}]}}},
        }
        service = {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "metrics"}}
        crds = [{"metadata": {"name": name}} for name in (
            "rivetcellprofiles.fleet.actor.dev", "shardclasses.fleet.actor.dev", "rivetcells.fleet.actor.dev"
        )]
        documents = {"crds": crds, "controller": [deployment, service], "cell": [profile, shard_class, cell]}
        args = SimpleNamespace(
            crds="crds", controller="controller", cell="cell", cell_name="actor-bj-q01",
            controller_image="example.invalid/controller@sha256:" + "a" * 64,
            source_revision="b" * 40, source_manifest_sha256="c" * 64,
            image_inventory_digest="sha256:" + "d" * 64,
        )
        with mock.patch.object(MODULE, "documents", side_effect=lambda path: copy.deepcopy(documents[path])):
            rendered = MODULE.render(args)
        rendered_by_kind = {item["kind"]: item for item in rendered}
        self.assertEqual(
            rendered_by_kind["RivetCellProfile"]["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"],
            args.image_inventory_digest,
        )
        annotations = rendered_by_kind["RivetCell"]["metadata"]["annotations"]
        self.assertEqual(annotations["fleet.actor.dev/profile-digest"], digest)
        self.assertEqual(annotations["fleet.actor.dev/image-inventory-digest"], args.image_inventory_digest)


if __name__ == "__main__":
    unittest.main()
