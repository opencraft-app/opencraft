#!/usr/bin/env python3
import json
import sys
import urllib.error
import urllib.request

base, version_a, version_b, active_deployment_id, historical_deployment_id = (
    sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
)
worker_url = base + "/v1/namespaces/default/workers/hello"


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def delete(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="DELETE"), timeout=10) as response:
            content = response.read()
            return response.status, None if not content else json.loads(content)
    except urllib.error.HTTPError as error:
        content = error.read()
        return error.code, None if not content else json.loads(content)


status, active = get(worker_url)
assert status == 200 and active["deployment"]["id"] == active_deployment_id
assert [item["version_id"] for item in active["versions"]] == [version_b]
status, deployments = get(worker_url + "/deployments")
assert status == 200
assert [item["id"] for item in deployments["deployments"]] == [active_deployment_id, historical_deployment_id]
assert deployments["deployments"][0]["active"] and not deployments["deployments"][1]["rollback_available"]
assert deployments["deployments"][0]["annotations"]["workers/triggered_by"] == "rollback"
status, versions = get(worker_url + "/versions?per_page=10")
assert status == 200 and len(versions["versions"]) == 6
oldest = versions["versions"][-1]
assert oldest["version_id"] == version_a and not oldest["deployable"]
assert oldest["gc_status"] == "candidate_report_only"
status, error = delete(worker_url + "/deployments/" + active_deployment_id)
assert status == 409 and error["code"] == "active_deployment", (status, error)
status, _ = delete(worker_url + "/deployments/" + historical_deployment_id)
assert status == 204
status, _ = get(worker_url + "/deployments/" + historical_deployment_id)
assert status == 404
status, old = get(base + f"/internal/v1/namespaces/default/workers/hello/versions/{version_a}")
assert status == 200 and old["version_id"] == version_a
status, error = delete(base + "/v1/namespaces/default/workers/durable")
assert status == 409 and error["code"] == "durable_object_namespaces", (status, error)

request = urllib.request.Request(worker_url, method="DELETE")
with urllib.request.urlopen(request, timeout=10) as response:
    assert response.status == 204
status, _ = get(worker_url)
assert status == 404
status, old = get(base + f"/internal/v1/namespaces/default/workers/hello/versions/{version_a}")
assert status == 200 and old["version_id"] == version_a
print(json.dumps({"active_deleted": True, "retained_report_only_candidate": version_a}, sort_keys=True))
