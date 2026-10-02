#!/usr/bin/env python3
"""Render bounded, identity-fenced Prometheus federation scrape jobs."""

from __future__ import annotations

import argparse
import ipaddress
import re
from pathlib import Path
from typing import Any

import yaml


CLUSTER_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
HOST_PORT_RE = re.compile(r"(?P<host>\[[0-9a-fA-F:]+\]|[^:/\s]+):(?P<port>[0-9]{1,5})")
ALLOWED_KEYS = {"cluster", "region", "address", "scheme", "privateEndpoint", "tlsServerName"}
FEDERATED_METRICS = '{__name__=~"actor_fleet:(cell|compute_node)_.*"}'


class ConfigurationError(ValueError):
    pass


def _private_address(address: str) -> bool:
    match = HOST_PORT_RE.fullmatch(address)
    if not match:
        raise ConfigurationError(f"address must be host:port without a URL path: {address!r}")
    port = int(match.group("port"))
    if not 1 <= port <= 65535:
        raise ConfigurationError(f"address port is invalid: {address!r}")
    host = match.group("host").strip("[]")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # DNS is resolved in the Hub network. The explicit privateEndpoint bit
        # is still mandatory because a name alone cannot prove reachability.
        return host not in {"localhost"} and "." in host
    return ip.is_private and not ip.is_loopback and not ip.is_unspecified


def render(document: dict[str, Any]) -> dict[str, Any]:
    if document.get("apiVersion") != "fleet.actor.dev/v1alpha1" or document.get("kind") != "PrometheusFederationTargets":
        raise ConfigurationError("targets must use fleet.actor.dev/v1alpha1 PrometheusFederationTargets")
    targets = document.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ConfigurationError("targets must be a non-empty list")

    clusters: set[str] = set()
    addresses: set[str] = set()
    jobs: list[dict[str, Any]] = []
    for target in targets:
        if not isinstance(target, dict):
            raise ConfigurationError("each target must be an object")
        unknown = set(target) - ALLOWED_KEYS
        if unknown:
            raise ConfigurationError(f"target has unknown fields: {sorted(unknown)}")
        cluster = target.get("cluster")
        region = target.get("region")
        address = target.get("address")
        scheme = target.get("scheme", "https")
        if not isinstance(cluster, str) or not CLUSTER_RE.fullmatch(cluster):
            raise ConfigurationError(f"invalid cluster identity: {cluster!r}")
        if not isinstance(region, str) or not CLUSTER_RE.fullmatch(region):
            raise ConfigurationError(f"invalid region identity: {region!r}")
        if cluster in clusters:
            raise ConfigurationError(f"duplicate cluster identity: {cluster}")
        if not isinstance(address, str) or not _private_address(address):
            raise ConfigurationError(f"federation endpoint is not private: {address!r}")
        if address in addresses:
            raise ConfigurationError(f"duplicate federation address: {address}")
        if target.get("privateEndpoint") is not True:
            raise ConfigurationError(f"cluster {cluster} must explicitly assert privateEndpoint: true")
        if scheme not in {"http", "https"}:
            raise ConfigurationError(f"cluster {cluster} has unsupported scheme {scheme!r}")

        job: dict[str, Any] = {
            "job_name": f"actor-cell-federation-{cluster}",
            "honor_labels": False,
            "scheme": scheme,
            "metrics_path": "/federate",
            "scrape_interval": "30s",
            "scrape_timeout": "10s",
            "params": {"match[]": [FEDERATED_METRICS]},
            "static_configs": [{
                "targets": [address],
                "labels": {"federation": "actor-cell", "cluster": cluster, "region": region},
            }],
            "metric_relabel_configs": [
                {"source_labels": ["__name__"], "regex": "actor_fleet:(cell|compute_node)_.*", "action": "keep"},
                {"regex": "exported_(cluster|region)", "action": "labeldrop"},
            ],
        }
        tls_server_name = target.get("tlsServerName")
        if tls_server_name is not None:
            if scheme != "https" or not isinstance(tls_server_name, str) or not tls_server_name:
                raise ConfigurationError(f"cluster {cluster} has an invalid tlsServerName")
            job["tls_config"] = {"server_name": tls_server_name, "insecure_skip_verify": False}
        clusters.add(cluster)
        addresses.add(address)
        jobs.append(job)

    return {"prometheus": {"prometheusSpec": {"additionalScrapeConfigs": jobs}}}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    document = yaml.safe_load(args.targets.read_text())
    if not isinstance(document, dict):
        raise SystemExit("targets document must be an object")
    try:
        rendered = render(document)
    except ConfigurationError as exc:
        raise SystemExit(str(exc)) from exc
    args.output.write_text(yaml.safe_dump(rendered, sort_keys=False))


if __name__ == "__main__":
    main()
