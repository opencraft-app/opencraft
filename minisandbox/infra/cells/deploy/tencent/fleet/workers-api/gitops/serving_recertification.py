"""Read-only verification of the additional serving-phase GitOps bindings."""

import hashlib
import ipaddress
import json
from pathlib import Path

import yaml


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def verify_serving(desired: Path, application, deployment, secret, router_service, routes, endpoint_path: Path, public_service):
    evidence = json.loads((desired / "evidence.json").read_bytes())
    render_bytes = (desired / "workers-api-render.json").read_bytes()
    render = json.loads(render_bytes)
    manifest_bytes = (desired / "workers-api.yaml").read_bytes()
    if (evidence.get("phase") != "serving" or render.get("phase") != "serving"
        or digest(render_bytes) != evidence.get("workersApiRenderReceiptSha256")
        or digest(manifest_bytes) != render.get("manifestSha256")):
        raise ValueError("serving Git manifest or render receipt differs")
    documents = [item for item in yaml.safe_load_all(manifest_bytes) if item]
    for name in ("private-endpoint.yaml", "private-object-router-endpoint.yaml"):
        documents.append(yaml.safe_load((desired / name).read_bytes()))
    def identity(item):
        metadata = item.get("metadata", item)
        return item["kind"], metadata.get("namespace") or "", metadata["name"]
    expected = {identity(item) for item in documents}
    tracked = application.get("status", {}).get("resources", [])
    actual = {identity(item) for item in tracked}
    if len(documents) != 14 or len(expected) != 14 or len(tracked) != 14 or actual != expected or any(item.get("status") != "Synced" for item in tracked):
        raise ValueError("serving tracked resource inventory differs")
    desired_deployment = next(item for item in documents if item["kind"] == "Deployment")
    pod = deployment["spec"]["template"]["spec"]
    desired_pod = desired_deployment["spec"]["template"]["spec"]
    for key in ("containers", "initContainers"):
        actual_containers = pod.get(key, [])
        expected_containers = desired_pod.get(key, [])
        if len(actual_containers) != len(expected_containers):
            raise ValueError("serving workload container inventory differs")
        for actual_container, expected_container in zip(actual_containers, expected_containers):
            if any(actual_container.get(field) != expected_container.get(field) for field in ("name", "image", "args", "env")):
                raise ValueError("serving workload image, flags or credential refs differ")
    credential = render.get("credentialReceipt", {})
    metadata = secret.get("metadata", {})
    if (secret.get("immutable") is not True or metadata.get("name") != credential.get("name")
        or metadata.get("uid") != credential.get("uid") or metadata.get("namespace") != "workers-api-system"
        or evidence.get("externalCredentialName") != credential.get("name")):
        raise ValueError("serving immutable credential identity differs")

    endpoint_bytes = endpoint_path.read_bytes()
    endpoint = json.loads(endpoint_bytes)
    router_uid = router_service.get("metadata", {}).get("uid")
    address, port = endpoint.get("endpoint", "").rsplit(":", 1)
    ingress = router_service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
    if ((endpoint.get("schema"), endpoint.get("verdict")) != ("actor-object-router-private-endpoint/v1", "passed")
        or digest(endpoint_bytes) != evidence.get("objectRouterEndpointReceiptSha256")
        or endpoint.get("endpoint") != evidence.get("objectRouterEndpoint")
        or not ipaddress.ip_address(address).is_private or port != "19085"
        or endpoint.get("service", {}).get("uid") != router_uid
        or evidence.get("objectRouterServiceUidAtAdoption") != router_uid
        or endpoint.get("deployment", {}).get("uid") != deployment["metadata"]["uid"]
        or evidence.get("deploymentUidAtAdoption") != deployment["metadata"]["uid"]
        or len(ingress) != 1 or ingress[0].get("ip") != address):
        raise ValueError("serving Object Router endpoint identity differs")
    for live_service, desired_service in ((public_service, documents[-2]), (router_service, documents[-1])):
        live_metadata = live_service.get("metadata", {})
        if identity(live_service) != identity(desired_service) or any(
            live_metadata.get("annotations", {}).get(key) != value
            for key, value in desired_service.get("metadata", {}).get("annotations", {}).items()
        ):
            raise ValueError("serving endpoint metadata differs")
        live_spec = dict(live_service.get("spec", {}))
        live_spec["ports"] = [{key: value for key, value in item.items() if key != "nodePort"} for item in live_spec.get("ports", [])]
        if any(live_spec.get(key) != value for key, value in desired_service["spec"].items()):
            raise ValueError("serving endpoint listener or security policy differs")

    cells = render.get("cells", [])
    if len(cells) != 2 or len({item["cell"] for item in cells}) != 2:
        raise ValueError("serving Cell inventory differs")
    maps = routes.get("items", [])
    by_name = {item["metadata"]["name"]: item for item in maps}
    names = sorted(name for cell in cells for name in ("actor-cell-route-" + cell["cell"], "actor-cell-serving-route-" + cell["cell"]))
    if len(maps) != 4 or sorted(by_name) != names or evidence.get("externalRouteConfigMaps") != names:
        raise ValueError("serving external route inventory differs")
    for cell in cells:
        identity_route = by_name["actor-cell-route-" + cell["cell"]]
        if (identity_route.get("immutable") is not True or identity_route["metadata"].get("uid") != cell["routeConfigMapUid"]
            or identity_route["metadata"].get("namespace") != "workers-api-system"
            or identity_route.get("data") != {"pool-name": render["pool"]["name"], "pool-uid": render["pool"]["uid"],
                "cell-name": cell["cell"], "cell-uid": cell["cellUid"], "datacenter": cell["datacenter"]}):
            raise ValueError("serving immutable Cell route differs")
        serving_map = by_name["actor-cell-serving-route-" + cell["cell"]]
        route = json.loads(serving_map.get("data", {}).get("route.json", "{}"))
        expected_route = {"schema": "actor-cell-serving-route/v1", "cell_name": cell["cell"], "cell_uid": cell["cellUid"],
            "pool_name": render["pool"]["name"], "pool_uid": render["pool"]["uid"], "datacenter": cell["datacenter"],
            "revision": cell["servingRouteRevision"], "manifest_sha256": cell["servingRouteManifestSha256"],
            "actor_gateway_authority": cell["endpoint"], "actor_gateway_service_uid": cell["serviceUid"],
            "stateless_executor_authority": cell["statelessEndpoint"], "stateless_executor_service_uid": cell["statelessServiceUid"],
            "service_identity": "actor-cell/" + cell["cellUid"]}
        unsigned = {key: value for key, value in route.items() if key != "manifest_sha256"}
        canonical = (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if (serving_map["metadata"].get("uid") != cell["servingRouteConfigMapUid"]
            or serving_map["metadata"].get("namespace") != "workers-api-system"
            or any(route.get(key) != value for key, value in expected_route.items())
            or digest(canonical) != route.get("manifest_sha256")):
            raise ValueError("serving Cell endpoint snapshot differs")
    return {"endpoint": endpoint["endpoint"], "serviceUid": router_uid, "receiptSha256": digest(endpoint_bytes)}
