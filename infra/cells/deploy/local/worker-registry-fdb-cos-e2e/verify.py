#!/usr/bin/env python3
import concurrent.futures
import json
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
endpoint = base + "/v1/namespaces/default/workers/hello"


def request(method: str, url: str, body=None):
    encoded = None if body is None else json.dumps(body).encode()
    headers = {} if body is None else {"Content-Type": "application/json"}
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=encoded, headers=headers, method=method), timeout=10
        ) as response:
            content = response.read()
            return response.status, None if not content else json.loads(content)
    except urllib.error.HTTPError as error:
        content = error.read()
        return error.code, None if not content else json.loads(content)


upload_a = {
    "main_module": "main.js",
    "modules": {"main.js": "export default { fetch() { return new Response('a') } }"},
    "compatibility_date": "2026-08-14",
}
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
    results = list(executor.map(lambda _: request("POST", endpoint + "/versions", upload_a), range(32)))
statuses = [status for status, _ in results]
assert statuses.count(201) == 1, statuses
assert all(status in (200, 201) for status in statuses), statuses
version_a = results[0][1]["version_id"]
assert all(result[1]["version_id"] == version_a for result in results)

upload_b = {
    **upload_a,
    "modules": {"main.js": "export default { fetch() { return new Response('b') } }"},
}
status, version = request("POST", endpoint + "/versions", upload_b)
assert status == 201, (status, version)
version_b = version["version_id"]
assert version_b != version_a

status, missing = request("GET", endpoint)
assert status == 404, (status, missing)
status, worker = request(
    "POST",
    endpoint + "/deployments",
    {
        "strategy": "percentage",
        "versions": [
            {"version_id": version_a, "percentage": 25},
            {"version_id": version_b, "percentage": 75},
        ],
    },
)
assert status == 201, (status, worker)
deployment_id = worker["deployment"]["id"]
assert [item["version_id"] for item in worker["versions"]] == [version_a, version_b]

extra_versions = []
for label in ("c", "d", "e", "f"):
    status, version = request(
        "POST",
        endpoint + "/versions",
        {**upload_a, "modules": {"main.js": f"export default {{ fetch() {{ return new Response('{label}') }} }}"}},
    )
    assert status == 201, (status, version)
    extra_versions.append(version["version_id"])

status, versions = request("GET", endpoint + "/versions?per_page=10")
assert status == 200 and versions["retention"] == 5 and versions["gc_mode"] == "report_only"
assert len(versions["versions"]) == 6
oldest = versions["versions"][-1]
assert oldest["version_id"] == version_a and not oldest["deployable"] and oldest["active"]
assert oldest["gc_status"] == "retained" and "active_deployment" in oldest["retention_reasons"]

status, expired = request(
    "POST",
    endpoint + "/deployments",
    {"strategy": "percentage", "versions": [{"version_id": version_a, "percentage": 100}]},
)
assert status == 409 and expired["code"] == "version_not_deployable", (status, expired)

status, worker = request(
    "POST",
    endpoint + "/deployments",
    {
        "strategy": "percentage",
        "versions": [{"version_id": version_b, "percentage": 100}],
        "annotations": {
            "workers/message": "Rollback after retention smoke test",
            "workers/triggered_by": "rollback",
        },
    },
)
assert status == 201, (status, worker)
active_deployment_id = worker["deployment"]["id"]

status, deployments = request("GET", endpoint + "/deployments")
assert status == 200 and [item["id"] for item in deployments["deployments"]] == [active_deployment_id, deployment_id]
assert deployments["deployments"][0]["active"]
assert deployments["deployments"][0]["source"] == "api"
assert deployments["deployments"][0]["annotations"]["workers/triggered_by"] == "rollback"
assert not deployments["deployments"][1]["rollback_available"]

status, active = request("GET", endpoint)
assert status == 200 and active["deployment"]["id"] == active_deployment_id
assert [item["version_id"] for item in active["versions"]] == [version_b]
version_a_url = base + f"/internal/v1/namespaces/default/workers/hello/versions/{version_a}"
status, old = request("GET", version_a_url)
assert status == 200 and "Response('a')" in old["content"]["modules"]["main.js"]

durable_endpoint = base + "/v1/namespaces/default/workers/durable"
status, durable_version = request(
    "POST",
    durable_endpoint + "/versions",
    {
        "main_module": "main.js",
        "modules": {"main.js": "export class Counter {}; export default {}"},
        "compatibility_date": "2026-08-14",
        "durable_objects": {"COUNTER": "Counter"},
    },
)
assert status == 201, (status, durable_version)
assert durable_version["durable_object_namespaces"][0]["class_name"] == "Counter"
status, durable_worker = request(
    "POST",
    durable_endpoint + "/deployments",
    {
        "strategy": "percentage",
        "versions": [{"version_id": durable_version["version_id"], "percentage": 100}],
    },
)
assert status == 201, (status, durable_worker)

print(json.dumps({
    "active_deployment_id": active_deployment_id,
    "historical_deployment_id": deployment_id,
    "version_a": version_a,
    "version_b": version_b,
}, sort_keys=True))
