import copy
import json
import pathlib
import tempfile
import unittest

import yaml

import serving_recertification
import test_gitops


def fixture(root):
    original = test_gitops.Fixtures(root)
    render = json.loads(original.render.read_bytes())
    render["pool"] = {"name": "runtime", "uid": "pool-uid"}
    routes = []
    for cell in render["cells"]:
        name = cell["cell"]
        cell.update({"datacenter": "default", "routeConfigMapUid": name + "-identity-uid",
                     "endpoint": "http://10.1.0.2:6420", "serviceUid": name + "-engine-uid",
                     "statelessEndpoint": "http://10.1.0.3:19084", "statelessServiceUid": name + "-stateless-uid",
                     "servingRouteRevision": 1, "servingRouteConfigMapUid": name + "-serving-uid"})
        route = {"schema": "actor-cell-serving-route/v1", "region": "ap-beijing", "pool_name": "runtime", "pool_uid": "pool-uid",
                 "cell_name": name, "cell_uid": cell["cellUid"], "datacenter": "default", "revision": 1,
                 "actor_gateway_authority": cell["endpoint"], "actor_gateway_service_uid": cell["serviceUid"],
                 "stateless_executor_authority": cell["statelessEndpoint"], "stateless_executor_service_uid": cell["statelessServiceUid"],
                 "service_identity": "actor-cell/" + cell["cellUid"], "published_at": "2026-10-02T00:00:00Z"}
        route["manifest_sha256"] = serving_recertification.digest((json.dumps(route, sort_keys=True, separators=(",", ":")) + "\n").encode())
        cell["servingRouteManifestSha256"] = route["manifest_sha256"]
        routes.extend([
            {"metadata": {"name": "actor-cell-route-" + name, "namespace": "workers-api-system", "uid": cell["routeConfigMapUid"]},
             "immutable": True, "data": {"pool-name": "runtime", "pool-uid": "pool-uid", "cell-name": name, "cell-uid": cell["cellUid"], "datacenter": "default"}},
            {"metadata": {"name": "actor-cell-serving-route-" + name, "namespace": "workers-api-system", "uid": cell["servingRouteConfigMapUid"]},
             "data": {"route.json": json.dumps(route)}},
        ])
    test_gitops.write(original.render, render)
    files, _ = test_gitops.RENDER.render(original.manifest, original.render, original.credential,
        original.endpoint, original.object_router_endpoint, prior_convergence_path=original.convergence)
    desired = root / "desired"
    desired.mkdir()
    for name, content in files.items():
        test_gitops.write(desired / name, content)
    documents = [item for item in yaml.safe_load_all(files["workers-api.yaml"]) if item]
    documents += [yaml.safe_load(files[name]) for name in ("private-endpoint.yaml", "private-object-router-endpoint.yaml")]
    deployment = copy.deepcopy(next(item for item in documents if item["kind"] == "Deployment"))
    deployment["metadata"]["uid"] = "deployment-uid"
    service = copy.deepcopy(documents[-1])
    service["metadata"]["uid"] = "router-service-uid"
    service["spec"]["clusterIP"] = "10.99.0.2"
    service["spec"]["ports"][0]["nodePort"] = 32123
    service["status"] = {"loadBalancer": {"ingress": [{"ip": "10.77.4.10", "ipMode": "VIP"}]}}
    resources = [{"kind": item["kind"], "name": item["metadata"]["name"], "namespace": item["metadata"].get("namespace"), "status": "Synced"} for item in documents]
    secret = {"metadata": {"name": original.credential_name, "namespace": "workers-api-system", "uid": "secret-uid"}, "immutable": True}
    public_service = copy.deepcopy(documents[-2])
    public_service["spec"]["clusterIP"] = "10.99.0.3"
    public_service["spec"]["ports"][0]["nodePort"] = 32124
    return [desired, {"status": {"resources": resources}}, deployment, secret, service, {"items": routes}, original.object_router_endpoint, public_service]


