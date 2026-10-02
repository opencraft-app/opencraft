#!/usr/bin/env python3
"""Evaluate an autonomy-audit receipt against a deterministic control policy.

This script keeps the control loop machine-readable: it emits a compact JSON plan
that can be consumed by schedulers, controllers, or humans.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
import fnmatch


def _matches_pattern(pattern: str, candidate: str) -> bool:
    if pattern == candidate:
        return True
    if candidate.startswith(f"{pattern}="):
        return True
    if pattern.endswith("*") or "*" in pattern or "?" in pattern or "[" in pattern:
        return fnmatch.fnmatch(candidate, pattern)
    return False


def _contains_any(items: List[str], needle_list: List[str]) -> bool:
    return any(_matches_pattern(needle, item) for needle in needle_list for item in items)


def _extract_alert_names(payload: Dict[str, Any]) -> List[str]:
    alerts = payload.get("prometheus", {}).get("alerts", {})
    if not isinstance(alerts, dict):
        return []
    names = []
    for alert in alerts.get("firing", []) or []:
        if isinstance(alert, dict):
            alert_name = alert.get("alert")
            if isinstance(alert_name, str):
                names.append(alert_name)
    return names


def _rule_matches(
    rule: Dict[str, Any], receipt: Dict[str, Any], warnings: List[str], failures: List[str], alert_names: List[str]
) -> bool:
    match = rule.get("match", {})
    if not isinstance(match, dict):
        return False

    for key, expected in match.items():
        if isinstance(expected, str):
            if str(receipt.get(key, "")) != expected:
                return False
            continue
        if isinstance(expected, list):
            if key == "warning":
                if not _contains_any(warnings + alert_names, expected):
                    return False
            elif key == "failure":
                if not _contains_any(failures, expected):
                    return False
            else:
                actual = receipt.get(key, [])
                if not isinstance(actual, list):
                    return False
                if not any(item in actual for item in expected):
                    return False
            continue
        return False
    return True


def _default_policy() -> Dict[str, Any]:
    return {
        "policy_version": "autonomy-control-policy-v1",
        "version": "2026-08-20",
        "rules": [
            {
                "name": "block-on-failed-verdict",
                "match": {"verdict": "failed"},
                "actions": [
                    "stop_scale_traffic_sensitive_workflows",
                    "block_rollout_or_qualification",
                    "open_incident_and_page",
                ],
                "notes": "failed 状态下不允许执行高风险动作。",
            },
            {
                "name": "warn-on-coverage-loss",
                "match": {
                    "failure": [
                        "fdb_pods_ready_below_3",
                        "engine_not_in_three_zones",
                        "runtime_not_in_three_zones",
                        "fdb_not_in_three_zones",
                        "prometheus_critical_alerts_exist",
                    ]
                },
                "actions": [
                    "enter_reduced_admission",
                    "run_topology_recheck",
                    "require_operator_review",
                ],
                "notes": "关键基础设施健康失败时，优先处理基础设施而不是流量侧。"
            },
            {
                "name": "warn-on-warn-state",
                "match": {"warning": ["prometheus_warning_alerts_exist"]},
                "actions": [
                    "monitor_root_cause_more_frequently",
                    "consider_rate_reduction",
                ],
                "notes": "告警为 warning 时做降压而非扩张。"
            },
        ],
    }


def load_policy(path: Optional[Path]) -> Dict[str, Any]:
    if not path:
        return _default_policy()
    content = json.loads(path.read_text())
    if not isinstance(content, dict) or "rules" not in content:
        raise ValueError("invalid policy file")
    return content


def evaluate(receipt_path: str, receipt_sha256: str, receipt: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    verdict = str(receipt.get("verdict", "unknown"))
    warnings = receipt.get("warnings", [])
    failures = receipt.get("failures", [])
    if not isinstance(warnings, list):
        warnings = []
    if not isinstance(failures, list):
        failures = []
    alert_names = _extract_alert_names(receipt)

    actions = []
    matches = []
    for rule in policy.get("rules", []):
        if _rule_matches(rule, receipt, warnings, failures, alert_names):
            for action in rule.get("actions", []):
                if action not in actions:
                    actions.append(action)
            matches.append({
                "rule": rule.get("name"),
                "notes": rule.get("notes"),
            })

    if verdict == "passed" and not failures and not warnings:
        control = "allow"
    elif verdict == "failed" or any(x.get("rule") == "block-on-failed-verdict" for x in matches):
        control = "block"
    elif verdict == "warning" or warnings:
        control = "degrade"
    else:
        control = "unknown"

    return {
        "schemaVersion": "actor-fdb-autonomy-control-v1",
        "policy_version": policy.get("policy_version", "unknown"),
        "control": control,
        "verdict": verdict,
        "cell": receipt.get("cell"),
        "namespace": receipt.get("namespace"),
        "timestamp": receipt.get("timestamp"),
        "actions": actions,
        "matched_rules": matches,
        "autonomy_score": receipt.get("autonomy_score"),
        "warnings": warnings,
        "failures": failures,
        "source_receipt": str(receipt_path),
        "source_receipt_sha256": receipt_sha256,
        "sourceIdentity": receipt.get("sourceIdentity"),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate autonomy audit receipt with policy.")
    parser.add_argument("receipt", help="Path to autonomy-audit receipt JSON")
    parser.add_argument("--policy", default="", help="Path to policy JSON")
    parser.add_argument("--output", default="", help="Write control decision JSON to this path")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args()

    receipt_path = Path(args.receipt)
    if not receipt_path.is_file():
        raise SystemExit(f"receipt not found: {receipt_path}")
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    policy = load_policy(Path(args.policy) if args.policy else None)

    decision = evaluate(str(receipt_path), hashlib.sha256(receipt_bytes).hexdigest(), receipt, policy)
    payload = json.dumps(decision, indent=(2 if args.pretty else None), ensure_ascii=False, sort_keys=True)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n")
    print(payload)
    if decision["control"] == "block":
        raise SystemExit(2)
    if decision["control"] == "degrade":
        raise SystemExit(1)
    raise SystemExit(0)
