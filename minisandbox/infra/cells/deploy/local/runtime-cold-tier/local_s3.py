#!/usr/bin/env python3
"""Persistent local S3 protocol double for Depot cold objects."""

import base64
import bisect
import hashlib
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape


ROOT = Path(os.environ.get("LOCAL_S3_ROOT", "/data/objects"))
BUCKETS = frozenset(
    value.strip()
    for value in os.environ.get(
        "LOCAL_S3_BUCKETS", "local-runtime-a-cold,local-runtime-b-cold"
    ).split(",")
    if value.strip()
)
MAX_OBJECT_BYTES = int(os.environ.get("LOCAL_S3_MAX_OBJECT_BYTES", str(4 << 20)))
PORT = int(os.environ.get("LOCAL_S3_PORT", "8080"))
ADMIN_TOKEN = os.environ.get("LOCAL_S3_ADMIN_TOKEN", "")
FAULTS: dict[str, dict[str, int | None]] = {}
FAULTS_LOCK = threading.Lock()
MUTATION_LOCK = threading.Lock()
STATS_LOCK = threading.Lock()
REQUEST_STATS: dict[str, dict[str, dict[str, int]]] = {}
GATE_CONDITION = threading.Condition()
GATES: dict[str, dict[str, int | bool]] = {}


def _send(
    handler: BaseHTTPRequestHandler,
    status: int,
    body: bytes = b"",
    content_type: str | None = None,
    headers: dict[str, str] | None = None,
) -> None:
    metric = getattr(handler, "_metric", None)
    if metric is not None and not metric.get("finished", False):
        metric["finished"] = True
        elapsed_us = max(0, int((time.monotonic() - metric["started"]) * 1_000_000))
        with STATS_LOCK:
            operation = REQUEST_STATS.setdefault(metric["bucket"], {}).setdefault(
                metric["operation"],
                {
                    "requests": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "request_bytes": 0,
                    "response_bytes": 0,
                    "active": 0,
                    "max_active": 0,
                    "latency_us": 0,
                },
            )
            operation["succeeded" if 200 <= status < 400 else "failed"] += 1
            operation["request_bytes"] += int(metric.get("request_bytes", 0))
            operation["response_bytes"] += len(body)
            operation["latency_us"] += elapsed_us
            operation["active"] = max(0, operation["active"] - 1)
    handler.send_response(status)
    if content_type:
        handler.send_header("Content-Type", content_type)
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    if not headers or "Content-Length" not in headers:
        handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if body and handler.command != "HEAD":
        handler.wfile.write(body)


def _s3_error(handler: BaseHTTPRequestHandler, status: int, code: str, message: str) -> None:
    body = (
        f"<Error><Code>{code}</Code><Message>{message}</Message>"
        f"<RequestId>local</RequestId></Error>"
    ).encode()
    _send(
        handler,
        status,
        body,
        "application/xml",
        {"x-amz-error-code": code, "x-amz-error-message": message},
    )


def _require_admin(handler: BaseHTTPRequestHandler) -> bool:
    supplied = handler.headers.get("X-Local-S3-Admin-Token", "")
    if ADMIN_TOKEN and secrets.compare_digest(supplied, ADMIN_TOKEN):
        return True
    _send(handler, 403, b"admin token required")
    return False


def _parse_object(request_path: str) -> tuple[str, str]:
    path = unquote(urlsplit(request_path).path)
    parts = path.lstrip("/").split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("path must contain a bucket and object key")
    bucket, key = parts
    if bucket not in BUCKETS:
        raise LookupError(bucket)
    return bucket, key


def _metadata_path(bucket: str, key: str) -> Path:
    digest = hashlib.sha256(key.encode()).hexdigest()
    return ROOT / "buckets" / bucket / digest[:2] / f"{digest[2:]}.json"


