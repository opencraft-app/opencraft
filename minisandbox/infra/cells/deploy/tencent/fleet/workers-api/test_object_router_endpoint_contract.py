#!/usr/bin/env python3
from pathlib import Path


SCRIPT = Path(__file__).with_name("install-private-object-router-endpoint.sh").read_text()


def test_object_router_endpoint_is_private_identity_bound_and_not_public_api() -> None:
    for guard in (
        "workers-object-router-private",
        "workers-object-router",
        'targetPort":"object-router"',
        "ACTOR_OBJECT_ROUTER_SOURCE_CIDRS",
        "ACTOR_OBJECT_ROUTER_SECURITY_GROUP_ID",
        "loadBalancerSourceRanges",
        "ipaddress.ip_address(endpoint).is_private",
        "actor-object-router-private-endpoint/v1",
        'f"{endpoint}:{listener_port}"',
        '"unauthenticatedStatus":404',
        "HPA-managed replica target Ready",
        "Object Router Service has fewer than three Ready endpoints",
        '"readyReplicas":deployment["status"]["readyReplicas"]',
    ):
        assert guard in SCRIPT, guard
    assert "0.0.0.0/0" not in SCRIPT
    assert 'targetPort":"http"' not in SCRIPT


if __name__ == "__main__":
    test_object_router_endpoint_is_private_identity_bound_and_not_public_api()