class ServingRecertificationTest(unittest.TestCase):
    def test_canonical_serving_tree_binds_both_routes_and_ignores_allocated_fields(self):
        with tempfile.TemporaryDirectory(prefix="serving-recertify.", dir="/data/tmp") as raw:
            args = fixture(pathlib.Path(raw))
            result = serving_recertification.verify_serving(*args)
            self.assertEqual(result["serviceUid"], "router-service-uid")
            self.assertEqual(result["endpoint"], "10.77.4.10:19085")

    def test_serving_mutations_fail_closed(self):
        changes = {
            "missing_tracked_resource": lambda args: args[1]["status"]["resources"].pop(),
            "wrong_tracked_resource": lambda args: args[1]["status"]["resources"][0].update(name="another-resource"),
            "unsynced": lambda args: args[1]["status"]["resources"][0].update(status="OutOfSync"),
            "container_image": lambda args: args[2]["spec"]["template"]["spec"]["containers"][0].update(image="wrong-image"),
            "container_flags": lambda args: args[2]["spec"]["template"]["spec"]["containers"][0]["args"].append("--wrong-flag"),
            "secret_uid": lambda args: args[3]["metadata"].update(uid="replacement-secret"),
            "mutable_secret": lambda args: args[3].update(immutable=False),
            "router_uid": lambda args: args[4]["metadata"].update(uid="replacement-service"),
            "router_vip": lambda args: args[4]["status"]["loadBalancer"]["ingress"][0].update(ip="10.77.4.11"),
            "router_listener": lambda args: args[4]["spec"]["ports"][0].update(port=19086),
            "router_security_group": lambda args: args[4]["metadata"]["annotations"].update({"service.cloud.tencent.com/security-groups": "sg-unapproved"}),
            "router_source_ranges": lambda args: args[4]["spec"].update(loadBalancerSourceRanges=["0.0.0.0/0"]),
            "public_listener": lambda args: args[7]["spec"]["ports"][0].update(port=80),
            "public_source_ranges": lambda args: args[7]["spec"].update(loadBalancerSourceRanges=["0.0.0.0/0"]),
            "missing_route": lambda args: args[5]["items"].pop(),
            "identity_uid": lambda args: args[5]["items"][0]["metadata"].update(uid="replacement-route"),
            "mutable_identity": lambda args: args[5]["items"][0].update(immutable=False),
            "identity_cell_uid": lambda args: args[5]["items"][0]["data"].update({"cell-uid": "replaced-cell"}),
            "identity_unknown_field": lambda args: args[5]["items"][0]["data"].update({"engine-url": "http://unapproved"}),
            "identity_partial_audit": lambda args: args[5]["items"][0]["data"].update({"activation-receipt-digest": "sha256:" + "a" * 64}),
            "serving_uid": lambda args: args[5]["items"][1]["metadata"].update(uid="replacement-serving"),
            "serving_route_body": lambda args: args[5]["items"][1]["data"].update({"route.json": "{}"}),
        }
        for name, change in changes.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="serving-recertify.", dir="/data/tmp") as raw:
                args = fixture(pathlib.Path(raw))
                change(args)
                with self.assertRaises(ValueError):
                    serving_recertification.verify_serving(*args)

    def test_immutable_identity_may_retain_complete_publisher_audit_bundle(self):
        with tempfile.TemporaryDirectory(prefix="serving-recertify.", dir="/data/tmp") as raw:
            args = fixture(pathlib.Path(raw))
            data = args[5]["items"][0]["data"]
            for key in ("activation-receipt-digest", "adoption-receipt-digest", "convergence-receipt-digest", "qualification-chain-receipt-digest"):
                data[key] = "sha256:" + "a" * 64
            serving_recertification.verify_serving(*args)
            data["activation-receipt-digest"] = "unbound"
            with self.assertRaises(ValueError):
                serving_recertification.verify_serving(*args)

    def test_manifest_and_endpoint_receipt_bytes_are_fenced(self):
        for target in ("manifest", "endpoint"):
            with self.subTest(target=target), tempfile.TemporaryDirectory(prefix="serving-recertify.", dir="/data/tmp") as raw:
                args = fixture(pathlib.Path(raw))
                path = args[0] / "workers-api.yaml" if target == "manifest" else args[6]
                path.write_bytes(path.read_bytes() + b"\n")
                with self.assertRaises(ValueError):
                    serving_recertification.verify_serving(*args)


if __name__ == "__main__":
    unittest.main()