def _blob_path(digest: str) -> Path:
    return ROOT / "blobs" / digest[:2] / digest[2:]


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _install_immutable(path: Path, content: bytes) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            return False
        _fsync_directory(path.parent)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def _replace_durable(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _load_metadata(bucket: str, key: str) -> dict:
    metadata_path = _metadata_path(bucket, key)
    try:
        metadata = json.loads(metadata_path.read_text())
    except FileNotFoundError:
        raise
    except (OSError, ValueError) as error:
        raise RuntimeError("invalid object metadata") from error
    if metadata.get("key") != key:
        raise RuntimeError("object metadata key mismatch")
    return metadata


def _load_verified_object(bucket: str, key: str) -> tuple[dict, bytes]:
    metadata = _load_metadata(bucket, key)
    try:
        content = _blob_path(metadata["sha256"]).read_bytes()
    except (KeyError, FileNotFoundError) as error:
        raise RuntimeError("object blob is missing") from error
    actual = hashlib.sha256(content).hexdigest()
    if actual != metadata.get("sha256") or len(content) != metadata.get("size"):
        raise RuntimeError("object hash or size mismatch")
    return metadata, content


def _list_bucket(bucket: str, prefix: str, cursor: str | None, limit: int) -> tuple[list[dict], str | None]:
    root = ROOT / "buckets" / bucket
    objects = []
    for path in root.glob("*/*.json") if root.exists() else ():
        try:
            metadata = json.loads(path.read_text())
            key = metadata["key"]
            if not isinstance(key, str) or _metadata_path(bucket, key) != path:
                raise RuntimeError("object metadata key mismatch")
            if key.startswith(prefix):
                objects.append(metadata)
        except (OSError, ValueError, KeyError) as error:
            raise RuntimeError("invalid object metadata") from error
    objects.sort(key=lambda value: value["key"])
    keys = [value["key"] for value in objects]
    start = bisect.bisect_right(keys, cursor) if cursor is not None else 0
    selected = objects[start : start + limit]
    next_cursor = selected[-1]["key"] if start + len(selected) < len(objects) else None
    return selected, next_cursor


def _encode_cursor(key: str) -> str:
    return base64.urlsafe_b64encode(key.encode()).decode().rstrip("=")


def _decode_cursor(token: str) -> str:
    try:
        return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid continuation token") from error


def _list_xml(bucket: str, prefix: str, limit: int, objects: list[dict], next_cursor: str | None) -> bytes:
    contents = "".join(
        "<Contents>"
        f"<Key>{escape(value['key'])}</Key>"
        "<LastModified>1970-01-01T00:00:00.000Z</LastModified>"
        f"<ETag>&quot;{escape(value['etag'])}&quot;</ETag>"
        f"<Size>{int(value['size'])}</Size>"
        "<StorageClass>STANDARD</StorageClass>"
        "</Contents>"
        for value in objects
    )
    next_token = (
        f"<NextContinuationToken>{_encode_cursor(next_cursor)}</NextContinuationToken>"
        if next_cursor is not None
        else ""
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<Name>{escape(bucket)}</Name><Prefix>{escape(prefix)}</Prefix>"
        f"<KeyCount>{len(objects)}</KeyCount><MaxKeys>{limit}</MaxKeys>"
        f"<IsTruncated>{str(next_cursor is not None).lower()}</IsTruncated>"
        f"{contents}{next_token}</ListBucketResult>"
    ).encode()


def _referenced_digests() -> set[str]:
    referenced = set()
    buckets_root = ROOT / "buckets"
    for path in buckets_root.glob("*/*/*.json") if buckets_root.exists() else ():
        try:
            metadata = json.loads(path.read_text())
            digest = metadata["sha256"]
            if isinstance(digest, str):
                referenced.add(digest)
        except (OSError, ValueError, KeyError):
            continue
    return referenced


def _garbage_collect_blobs() -> None:
    referenced = _referenced_digests()
    blobs_root = ROOT / "blobs"
    for path in blobs_root.glob("*/*") if blobs_root.exists() else ():
        if path.is_file() and path.parent.name + path.name not in referenced:
            path.unlink(missing_ok=True)


def _fault(operation: str) -> tuple[int, int] | None:
    with FAULTS_LOCK:
        fault = FAULTS.get(operation)
        if fault is None:
            return None
        skip = int(fault.get("skip") or 0)
        if skip > 0:
            fault["skip"] = skip - 1
            return None
        remaining = fault.get("remaining")
        if remaining is not None:
            if int(remaining) <= 0:
                FAULTS.pop(operation, None)
                return None
            fault["remaining"] = int(remaining) - 1
        return int(fault["status"]), int(fault.get("delay_ms") or 0)


def _maybe_fail(handler: BaseHTTPRequestHandler, operation: str) -> bool:
    fault = _fault(operation)
    if fault is None:
        return False
    status, delay_ms = fault
    if delay_ms:
        time.sleep(delay_ms / 1000)
    _s3_error(handler, status, "ServiceUnavailable", f"injected {operation} failure")
    return True


def _maybe_gate(point: str) -> None:
    with GATE_CONDITION:
        gate = GATES.get(point)
        if gate is None or not gate.get("enabled", False):
            return
        gate["waiting"] = int(gate.get("waiting", 0)) + 1
        GATE_CONDITION.notify_all()
        try:
            while gate.get("enabled", False):
                GATE_CONDITION.wait(timeout=1)
        finally:
            gate["waiting"] = max(0, int(gate.get("waiting", 0)) - 1)


def _admin_stats() -> dict:
    with MUTATION_LOCK:
        result = {}
        for bucket in sorted(BUCKETS):
            count = 0
            size = 0
            root = ROOT / "buckets" / bucket
            for path in root.glob("*/*.json") if root.exists() else ():
                try:
                    metadata = json.loads(path.read_text())
                    count += 1
                    size += int(metadata["size"])
                except (OSError, ValueError, KeyError):
                    continue
            result[bucket] = {"objects": count, "bytes": size}
    with FAULTS_LOCK:
        faults = {name: dict(value) for name, value in sorted(FAULTS.items())}
    with STATS_LOCK:
        requests = json.loads(json.dumps(REQUEST_STATS))
    with GATE_CONDITION:
        gates = {name: dict(value) for name, value in sorted(GATES.items())}
    return {"buckets": result, "faults": faults, "gates": gates, "requests": requests}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:
        return

    def _begin_metric(self, operation: str) -> None:
        path = unquote(urlsplit(self.path).path)
        bucket = path.lstrip("/").split("/", 1)[0]
        if bucket not in BUCKETS:
            bucket = "unknown"
        self._metric = {
            "operation": operation,
            "bucket": bucket,
            "started": time.monotonic(),
            "request_bytes": 0,
            "finished": False,
        }
        with STATS_LOCK:
            stats = REQUEST_STATS.setdefault(bucket, {}).setdefault(
                operation,
                {
                    "requests": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "request_bytes": 0,
                    "response_bytes": 0,
                    "active": 0,
                    "max_active": 0,
                    "latency_us": 0,
                },
            )
            stats["requests"] += 1
            stats["active"] += 1
            stats["max_active"] = max(stats["max_active"], stats["active"])

    def _object_or_error(self) -> tuple[str, str] | None:
        try:
            return _parse_object(self.path)
        except LookupError:
            _s3_error(self, 404, "NoSuchBucket", "bucket does not exist")
        except ValueError:
            _s3_error(self, 400, "InvalidURI", "invalid object path")
        return None

    def do_HEAD(self) -> None:
        if urlsplit(self.path).path == "/__health":
            _send(self, 200)
            return
        self._begin_metric("head")
        if _maybe_fail(self, "head"):
            return
        parsed = self._object_or_error()
        if parsed is None:
            return
        try:
            metadata, _ = _load_verified_object(*parsed)
        except FileNotFoundError:
            _s3_error(self, 404, "NotFound", "object does not exist")
            return
        except RuntimeError as error:
            _s3_error(self, 500, "InternalError", str(error))
            return
        _send(
            self,
            200,
            headers={
                "Content-Length": str(metadata["size"]),
                "ETag": f'"{metadata["etag"]}"',
                "x-amz-meta-sha256": metadata["sha256"],
            },
        )

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/__health":
            _send(self, 200, b'{"status":"ok"}', "application/json")
            return
        if path == "/__admin/stats":
            if not _require_admin(self):
                return
            _send(self, 200, json.dumps(_admin_stats(), sort_keys=True).encode(), "application/json")
            return
        query = parse_qs(urlsplit(self.path).query)
        if query.get("list-type") == ["2"]:
            bucket = unquote(path).strip("/")
            self._begin_metric("list")
            if _maybe_fail(self, "list"):
                return
            if bucket not in BUCKETS:
                _s3_error(self, 404, "NoSuchBucket", "bucket does not exist")
                return
            try:
                limit = int(query.get("max-keys", ["1000"])[0])
                if not 1 <= limit <= 1000:
                    raise ValueError("invalid max-keys")
                prefix = query.get("prefix", [""])[0]
                token = query.get("continuation-token", [None])[0]
                cursor = _decode_cursor(token) if token is not None else None
                with MUTATION_LOCK:
                    objects, next_cursor = _list_bucket(bucket, prefix, cursor, limit)
                body = _list_xml(bucket, prefix, limit, objects, next_cursor)
            except ValueError:
                _s3_error(self, 400, "InvalidArgument", "invalid list argument")
                return
            except RuntimeError as error:
                _s3_error(self, 500, "InternalError", str(error))
                return
            _send(self, 200, body, "application/xml")
            return
        self._begin_metric("get")
        if _maybe_fail(self, "get"):
            return
        parsed = self._object_or_error()
        if parsed is None:
            return
        try:
            metadata, content = _load_verified_object(*parsed)
        except FileNotFoundError:
            _s3_error(self, 404, "NoSuchKey", "object does not exist")
            return
        except RuntimeError as error:
            _s3_error(self, 500, "InternalError", str(error))
            return
        _send(
            self,
            200,
            content,
            "application/octet-stream",
            {
                "ETag": f'"{metadata["etag"]}"',
                "x-amz-meta-sha256": metadata["sha256"],
            },
        )

    def do_PUT(self) -> None:
        path = urlsplit(self.path).path
        if path == "/__admin/fault":
            if not _require_admin(self):
                return
            query = parse_qs(urlsplit(self.path).query)
            operation = query.get("operation", [""])[0]
            try:
                status = int(query.get("status", ["503"])[0])
                count = int(query.get("count", ["0"])[0])
                skip = int(query.get("skip", ["0"])[0])
                delay_ms = int(query.get("delay_ms", ["0"])[0])
            except ValueError:
                _send(self, 400)
                return
            if (
                operation not in {"put", "get", "head", "delete", "list"}
                or status != 429 and not 500 <= status <= 599
                or count < 0
                or skip < 0
                or not 0 <= delay_ms <= 60_000
            ):
                _send(self, 400)
                return
            with FAULTS_LOCK:
                FAULTS[operation] = {
                    "status": status,
                    "remaining": count or None,
                    "skip": skip,
                    "delay_ms": delay_ms,
                }
            _send(self, 204)
            return
        if path == "/__admin/gate":
            if not _require_admin(self):
                return
            point = parse_qs(urlsplit(self.path).query).get("point", [""])[0]
            if point not in {"put_after_commit", "delete_after_commit"}:
                _send(self, 400)
                return
            with GATE_CONDITION:
                GATES[point] = {"enabled": True, "waiting": 0}
            _send(self, 204)
            return
        self._begin_metric("put")
        if _maybe_fail(self, "put"):
            return
        parsed = self._object_or_error()
        if parsed is None:
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            _s3_error(self, 411, "MissingContentLength", "content length is required")
            return
        if length > MAX_OBJECT_BYTES:
            _s3_error(self, 413, "EntityTooLarge", "object exceeds local limit")
            return
        content = self.rfile.read(length)
        self._metric["request_bytes"] = len(content)
        if len(content) != length:
            _s3_error(self, 400, "IncompleteBody", "request body was truncated")
            return
        bucket, key = parsed
        digest = hashlib.sha256(content).hexdigest()
        etag = hashlib.md5(content, usedforsecurity=False).hexdigest()
        metadata = {
            "key": key,
            "sha256": digest,
            "etag": etag,
            "size": len(content),
        }
        encoded = (json.dumps(metadata, sort_keys=True) + "\n").encode()
        try:
            with MUTATION_LOCK:
                _install_immutable(_blob_path(digest), content)
                installed = _install_immutable(_metadata_path(bucket, key), encoded)
                if not installed:
                    existing, _ = _load_verified_object(bucket, key)
                    if existing != metadata:
                        _s3_error(self, 409, "OperationAborted", "immutable object already exists")
                        return
            _maybe_gate("put_after_commit")
        except (OSError, RuntimeError) as error:
            _s3_error(self, 500, "InternalError", str(error))
            return
        _send(self, 200, headers={"ETag": f'"{etag}"', "x-amz-meta-sha256": digest})

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        if path == "/__admin/fault":
            if not _require_admin(self):
                return
            operation = parse_qs(urlsplit(self.path).query).get("operation", [""])[0]
            with FAULTS_LOCK:
                if operation:
                    FAULTS.pop(operation, None)
                else:
                    FAULTS.clear()
            _send(self, 204)
            return
        if path == "/__admin/gate":
            if not _require_admin(self):
                return
            point = parse_qs(urlsplit(self.path).query).get("point", [""])[0]
            with GATE_CONDITION:
                gate = GATES.get(point)
                if gate is not None:
                    gate["enabled"] = False
                GATE_CONDITION.notify_all()
            _send(self, 204)
            return
        if path == "/__admin/stats":
            if not _require_admin(self):
                return
            with STATS_LOCK:
                REQUEST_STATS.clear()
            _send(self, 204)
            return
        self._begin_metric("delete")
        if _maybe_fail(self, "delete"):
            return
        parsed = self._object_or_error()
        if parsed is None:
            return
        try:
            with MUTATION_LOCK:
                metadata_path = _metadata_path(*parsed)
                try:
                    metadata = _load_metadata(*parsed)
                except FileNotFoundError:
                    metadata = None
                metadata_path.unlink(missing_ok=True)
                if metadata_path.parent.exists():
                    _fsync_directory(metadata_path.parent)
                if metadata is not None and metadata["sha256"] not in _referenced_digests():
                    blob = _blob_path(metadata["sha256"])
                    blob.unlink(missing_ok=True)
                    if blob.parent.exists():
                        _fsync_directory(blob.parent)
            _maybe_gate("delete_after_commit")
        except (OSError, RuntimeError, KeyError) as error:
            _s3_error(self, 500, "InternalError", str(error))
            return
        _send(self, 204)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/__admin/corrupt":
            _s3_error(self, 405, "MethodNotAllowed", "unsupported operation")
            return
        if not _require_admin(self):
            return
        query = parse_qs(urlsplit(self.path).query)
        bucket = query.get("bucket", [""])[0]
        key = query.get("key", [""])[0]
        if bucket not in BUCKETS or not key:
            _send(self, 400)
            return
        try:
            with MUTATION_LOCK:
                metadata = _load_metadata(bucket, key)
                metadata["size"] = int(metadata["size"]) + 1
                _replace_durable(
                    _metadata_path(bucket, key),
                    (json.dumps(metadata, sort_keys=True) + "\n").encode(),
                )
        except FileNotFoundError:
            _send(self, 404)
            return
        except (OSError, RuntimeError) as error:
            _send(self, 500, str(error).encode())
            return
        _send(self, 204)


def main() -> None:
    if not BUCKETS:
        raise SystemExit("LOCAL_S3_BUCKETS must contain at least one bucket")
    if len(ADMIN_TOKEN) < 32:
        raise SystemExit("LOCAL_S3_ADMIN_TOKEN must contain at least 32 characters")
    ROOT.mkdir(parents=True, exist_ok=True)
    _garbage_collect_blobs()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
