#!/usr/bin/env python3
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


def alert_expressions() -> dict[str, str]:
    document = yaml.safe_load((ROOT / "actor-rules.yaml").read_text())
    return {
        rule["alert"]: rule["expr"]
        for group in document["spec"]["groups"]
        for rule in group["rules"]
        if "alert" in rule
    }


def test_shared_rules_discover_cells_dynamically() -> None:
    expressions = alert_expressions()
    rules_text = (ROOT / "actor-rules.yaml").read_text()
    verify_text = (ROOT / "verify.sh").read_text()

    assert "actor-bj-k01" not in rules_text
    assert "actor-bj-k01" not in verify_text
    assert 'service=~".+-fdb-backup-metrics"' in expressions["ActorFDBBackupMetricsDown"]
    assert "kube_statefulset_replicas" in expressions["ActorWorkerdMetricsTargetDown"]
    assert 'service=~".+-runtime-hosts"' in expressions["ActorWorkerdMetricsTargetDown"]
    assert "kube_deployment_spec_replicas" in expressions["ActorEngineMetricsTargetDown"]
    assert 'service=~".+-runtime-hosts"' in expressions["ActorRuntimeZoneSkew"]
    assert "expected_cells" in verify_text
    assert "deficient_cells" in verify_text


def test_memory_forecast_requires_material_current_utilization() -> None:
    expressions = alert_expressions()
    expression = expressions["ActorContainerMemoryCapacityWithin72Hours"]

    # A small positive slope while a process is warming caches must not predict
    # an OOM from an almost-empty container.  Once RSS reaches half the limit,
    # a 72-hour exhaustion forecast still leaves ample operator lead time.
    assert "actor:container_memory_utilization:ratio >= 0.5" in expression


if __name__ == "__main__":
    test_shared_rules_discover_cells_dynamically()
