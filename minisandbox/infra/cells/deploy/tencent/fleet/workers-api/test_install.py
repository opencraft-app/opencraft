from pathlib import Path


SCRIPT = Path(__file__).with_name("install.sh").read_text()


def test_install_uses_two_cell_scoped_tokens_without_printing_them() -> None:
    assert "ACTOR_WORKERS_API_CREDENTIAL_RECEIPT:?" in SCRIPT
    assert "actor-workers-api-credential-sync/v1" in SCRIPT
    assert "live Workers API credential differs from its synchronization receipt" in SCRIPT
    assert "live Workers API capability fingerprint differs" in SCRIPT
    assert "kubectl --kubeconfig \"$hub\" -n \"$namespace\" get secret" in SCRIPT
    assert "create secret" not in SCRIPT
    assert "delete secret" not in SCRIPT
    assert "cat $temporary/token" not in SCRIPT


def test_install_fails_closed_before_public_readiness() -> None:
    assert "manifest differs from its render receipt" in SCRIPT
    assert "render does not bind the supplied credential receipt" in SCRIPT
    assert "complete HPA-managed replica set Ready" in SCRIPT
    assert "three-node HA floor" in SCRIPT
    assert "live image differs" in SCRIPT
    assert "/readyz" in SCRIPT
    assert '"schema":"actor-workers-api-installation/v1"' in SCRIPT


if __name__ == "__main__":
    test_install_uses_two_cell_scoped_tokens_without_printing_them()
    test_install_fails_closed_before_public_readiness()
