#!/usr/bin/env python3
"""Resumably delete Objects created by shared-agent-scale receipts.

The immutable load receipt and deterministic run identity are the deletion
authority.  This tool never lists a Worker namespace or guesses user-owned
objects.  Completed DELETEs are committed to a local SQLite manifest so a
process, node, or network failure can safely resume the exact cleanup.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


SCHEMA = "actor-shared-agent-cleanup/v1"
LOAD_SCHEMA = "actor-shared-agent-scale/v1"
AGENT_UPLOAD_SCHEMA = "actor-agent-upload-soak/v1"
RUN_ID = re.compile(r"^[a-f0-9]{32}$")
MAX_OBJECTS = 2_000_000


class DeleteFailure(RuntimeError):
    def __init__(self, status, code):
        super().__init__("DELETE returned HTTP {} ({})".format(status, code))
        self.status = status
        self.code = code


class Pacer:
    def __init__(self, rate):
        self.interval = 0 if rate == 0 else 1.0 / rate
        self.next_at = 0.0
        self.lock = threading.Lock()

    def wait(self):
        if self.interval == 0:
            return
        with self.lock:
            now = time.monotonic()
            scheduled = max(now, self.next_at)
            self.next_at = scheduled + self.interval
        if scheduled > now:
            time.sleep(scheduled - now)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def identity(run_id, index, workers, kind="shared"):
    if kind == "agent-upload":
        worker = "soak-{}-{}".format(run_id, index)
        return worker, hashlib.sha256("{}\0agent".format(worker).encode()).hexdigest()
    if kind != "shared":
        raise ValueError("unsupported load identity kind")
    shard = index % workers
    worker = "scale-{}-s{:03d}".format(run_id, shard)
    object_id = hashlib.sha256("{}\0{}".format(run_id, index).encode()).hexdigest()
    return worker, object_id


def load_authority(path):
    path = path.resolve()
    receipt = json.loads(path.read_text())
    schema = receipt.get("schema")
    if schema not in (LOAD_SCHEMA, AGENT_UPLOAD_SCHEMA):
        return None
    run_id = receipt.get("runId")
    counters = receipt.get("counters", {})
    scheduled = counters.get("scheduled")
    target = receipt.get("target")
    config_path = path.parent / "config.json"
    if not RUN_ID.fullmatch(run_id or "") or not config_path.is_file():
        raise ValueError("load receipt identity is incomplete: {}".format(path))
    config = json.loads(config_path.read_text())
    kind = "shared" if schema == LOAD_SCHEMA else "agent-upload"
    workers = config.get("workers") if kind == "shared" else 0
    if (config.get("runId") != run_id or not isinstance(workers, int) or
            (kind == "shared" and not 1 <= workers <= 1000)):
        raise ValueError("load config identity differs: {}".format(config_path))
    if not isinstance(target, int) or not isinstance(scheduled, int) or not 0 <= scheduled <= target:
        raise ValueError("load receipt scheduled cardinality is invalid: {}".format(path))
    return {
        "run_id": run_id,
        "kind": kind,
        "workers": workers,
        "scheduled": scheduled,
        "receipt_path": str(path),
        "receipt_sha256": digest_file(path),
        "config_sha256": digest_file(config_path),
    }


def discover(args):
    paths = [path.resolve() for path in args.receipt]
    if args.root:
        paths.extend(sorted(args.root.resolve().rglob("receipt.json")))
    authorities = {}
    for path in paths:
        authority = load_authority(path)
        if authority is None:
            continue
        previous = authorities.setdefault(authority["run_id"], authority)
        if previous != authority:
            raise ValueError("run ID has multiple receipt authorities: {}".format(authority["run_id"]))
    if not authorities:
        raise ValueError("no shared-agent-scale receipt authority was found")
    total = sum(value["scheduled"] for value in authorities.values())
    if total > MAX_OBJECTS:
        raise ValueError("cleanup exceeds the {} Object safety bound".format(MAX_OBJECTS))
    return [authorities[key] for key in sorted(authorities)]


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=60)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(
          run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, workers INTEGER NOT NULL, scheduled INTEGER NOT NULL,
          receipt_path TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, config_sha256 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS objects(
          run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, worker TEXT NOT NULL,
          object_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','deleted')),
          retries INTEGER NOT NULL DEFAULT 0, already_absent INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(run_id, ordinal), UNIQUE(worker, object_id),
          FOREIGN KEY(run_id) REFERENCES runs(run_id)
        );
        """
    )
    db.execute("PRAGMA foreign_keys=ON")
    db.commit()
    return db


