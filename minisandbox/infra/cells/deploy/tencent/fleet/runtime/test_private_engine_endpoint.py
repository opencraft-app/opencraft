from pathlib import Path


SCRIPT = Path(__file__).with_name("install-private-engine-endpoint.sh").read_text()


def test_private_endpoint_is_identity_and_source_bounded() -> None:
    assert "RIVET_CELL_NAME:?" in SCRIPT
    assert "RIVET_DATACENTER_NAME:?" in SCRIPT
    assert "RIVET_ENGINE_PRIVATE_SUBNET_ID:?" in SCRIPT
    assert "RIVET_ENGINE_HUB_CIDRS:?" in SCRIPT
    assert '"loadBalancerSourceRanges": cidrs' in SCRIPT
    assert "network.is_private" in SCRIPT
    assert '"type": "LoadBalancer"' in SCRIPT
    assert '"service.cloud.tencent.com/loadbalance-retain": "true"' in SCRIPT


def test_receipt_intersects_live_cell_and_service_identity() -> None:
    assert '"schema": "actor-engine-private-endpoint/v1"' in SCRIPT
    assert 'cell_object["metadata"]["uid"]' in SCRIPT
    assert '"uid": metadata["uid"]' in SCRIPT
    assert '"resourceVersion": metadata["resourceVersion"]' in SCRIPT
    assert "os.link(temporary, output)" in SCRIPT
