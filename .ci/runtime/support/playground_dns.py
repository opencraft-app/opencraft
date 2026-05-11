"""DNSPod helpers for playground environment public endpoints."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable


DEFAULT_DOMAIN = "lightclaw.tech"
DEFAULT_ENDPOINT = "dnspod.tencentcloudapi.com"
DEFAULT_VERSION = "2021-03-23"
DEFAULT_RECORD_LINE = "默认"


@dataclass(frozen=True)
class DnsRecord:
    host: str
    value: str
    record_type: str

    @property
    def key(self) -> tuple[str, str]:
        return (self.host, self.record_type)


class TencentCloudClient:
    def __init__(
        self,
        *,
        secret_id: str,
        secret_key: str,
        endpoint: str = DEFAULT_ENDPOINT,
        version: str = DEFAULT_VERSION,
        region: str = "",
    ) -> None:
        self.secret_id = secret_id
        self.secret_key = secret_key
        self.endpoint = endpoint
        self.version = version
        self.region = region

    def call(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = int(time.time())
        date = dt.datetime.fromtimestamp(timestamp, dt.UTC).strftime("%Y-%m-%d")
        service = self.endpoint.split(".", 1)[0]

        canonical_headers = (
            "content-type:application/json; charset=utf-8\n"
            f"host:{self.endpoint}\n"
            f"x-tc-action:{action.lower()}\n"
        )
        signed_headers = "content-type;host;x-tc-action"
        canonical_request = "\n".join(
            [
                "POST",
                "/",
                "",
                canonical_headers,
                signed_headers,
                hashlib.sha256(body.encode()).hexdigest(),
            ]
        )
        credential_scope = f"{date}/{service}/tc3_request"
        string_to_sign = "\n".join(
            [
                "TC3-HMAC-SHA256",
                str(timestamp),
                credential_scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )

        secret_date = hmac.new(("TC3" + self.secret_key).encode(), date.encode(), hashlib.sha256).digest()
        secret_service = hmac.new(secret_date, service.encode(), hashlib.sha256).digest()
        secret_signing = hmac.new(secret_service, b"tc3_request", hashlib.sha256).digest()
        signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

        headers = {
            "Authorization": (
                "TC3-HMAC-SHA256 "
                f"Credential={self.secret_id}/{credential_scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            ),
            "Content-Type": "application/json; charset=utf-8",
            "Host": self.endpoint,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": self.version,
        }
        if self.region:
            headers["X-TC-Region"] = self.region

        req = urllib.request.Request(
            f"https://{self.endpoint}",
            data=body.encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                response = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Tencent Cloud API {action} failed: HTTP {exc.code}: {detail}") from exc

        result = response.get("Response", response)
        if "Error" in result:
            error = result["Error"]
            raise RuntimeError(
                f"Tencent Cloud API {action} failed: {error.get('Code')}: {error.get('Message')}"
            )
        return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upsert DNSPod records for a playground environment.")
    parser.add_argument("--env", required=True, help="Playground env name, for example sandbox-bj-4.")
    parser.add_argument("--domain", default=DEFAULT_DOMAIN)
    parser.add_argument("--namespace", help="Kubernetes namespace. Defaults to lightvela-playground-<env>.")
    parser.add_argument("--kubeconfig", help="Discover ingress hosts and targets from this kubeconfig.")
    parser.add_argument("--record", action="append", default=[], help="Explicit host=target record. Can repeat.")
    parser.add_argument(
        "--include-env-root",
        action="store_true",
        help="Also point <env>.<domain> to the wildcard sandbox ingress target when available.",
    )
    parser.add_argument("--record-line", default=DEFAULT_RECORD_LINE)
    parser.add_argument("--ttl", type=int, default=600)
    parser.add_argument("--dry-run", action="store_true", help="Print changes without calling DNSPod.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--region", default=os.environ.get("TENCENTCLOUD_REGION", ""))
    return parser.parse_args(argv)


def env_credentials() -> tuple[str, str]:
    secret_id = os.environ.get("TENCENTCLOUD_SECRET_ID", "").strip()
    secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY", "").strip()
    if not secret_id or not secret_key:
        raise SystemExit("missing Tencent Cloud credentials; set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY")
    return secret_id, secret_key


def record_type_for_value(value: str) -> str:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return "CNAME"
    return "A"


def normalize_target(value: str, record_type: str) -> str:
    value = value.strip().rstrip(".")
    if not value:
        raise ValueError("empty DNS target")
    if record_type == "CNAME" and is_ip(value):
        raise ValueError(f"CNAME target must not be an IP address: {value}")
    return value


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def host_to_subdomain(host: str, domain: str) -> str:
    suffix = "." + domain
    if host == domain:
        return "@"
    if not host.endswith(suffix):
        raise ValueError(f"host {host!r} is not under domain {domain!r}")
    return host[: -len(suffix)]


def parse_record_spec(spec: str) -> DnsRecord:
    if "=" not in spec:
        raise ValueError(f"invalid --record {spec!r}; expected host=target")
    host, value = (part.strip() for part in spec.split("=", 1))
    record_type = record_type_for_value(value)
    return DnsRecord(host=host, value=normalize_target(value, record_type), record_type=record_type)


def discover_ingress_records(kubeconfig: str, namespace: str) -> list[DnsRecord]:
    result = subprocess.run(
        [
            "kubectl",
            "--request-timeout=30s",
            "--kubeconfig",
            kubeconfig,
            "-n",
            namespace,
            "get",
            "ingress",
            "-o",
            "json",
        ],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    payload = json.loads(result.stdout)
    records: list[DnsRecord] = []
    for item in payload.get("items", []):
        ingresses = item.get("status", {}).get("loadBalancer", {}).get("ingress", [])
        if not ingresses:
            continue
        target = ingresses[0].get("hostname") or ingresses[0].get("ip")
        if not target:
            continue
        record_type = record_type_for_value(target)
        for rule in item.get("spec", {}).get("rules", []):
            host = str(rule.get("host") or "").strip()
            if host and host != "*":
                records.append(DnsRecord(host=host, value=normalize_target(target, record_type), record_type=record_type))
    return records


def with_env_root(records: list[DnsRecord], env: str, domain: str) -> list[DnsRecord]:
    wildcard_host = f"*.{env}.{domain}"
    root_host = f"{env}.{domain}"
    if any(record.host == root_host for record in records):
        return records
    wildcard = next((record for record in records if record.host == wildcard_host), None)
    if wildcard is None:
        return records
    return [*records, DnsRecord(root_host, wildcard.value, wildcard.record_type)]


def dedupe_records(records: Iterable[DnsRecord]) -> list[DnsRecord]:
    deduped: dict[tuple[str, str], DnsRecord] = {}
    for record in records:
        deduped[record.key] = record
    return [deduped[key] for key in sorted(deduped)]


def find_existing_record(
    client: TencentCloudClient,
    *,
    domain: str,
    subdomain: str,
    record_type: str,
) -> dict[str, Any] | None:
    try:
        response = client.call(
            "DescribeRecordList",
            {
                "Domain": domain,
                "Subdomain": subdomain,
                "RecordType": record_type,
                "Limit": 100,
            },
        )
    except RuntimeError as exc:
        if "ResourceNotFound.NoDataOfRecord" in str(exc):
            return None
        raise
    for record in response.get("RecordList", []):
        if str(record.get("Name")) == subdomain and str(record.get("Type")) == record_type:
            return record
    return None


def upsert_record(
    client: TencentCloudClient,
    *,
    domain: str,
    subdomain: str,
    record: DnsRecord,
    record_line: str,
    ttl: int,
) -> str:
    existing = find_existing_record(client, domain=domain, subdomain=subdomain, record_type=record.record_type)
    if existing is None:
        client.call(
            "CreateRecord",
            {
                "Domain": domain,
                "SubDomain": subdomain,
                "RecordType": record.record_type,
                "RecordLine": record_line,
                "Value": record.value,
                "TTL": ttl,
            },
        )
        return "created"
    if str(existing.get("Value", "")).rstrip(".") == record.value:
        return "unchanged"
    client.call(
        "ModifyRecord",
        {
            "Domain": domain,
            "RecordId": int(existing["RecordId"]),
            "SubDomain": subdomain,
            "RecordType": record.record_type,
            "RecordLine": record_line,
            "Value": record.value,
            "TTL": ttl,
        },
    )
    return "updated"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    namespace = args.namespace or f"lightvela-playground-{args.env}"
    records = [parse_record_spec(spec) for spec in args.record]
    if args.kubeconfig:
        records.extend(discover_ingress_records(args.kubeconfig, namespace))
    if args.include_env_root:
        records = with_env_root(records, args.env, args.domain)
    records = dedupe_records(records)
    if not records:
        raise SystemExit("no DNS records to upsert; pass --kubeconfig or --record host=target")

    print(f"Playground DNS 配置：env={args.env} domain={args.domain} records={len(records)}")
    for record in records:
        subdomain = host_to_subdomain(record.host, args.domain)
        print(f"- {record.record_type} {subdomain} -> {record.value}")

    if args.dry_run:
        print("dry-run：未调用 DNSPod。")
        return 0

    secret_id, secret_key = env_credentials()
    client = TencentCloudClient(
        secret_id=secret_id,
        secret_key=secret_key,
        endpoint=args.endpoint,
        region=args.region,
    )
    for record in records:
        subdomain = host_to_subdomain(record.host, args.domain)
        status = upsert_record(
            client,
            domain=args.domain,
            subdomain=subdomain,
            record=record,
            record_line=args.record_line,
            ttl=args.ttl,
        )
        print(f"{status}: {record.record_type} {subdomain} -> {record.value}")
    return 0