def initialize(db, args, authorities):
    endpoint = args.endpoint.rstrip("/")
    metadata = {"schema": SCHEMA, "endpoint": endpoint}
    existing = dict(db.execute("SELECT key,value FROM metadata"))
    if existing and existing != metadata:
        raise ValueError("cleanup manifest identity differs")
    if not existing:
        db.executemany("INSERT INTO metadata(key,value) VALUES (?,?)", sorted(metadata.items()))
    for authority in authorities:
        existing_run = db.execute(
            "SELECT kind,workers,scheduled,receipt_path,receipt_sha256,config_sha256 FROM runs WHERE run_id=?",
            (authority["run_id"],),
        ).fetchone()
        expected = (
            authority["kind"], authority["workers"], authority["scheduled"], authority["receipt_path"],
            authority["receipt_sha256"], authority["config_sha256"],
        )
        if existing_run and existing_run != expected:
            raise ValueError("cleanup authority changed for run {}".format(authority["run_id"]))
        if not existing_run:
            db.execute(
                "INSERT INTO runs(run_id,kind,workers,scheduled,receipt_path,receipt_sha256,config_sha256) "
                "VALUES (?,?,?,?,?,?,?)",
                (authority["run_id"],) + expected,
            )
            for first in range(0, authority["scheduled"], 4096):
                rows = []
                for index in range(first, min(first + 4096, authority["scheduled"])):
                    worker, object_id = identity(
                        authority["run_id"], index, authority["workers"], authority["kind"]
                    )
                    rows.append((authority["run_id"], index, worker, object_id, "pending"))
                db.executemany(
                    "INSERT INTO objects(run_id,ordinal,worker,object_id,state) VALUES (?,?,?,?,?)",
                    rows,
                )
            db.commit()
    db.commit()


def delete_url(endpoint, worker, object_id):
    quote = urllib.parse.quote
    return "{}/workers/{}/objects/Agent/{}".format(
        endpoint.rstrip("/"), quote(worker, safe=""), quote(object_id, safe="")
    )


def delete_one(args, pacer, row):
    run_id, ordinal, worker, object_id = row
    retries = 0
    while True:
        pacer.wait()
        request = urllib.request.Request(
            delete_url(args.endpoint, worker, object_id), method="DELETE",
            headers={"X-Request-ID": "load-cleanup-{}-{}-{}".format(run_id, ordinal, retries)},
        )
        try:
            with urllib.request.urlopen(request, timeout=args.timeout_seconds) as response:
                status = response.status
                payload = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            payload = error.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            if retries >= args.retries:
                return row, False, retries, False, "transport:{}".format(type(error).__name__)
            retries += 1
            time.sleep(min(5, args.retry_base_seconds * (2 ** (retries - 1))))
            continue
        if status in (204, 404, 410):
            return row, True, retries, status != 204, ""
        try:
            parsed = json.loads(payload.decode()) if payload else {}
            code = parsed.get("error", {}).get("code", "http_error")
        except (UnicodeDecodeError, ValueError, AttributeError):
            code = "http_error"
        if status not in (408, 425, 429, 500, 502, 503, 504) or retries >= args.retries:
            return row, False, retries, False, "http:{}:{}".format(status, code)
        retries += 1
        time.sleep(min(5, args.retry_base_seconds * (2 ** (retries - 1))))


def cleanup(db, args):
    pacer = Pacer(args.rate)
    began = time.monotonic()
    completed_at_start = db.execute("SELECT COUNT(*) FROM objects WHERE state='deleted'").fetchone()[0]
    while True:
        rows = db.execute(
            "SELECT run_id,ordinal,worker,object_id FROM objects WHERE state='pending' "
            "ORDER BY run_id,ordinal LIMIT ?", (args.batch_size,)
        ).fetchall()
        if not rows:
            break
        failures = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            for row, ok, retries, absent, error in executor.map(
                lambda value: delete_one(args, pacer, value), rows
            ):
                if ok:
                    db.execute(
                        "UPDATE objects SET state='deleted',retries=retries+?,already_absent=?,last_error='' "
                        "WHERE run_id=? AND ordinal=?", (retries, int(absent), row[0], row[1])
                    )
                else:
                    db.execute(
                        "UPDATE objects SET retries=retries+?,last_error=? WHERE run_id=? AND ordinal=?",
                        (retries, error, row[0], row[1]),
                    )
                    failures.append((row, error))
        db.commit()
        deleted = db.execute("SELECT COUNT(*) FROM objects WHERE state='deleted'").fetchone()[0]
        total = db.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
        print(json.dumps({"deleted": deleted, "total": total, "elapsedSeconds": round(time.monotonic() - began, 1)}), flush=True)
        if failures:
            raise RuntimeError("{} DELETEs exhausted retries; first {}: {}".format(
                len(failures), failures[0][0][:2], failures[0][1]
            ))
    return completed_at_start


def write_receipt(db, args, completed_at_start):
    total = db.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
    deleted = db.execute("SELECT COUNT(*) FROM objects WHERE state='deleted'").fetchone()[0]
    pending = total - deleted
    retries = db.execute("SELECT COALESCE(SUM(retries),0) FROM objects").fetchone()[0]
    absent = db.execute("SELECT COUNT(*) FROM objects WHERE already_absent=1").fetchone()[0]
    runs = [
        {"runId": row[0], "kind": row[1], "workers": row[2], "scheduled": row[3],
         "receipt": {"path": row[4], "sha256": row[5]}, "configSha256": row[6]}
        for row in db.execute(
            "SELECT run_id,kind,workers,scheduled,receipt_path,receipt_sha256,config_sha256 FROM runs ORDER BY run_id"
        )
    ]
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.commit()
    receipt = {
        "schema": SCHEMA, "verdict": "passed" if pending == 0 else "failed",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "endpoint": args.endpoint.rstrip("/"), "runs": runs,
        "manifest": {"path": str(args.manifest.resolve()), "sha256": digest_file(args.manifest)},
        "limits": {"rate": args.rate, "concurrency": args.concurrency,
                   "batchSize": args.batch_size, "retries": args.retries},
        "objects": {"total": total, "deleted": deleted, "pending": pending,
                    "alreadyAbsent": absent, "completedBeforeResume": completed_at_start},
        "retries": retries,
    }
    if args.output.exists():
        raise ValueError("cleanup receipt already exists: {}".format(args.output))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("w") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(args.output))
    return receipt


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--root", type=pathlib.Path)
    parser.add_argument("--receipt", type=pathlib.Path, action="append", default=[])
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--rate", type=float, default=100)
    parser.add_argument("--retries", type=int, default=8)
    parser.add_argument("--retry-base-seconds", type=float, default=0.1)
    parser.add_argument("--timeout-seconds", type=float, default=60)
    return parser.parse_args()


def main():
    args = parse_args()
    url = urllib.parse.urlparse(args.endpoint)
    if (url.scheme not in ("http", "https") or url.username or url.password or
            url.query or url.fragment or url.path.rstrip("/") != "/v1"):
        raise SystemExit("endpoint must be a credential-free public /v1 URL")
    if not (1 <= args.concurrency <= 256 and 1 <= args.batch_size <= 4096 and
            0 <= args.rate <= 1000 and 0 <= args.retries <= 10 and
            0 < args.retry_base_seconds <= 5 and 0 < args.timeout_seconds <= 300):
        raise SystemExit("cleanup bounds are invalid")
    if not args.root and not args.receipt:
        raise SystemExit("at least one --root or --receipt authority is required")
    authorities = discover(args)
    db = connect(args.manifest)
    try:
        initialize(db, args, authorities)
        completed = cleanup(db, args)
        receipt = write_receipt(db, args, completed)
    finally:
        db.close()
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
