#!/usr/bin/env python3
"""Resumable persistent-object cardinality qualification for a Beijing Cell.

Production FDB qualification uses the public Workers /v1 path and a Durable
Object expected-value transition. The legacy internal Actor client remains a
debugging mode only. A local SQLite manifest is the recovery/cleanup authority;
the harness never scans or deletes a whole namespace. Object keys put a
deterministic hash before the ordinal so a million sequential ordinals do not
create one lexicographic key hotspot.

For runs above 4096 Actors, --execution-site-file must contain the exact Cell ID.
Install that file only on the Beijing cloud load driver. This prevents an
accidental million-Actor run on a developer laptop while still allowing Engine
to be reached over loopback on the cloud host.
"""

import argparse
import concurrent.futures
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple


SCHEMA_VERSION = "4"
MAX_CONCURRENCY = 256
MAX_BATCH_SIZE = 4096
PUBLIC_CLASS_NAME = "Agent"
PUBLIC_WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const value = (await this.ctx.storage.get("value")) ?? 0;
    if (url.pathname === "/read") return Response.json({ value });
    if (url.pathname === "/advance") {
      const expected = Number(url.searchParams.get("expected"));
      if (!Number.isSafeInteger(expected) || expected < 0)
        return Response.json({ error: "invalid_expected" }, { status: 400 });
      if (value === expected + 1) return Response.json({ value });
      if (value !== expected)
        return Response.json({ error: "state_conflict", value, expected }, { status: 409 });
      const next = expected + 1;
      await this.ctx.storage.put("value", next);
      return Response.json({ value: next });
    }
    return new Response("not found", { status: 404 });
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


class PublicRequestFailure(RuntimeError):
    def __init__(self, method: str, url: str, status: int, payload: Any):
        super().__init__(
            "{} {} returned HTTP {}: {}".format(method, url, status, payload)
        )
        self.status = status


class OperationPacer:
    """Reserve globally spaced operation start times across worker threads."""

    def __init__(self, rate: float):
        self.interval = 0.0 if rate <= 0 else 1.0 / rate
        self.next_at = 0.0
        self.lock = threading.Lock()

    def wait(self) -> None:
        if self.interval == 0:
            return
        with self.lock:
            now = time.monotonic()
            scheduled = max(now, self.next_at)
            self.next_at = scheduled + self.interval
        delay = scheduled - now
        if delay > 0:
            time.sleep(delay)


def retry_idempotent_public_operation(args: argparse.Namespace, pacer: OperationPacer, operation):
    retries = 0
    while True:
        pacer.wait()
        try:
            result = operation()
            result["operation_retries"] = retries
            return result
        except PublicRequestFailure as error:
            retryable = error.status in (408, 425, 429, 500, 502, 503, 504)
            if not retryable or retries >= args.max_idempotent_retries:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if retries >= args.max_idempotent_retries:
                raise
        retries += 1
        time.sleep(min(5.0, args.retry_base_delay_seconds * (2 ** (retries - 1))))


def request_json(
    method: str,
    url: str,
    body: Optional[Dict[str, Any]],
    timeout_seconds: float,
    token: Optional[str],
    allow_not_found: bool = False,
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Any], float]:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        elapsed_ms = (time.perf_counter() - started) * 1_000
        if allow_not_found and error.code == 404:
            error.read()
            return {"already_absent": True}, elapsed_ms
        payload = error.read().decode(errors="replace")
        raise RuntimeError(
            "{} {} returned HTTP {}: {}".format(method, url, error.code, payload)
        ) from error
    elapsed_ms = (time.perf_counter() - started) * 1_000
    return (json.loads(payload) if payload else {}), elapsed_ms


def public_request(
    method: str,
    url: str,
    body: Optional[Dict[str, Any]],
    timeout_seconds: float,
    expected: Tuple[int, ...],
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Any], float, int]:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method=method)
    request.add_header("X-Request-ID", "fdb-gate-" + uuid.uuid4().hex)
    if encoded is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            payload = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read()
    elapsed_ms = (time.perf_counter() - started) * 1_000
    if payload:
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            parsed = payload.decode("utf-8", errors="replace")
    else:
        parsed = {}
    if status not in expected:
        raise PublicRequestFailure(method, url, status, parsed)
    return parsed, elapsed_ms, status


def percentile_rank(count: int, quantile: float) -> Optional[int]:
    if count <= 0:
        return None
    return max(0, math.ceil(count * quantile) - 1)


def latency_summary(
    db: sqlite3.Connection,
    column: str,
    table: str = "actors",
    predicate: Optional[str] = None,
) -> Dict[str, Any]:
    if table not in ("actors", "probes"):
        raise ValueError("unsupported latency table")
    if column not in (
        "create_ms",
        "open_ms",
        "sleep_ms",
        "delete_ms",
        "reopen_ms",
    ):
        raise ValueError("unsupported latency column")
    predicates = {
        None: "",
        "fresh_create": " AND created_fresh=1",
        "committed_delete": " AND delete_already_absent=0",
    }
    if predicate not in predicates:
        raise ValueError("unsupported latency predicate")
    where = predicates[predicate]
    row = db.execute(
        "SELECT COUNT({0}), MIN({0}), AVG({0}), MAX({0}) FROM {1} "
        "WHERE {0} IS NOT NULL{2}".format(
            column, table, where
        )
    ).fetchone()
    count = int(row[0])

    def value_at(quantile: float) -> Optional[float]:
        rank = percentile_rank(count, quantile)
        if rank is None:
            return None
        value = db.execute(
            "SELECT {0} FROM {1} WHERE {0} IS NOT NULL{2} "
            "ORDER BY {0} LIMIT 1 OFFSET ?".format(
                column, table, where
            ),
            (rank,),
        ).fetchone()
        return float(value[0])

    return {
        "count": count,
        "min_ms": row[1],
        "mean_ms": row[2],
        "p50_ms": value_at(0.50),
        "p95_ms": value_at(0.95),
        "p99_ms": value_at(0.99),
        "max_ms": row[3],
    }


def actor_key(run_id: str, index: int, prefix: str = "dormant") -> str:
    material = "{}:{}:{}".format(prefix, run_id, index).encode("utf-8")
    shard = hashlib.sha256(material).hexdigest()[:16]
    return "{}-{}-{:09d}".format(prefix, shard, index)


def public_object_id(run_id: str, index: int, prefix: str = "dormant") -> str:
    return hashlib.sha256(
        "{}:{}:{}".format(prefix, run_id, index).encode("utf-8")
    ).hexdigest()


def runner_for(index: int, runner_names: List[str]) -> str:
    return runner_names[index % len(runner_names)]


def connect_manifest(path: pathlib.Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=60)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS actors (
            ordinal INTEGER PRIMARY KEY,
            actor_key TEXT NOT NULL UNIQUE,
            actor_id TEXT NOT NULL UNIQUE,
            runner_name TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('dormant', 'deleted')),
            generation INTEGER NOT NULL,
            created_fresh INTEGER NOT NULL CHECK(created_fresh IN (0, 1)),
            create_ms REAL NOT NULL,
            open_ms REAL NOT NULL,
            sleep_ms REAL NOT NULL,
            reopen_ms REAL,
            delete_ms REAL,
            delete_already_absent INTEGER NOT NULL DEFAULT 0
                CHECK(delete_already_absent IN (0, 1)),
            operation_retries INTEGER NOT NULL DEFAULT 0
                CHECK(operation_retries >= 0)
        );
        CREATE TABLE IF NOT EXISTS probes (
            ordinal INTEGER PRIMARY KEY,
            actor_key TEXT NOT NULL UNIQUE,
            actor_id TEXT NOT NULL UNIQUE,
            runner_name TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('dormant', 'deleted')),
            generation INTEGER NOT NULL,
            created_fresh INTEGER NOT NULL CHECK(created_fresh IN (0, 1)),
            create_ms REAL NOT NULL,
            open_ms REAL NOT NULL,
            sleep_ms REAL NOT NULL,
            reopen_ms REAL,
            delete_ms REAL,
            delete_already_absent INTEGER NOT NULL DEFAULT 0
                CHECK(delete_already_absent IN (0, 1)),
            operation_retries INTEGER NOT NULL DEFAULT 0
                CHECK(operation_retries >= 0)
        );
        CREATE TABLE IF NOT EXISTS public_attempts (
            object_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('actors', 'probes')),
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            prefix TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'deleted')),
            scheduled_operations INTEGER NOT NULL DEFAULT 1 CHECK(scheduled_operations >= 1),
            delete_ms REAL,
            operation_retries INTEGER NOT NULL DEFAULT 0 CHECK(operation_retries >= 0)
        );
        CREATE INDEX IF NOT EXISTS public_attempts_cleanup
            ON public_attempts(object_id) WHERE state != 'deleted';
        CREATE INDEX IF NOT EXISTS public_attempts_probe_epoch
            ON public_attempts(prefix) WHERE kind='probes' AND state!='deleted';
        """
    )
    for table in ("actors", "probes"):
        columns = {row[1] for row in db.execute("PRAGMA table_info({})".format(table))}
        if "reopen_ms" not in columns:
            db.execute("ALTER TABLE {} ADD COLUMN reopen_ms REAL".format(table))
        if "delete_already_absent" not in columns:
            db.execute(
                "ALTER TABLE {} ADD COLUMN delete_already_absent INTEGER "
                "NOT NULL DEFAULT 0".format(table)
            )
        if "operation_retries" not in columns:
            db.execute(
                "ALTER TABLE {} ADD COLUMN operation_retries INTEGER "
                "NOT NULL DEFAULT 0".format(table)
            )
    db.commit()
    return db


@contextmanager
def manifest_owner(path):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_name(path.name + ".lock").open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("manifest is already in use by another qualification phase") from error
        yield


def initialize_manifest(db: sqlite3.Connection, config: Dict[str, str]) -> None:
    existing = dict(db.execute("SELECT key, value FROM metadata"))
    if not existing:
        db.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)", sorted(config.items())
        )
        db.commit()
        return
    mismatches = {
        key: (existing.get(key), expected)
        for key, expected in config.items()
        if existing.get(key) != expected
    }
    if mismatches:
        raise RuntimeError("manifest configuration mismatch: {}".format(mismatches))


def validate_cloud_execution(args: argparse.Namespace) -> None:
    if args.target_actors <= 4_096:
        return
    if args.execution_site_file is None:
        raise ValueError("runs above 4096 Actors require --execution-site-file")
    try:
        actual = args.execution_site_file.read_text().strip()
    except FileNotFoundError as error:
        raise ValueError("execution site proof file does not exist") from error
    if actual != args.cell_id:
        raise ValueError(
            "execution site proof {!r} does not match Cell {!r}".format(
                actual, args.cell_id
            )
        )
    if not args.cell_id.startswith("actor-bj-"):
        raise ValueError("large qualification is restricted to an actor-bj-* Cell")


def bounded_results(
    executor: concurrent.futures.ThreadPoolExecutor,
    fn: Any,
    values: Iterable[int],
) -> Tuple[List[Dict[str, Any]], List[Tuple[int, Exception]]]:
    futures = {executor.submit(fn, value): value for value in values}
    results = []
    errors = []
    for future in concurrent.futures.as_completed(futures):
        value = futures[future]
        try:
            results.append(future.result())
        except Exception as error:
            errors.append((value, error))
    return results, errors


def public_object_url(args: argparse.Namespace, object_id: str) -> str:
    return "{}/v1/workers/{}/objects/{}/{}".format(
        args.workers_url.rstrip("/"),
        urllib.parse.quote(args.worker_name, safe=""),
        urllib.parse.quote(args.class_name, safe=""),
        urllib.parse.quote(object_id, safe=""),
    )


def prepare_public_worker(args: argparse.Namespace) -> Dict[str, str]:
    base = args.workers_url.rstrip("/") + "/v1/workers/" + urllib.parse.quote(
        args.worker_name, safe=""
    )
    version, _, _ = public_request(
        "POST",
        base + "/versions",
        {
            "main_module": "main.js",
            "modules": {"main.js": PUBLIC_WORKER_SOURCE},
            "compatibility_date": "2026-08-14",
            "durable_objects": {"AGENT": args.class_name},
        },
        args.request_timeout_seconds,
        (200, 201),
    )
    version_id = version.get("id")
    if version.get("object") != "version" or not isinstance(version_id, str):
        raise RuntimeError("public Worker version response is invalid: {}".format(version))
    deployment, _, _ = public_request(
        "POST",
        base + "/deployments",
        {"version_id": version_id},
        args.request_timeout_seconds,
        (200, 201),
    )
    deployment_id = deployment.get("id")
    if deployment.get("object") != "deployment" or not isinstance(deployment_id, str):
        raise RuntimeError("public Worker deployment response is invalid: {}".format(deployment))
    return {"version_id": version_id, "deployment_id": deployment_id}


def make_public_client(args: argparse.Namespace):
    pacer = OperationPacer(args.operation_rate)

    def fetch(object_id: str, operation: str) -> Tuple[int, float]:
        payload, elapsed_ms, _ = public_request(
            "POST",
            public_object_url(args, object_id) + "/fetch",
            None,
            args.request_timeout_seconds,
            (200,),
            {"X-Workers-Original-URL": "https://agent.invalid/" + operation},
        )
        value = payload.get("value")
        if not isinstance(value, int):
            raise RuntimeError("public Agent returned invalid state: {}".format(payload))
        return value, elapsed_ms

    def populate_attempt(index: int, prefix: str = "dormant") -> Dict[str, Any]:
        object_id = public_object_id(args.run_id, index, prefix)
        reference, create_ms, status = public_request(
            "PUT",
            public_object_url(args, object_id),
            None,
            args.request_timeout_seconds,
            (200, 201),
        )
        expected = {
            "object": "object",
            "id": object_id,
            "worker": args.worker_name,
            "class_name": args.class_name,
        }
        if reference != expected:
            raise RuntimeError("public ObjectRef is unstable: {}".format(reference))
        value, open_ms = fetch(object_id, "advance?expected=0")
        if value != 1:
            raise RuntimeError("new public Agent returned non-initial state {}".format(value))
        return {
            "ordinal": index,
            "actor_key": object_id,
            "actor_id": object_id,
            "runner_name": "public-workers-v1",
            "state": "dormant",
            "generation": value,
            "created_fresh": 1 if status == 201 else 0,
            "create_ms": create_ms,
            "open_ms": open_ms,
            # Public Agent/DO lifecycle is idle-driven.  The next probe occurs
            # only after the topology transition, well beyond the Host idle
            # timeout; no internal Actor sleep endpoint is permitted here.
            "sleep_ms": 0.0,
            "reopen_ms": None,
            "delete_ms": None,
            "delete_already_absent": 0,
            "operation_retries": 0,
        }

    def populate_one(index: int, prefix: str = "dormant") -> Dict[str, Any]:
        return retry_idempotent_public_operation(
            args, pacer, lambda: populate_attempt(index, prefix)
        )

    def open_attempt(record: Tuple[int, str, str, int]) -> Dict[str, Any]:
        ordinal, key, object_id, prior_value = record
        value, open_ms = fetch(object_id, "advance?expected={}".format(prior_value))
        if value != prior_value + 1:
            raise RuntimeError(
                "public Agent state did not advance exactly: expected {}, got {}".format(
                    prior_value + 1, value
                )
            )
        return {
            "ordinal": ordinal,
            "actor_key": key,
            "actor_id": object_id,
            "generation": value,
            "open_ms": open_ms,
            "sleep_ms": 0.0,
        }

    def open_and_sleep(record: Tuple[int, str, str, int]) -> Dict[str, Any]:
        return retry_idempotent_public_operation(
            args, pacer, lambda: open_attempt(record)
        )

    def delete_attempt(record: Tuple[int, str]) -> Dict[str, Any]:
        ordinal, object_id = record
        _, delete_ms, status = public_request(
            "DELETE",
            public_object_url(args, object_id),
            None,
            args.request_timeout_seconds,
            (204, 404),
        )
        return {
            "ordinal": ordinal,
            "object_id": object_id,
            "delete_ms": delete_ms,
            "delete_already_absent": 1 if status == 404 else 0,
        }

    def delete_one(record: Tuple[int, str]) -> Dict[str, Any]:
        return retry_idempotent_public_operation(
            args, pacer, lambda: delete_attempt(record)
        )

    return populate_one, open_and_sleep, delete_one


def make_actor_client(args: argparse.Namespace, token: Optional[str]):
    engine_url = args.engine_url.rstrip("/")
    namespace_query = urllib.parse.urlencode({"namespace": args.namespace})

    def populate_one(index: int, prefix: str = "dormant") -> Dict[str, Any]:
        key = actor_key(args.run_id, index, prefix)
        runner_name = runner_for(index, args.runner_name)
        payload, create_ms = request_json(
            "PUT",
            engine_url + "/actors?" + namespace_query,
            {
                "name": args.actor_name,
                "key": key,
                "runner_name_selector": runner_name,
                "crash_policy": "restart",
            },
            args.request_timeout_seconds,
            token,
        )
        actor = payload.get("actor", {})
        actor_id = actor.get("actor_id")
        if not isinstance(actor_id, str) or not actor_id:
            raise RuntimeError("get-or-create returned no actor_id")
        counter, open_ms = request_json(
            "GET",
            engine_url
            + "/gateway/"
            + urllib.parse.quote(actor_id, safe="")
            + "/counter",
            None,
            args.request_timeout_seconds,
            token,
        )
        generation = counter.get("generation")
        if counter.get("actorId") != actor_id or counter.get("count") != 0:
            raise RuntimeError("new dormant Actor returned wrong identity or non-zero state")
        if not isinstance(generation, int) or generation <= 0:
            raise RuntimeError("new dormant Actor returned invalid generation")
        _, sleep_ms = request_json(
            "POST",
            engine_url
            + "/actors/"
            + urllib.parse.quote(actor_id, safe="")
            + "/sleep?"
            + namespace_query,
            {},
            args.request_timeout_seconds,
            token,
        )
        return {
            "ordinal": index,
            "actor_key": key,
            "actor_id": actor_id,
            "runner_name": runner_name,
            "state": "dormant",
            "generation": generation,
            "created_fresh": 1 if payload.get("created") is True else 0,
            "create_ms": create_ms,
            "open_ms": open_ms,
            "sleep_ms": sleep_ms,
            "operation_retries": 0,
            "reopen_ms": None,
            "delete_ms": None,
            "delete_already_absent": 0,
        }

    def open_and_sleep(record: Tuple[int, str, str, int]) -> Dict[str, Any]:
        ordinal, key, actor_id, prior_generation = record
        counter, open_ms = request_json(
            "GET",
            engine_url
            + "/gateway/"
            + urllib.parse.quote(actor_id, safe="")
            + "/counter",
            None,
            args.request_timeout_seconds,
            token,
        )
        generation = counter.get("generation")
        if counter.get("actorId") != actor_id or counter.get("count") != 0:
            raise RuntimeError("dormant probe returned wrong identity or state")
        if not isinstance(generation, int) or generation <= prior_generation:
            raise RuntimeError("dormant Actor generation did not advance on open")
        _, sleep_ms = request_json(
            "POST",
            engine_url
            + "/actors/"
            + urllib.parse.quote(actor_id, safe="")
            + "/sleep?"
            + namespace_query,
            {},
            args.request_timeout_seconds,
            token,
        )
        return {
            "ordinal": ordinal,
            "actor_key": key,
            "actor_id": actor_id,
            "generation": generation,
            "open_ms": open_ms,
            "sleep_ms": sleep_ms,
            "operation_retries": 0,
        }

    def delete_one(record: Tuple[int, str]) -> Dict[str, Any]:
        ordinal, actor_id = record
        response, delete_ms = request_json(
            "DELETE",
            engine_url
            + "/actors/"
            + urllib.parse.quote(actor_id, safe="")
            + "?"
            + namespace_query,
            None,
            args.request_timeout_seconds,
            token,
            allow_not_found=True,
        )
        return {
            "ordinal": ordinal,
            "delete_ms": delete_ms,
            "delete_already_absent": 1 if response.get("already_absent") is True else 0,
            "operation_retries": 0,
        }

    return populate_one, open_and_sleep, delete_one


def make_client(args: argparse.Namespace, token: Optional[str]):
    if args.api_mode == "workers-v1":
        return make_public_client(args)
    return make_actor_client(args, token)


def insert_results(db: sqlite3.Connection, table: str, results: List[Dict[str, Any]]) -> None:
    if table not in ("actors", "probes"):
        raise ValueError("unsupported manifest table")
    db.executemany(
        """
        INSERT INTO {table}(
            ordinal, actor_key, actor_id, runner_name, state, generation,
            created_fresh, create_ms, open_ms, sleep_ms, reopen_ms, delete_ms,
            delete_already_absent, operation_retries
        ) VALUES (
            :ordinal, :actor_key, :actor_id, :runner_name, :state, :generation,
            :created_fresh, :create_ms, :open_ms, :sleep_ms, :reopen_ms, :delete_ms,
            :delete_already_absent, :operation_retries
        )
        ON CONFLICT(ordinal) DO UPDATE SET
            actor_key=excluded.actor_key,
            actor_id=excluded.actor_id,
            runner_name=excluded.runner_name,
            state=excluded.state,
            generation=excluded.generation,
            created_fresh=excluded.created_fresh,
            create_ms=excluded.create_ms,
            open_ms=excluded.open_ms,
            sleep_ms=excluded.sleep_ms,
            reopen_ms=excluded.reopen_ms,
            delete_ms=excluded.delete_ms,
            delete_already_absent=excluded.delete_already_absent,
            operation_retries=excluded.operation_retries
        """.format(table=table),
        results,
    )
    db.executemany(
        "UPDATE public_attempts SET state='confirmed' "
        "WHERE object_id=:actor_id AND state='pending'",
        results,
    )
    db.commit()


def record_public_attempts(args, db, kind, ordinals, prefix):
    if args.api_mode != "workers-v1":
        return
    db.executemany(
        "INSERT INTO public_attempts(object_id,kind,ordinal,prefix,state) "
        "VALUES (?,?,?,?,'pending') ON CONFLICT(object_id) DO UPDATE SET "
        "scheduled_operations=public_attempts.scheduled_operations+1 "
        "WHERE public_attempts.state='pending'",
        [(public_object_id(args.run_id, index, prefix), kind, index, prefix)
         for index in ordinals],
    )
    # FULL-synchronous SQLite commits precede dispatch to worker threads. A
    # successful remote mutation with a lost response remains in this journal.
    db.commit()


def record_public_deletions(db, results):
    db.executemany(
        "UPDATE public_attempts SET state='deleted',delete_ms=:delete_ms,"
        "operation_retries=operation_retries+:operation_retries WHERE object_id=:object_id",
        results,
    )


def populate(args: argparse.Namespace, db: sqlite3.Connection, token: Optional[str]) -> None:
    populate_one, _, _ = make_client(args, token)
    completed = {
        int(row[0])
        for row in db.execute(
            "SELECT ordinal FROM actors WHERE state='dormant' AND ordinal < ?",
            (args.target_actors,),
        )
    }
    pending_iter = (
        index for index in range(args.target_actors) if index not in completed
    )
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency, thread_name_prefix="dormant-populate"
    ) as executor:
        while True:
            pending = []
            for _ in range(args.batch_size):
                try:
                    pending.append(next(pending_iter))
                except StopIteration:
                    break
            if not pending:
                break
            record_public_attempts(args, db, "actors", pending, "dormant")
            results, errors = bounded_results(executor, populate_one, pending)
            if results:
                insert_results(db, "actors", results)
            if errors:
                raise RuntimeError(
                    "{} population operation(s) failed; first ordinal {}: {}".format(
                        len(errors), errors[0][0], errors[0][1]
                    )
                ) from errors[0][1]
            settle_public_batch(args)


def settle_public_batch(args: argparse.Namespace) -> None:
    """Bound the number of simultaneously active public Objects.

    The public API deliberately has no privileged sleep operation.  A storage
    topology qualification therefore paces batches beyond the configured Host
    idle window instead of turning a cardinality workload into an accidental
    compute autoscaling workload.  The outer qualification independently
    observes occupancy and runtime replicas; this delay is not accepted as
    proof that a batch became idle.
    """
    if args.api_mode == "workers-v1" and args.batch_settle_seconds > 0:
        time.sleep(args.batch_settle_seconds)


def sample_records(db: sqlite3.Connection, target: int, count: int) -> List[Tuple[int, str, str, int]]:
    count = min(count, target)
    if count <= 0:
        return []
    # Deterministic full-range stratification, including the first and last ordinal.
    ordinals = sorted(
        set(
            min(target - 1, (sample * target) // count)
            for sample in range(count)
        )
    )
    rows = []
    for offset in range(0, len(ordinals), 500):
        batch = ordinals[offset : offset + 500]
        placeholders = ",".join("?" for _ in batch)
        rows.extend(
            db.execute(
                "SELECT ordinal, actor_key, actor_id, generation FROM actors "
                "WHERE state='dormant' AND ordinal IN ({}) ORDER BY ordinal".format(
                    placeholders
                ),
                batch,
            ).fetchall()
        )
    if len(rows) != len(ordinals):
        raise RuntimeError("manifest is missing one or more deterministic probe Actors")
    return [(int(row[0]), row[1], row[2], int(row[3])) for row in rows]


def probe(args: argparse.Namespace, db: sqlite3.Connection, token: Optional[str]) -> None:
    populate_one, open_and_sleep, delete_one = make_client(args, token)
    main_count = db.execute("SELECT COUNT(*) FROM actors WHERE state='dormant'").fetchone()[0]
    if main_count != args.target_actors:
        raise RuntimeError(
            "probe requires exactly {} dormant manifest Actors, found {}".format(
                args.target_actors, main_count
            )
        )
    prefix = "cardinality-probe-{}".format(args.probe_epoch)
    if args.api_mode == "workers-v1":
        prior_prefixes = [row[0] for row in db.execute(
            "SELECT DISTINCT prefix FROM public_attempts WHERE kind='probes' AND state!='deleted'",
        )]
        if any(prior != prefix for prior in prior_prefixes):
            raise RuntimeError("unfinished probe epoch must be cleaned before selecting a new epoch")
    records = sample_records(db, args.target_actors, args.probe_actors)
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency, thread_name_prefix="dormant-probe"
    ) as executor:
        for offset in range(0, len(records), args.batch_size):
            batch = records[offset : offset + args.batch_size]
            results, errors = bounded_results(executor, open_and_sleep, batch)
            if results:
                db.executemany(
                    "UPDATE actors SET generation=:generation, reopen_ms=:open_ms, "
                    "sleep_ms=:sleep_ms, operation_retries=operation_retries+:operation_retries "
                    "WHERE ordinal=:ordinal AND actor_id=:actor_id",
                    results,
                )
                db.commit()
            if errors:
                raise RuntimeError(
                    "{} open probe(s) failed; first ordinal {}: {}".format(
                        len(errors), errors[0][0][0], errors[0][1]
                    )
                ) from errors[0][1]
            settle_public_batch(args)

        existing_probe_ordinals = {
            row[0]
            for row in db.execute("SELECT ordinal FROM probes WHERE state='dormant'")
        }
        probe_ordinals = [
            index
            for index in range(args.probe_actors)
            if index not in existing_probe_ordinals
        ]
        for offset in range(0, len(probe_ordinals), args.batch_size):
            batch = probe_ordinals[offset : offset + args.batch_size]
            record_public_attempts(args, db, "probes", batch, prefix)
            fn = lambda index: populate_one(index, prefix)
            results, errors = bounded_results(executor, fn, batch)
            if results:
                insert_results(db, "probes", results)
            if errors:
                raise RuntimeError(
                    "{} create probe(s) failed; first ordinal {}: {}".format(
                        len(errors), errors[0][0], errors[0][1]
                    )
                ) from errors[0][1]
            settle_public_batch(args)

        while True:
            batch = db.execute(
                "SELECT ordinal, actor_id FROM probes WHERE state='dormant' "
                "ORDER BY ordinal LIMIT ?",
                (args.batch_size,),
            ).fetchall()
            if not batch:
                break
            results, errors = bounded_results(executor, delete_one, batch)
            if results:
                db.executemany(
                    "UPDATE probes SET state='deleted', delete_ms=:delete_ms, "
                    "delete_already_absent=:delete_already_absent, "
                    "operation_retries=operation_retries+:operation_retries "
                    "WHERE ordinal=:ordinal",
                    results,
                )
                if args.api_mode == "workers-v1":
                    record_public_deletions(db, results)
                db.commit()
            if errors:
                raise RuntimeError(
                    "{} delete probe(s) failed; first ordinal {}: {}".format(
                        len(errors), errors[0][0][0], errors[0][1]
                    )
                ) from errors[0][1]


def cleanup(args: argparse.Namespace, db: sqlite3.Connection, token: Optional[str]) -> None:
    _, _, delete_one = make_client(args, token)
    if args.api_mode == "workers-v1":
        cleanup_public_attempts(args, db, delete_one)
        return
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency, thread_name_prefix="dormant-cleanup"
    ) as executor:
        for table in ("probes", "actors"):
            while True:
                batch = db.execute(
                    "SELECT ordinal, actor_id FROM {} WHERE state='dormant' "
                    "ORDER BY ordinal LIMIT ?".format(table),
                    (args.batch_size,),
                ).fetchall()
                if not batch:
                    break
                results, errors = bounded_results(executor, delete_one, batch)
                if results:
                    db.executemany(
                        "UPDATE {} SET state='deleted', delete_ms=:delete_ms, "
                        "delete_already_absent=:delete_already_absent, "
                        "operation_retries=operation_retries+:operation_retries "
                        "WHERE ordinal=:ordinal".format(table),
                        results,
                    )
                    db.commit()
                if errors:
                    raise RuntimeError(
                        "{} cleanup(s) failed in {}; first ordinal {}: {}".format(
                            len(errors), table, errors[0][0][0], errors[0][1]
                        )
                    ) from errors[0][1]


def cleanup_public_attempts(args, db, delete_one):
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency, thread_name_prefix="dormant-cleanup",
    ) as executor:
        while True:
            batch = db.execute(
                "SELECT ordinal,object_id,kind,prefix FROM public_attempts "
                "WHERE state!='deleted' ORDER BY object_id LIMIT ?", (args.batch_size,),
            ).fetchall()
            if not batch:
                break
            for ordinal, object_id, kind, prefix in batch:
                bound = args.target_actors if kind == "actors" else args.probe_actors
                valid_prefix = prefix == "dormant" if kind == "actors" else bool(
                    re.fullmatch(r"cardinality-probe-[a-z0-9]([-a-z0-9]*[a-z0-9])?", prefix)
                )
                if (not valid_prefix or not 0 <= ordinal < bound
                        or object_id != public_object_id(args.run_id, ordinal, prefix)):
                    raise RuntimeError("public attempt journal does not match its exact run identity")
            results, errors = bounded_results(
                executor, delete_one, [(row[0], row[1]) for row in batch],
            )
            if results:
                record_public_deletions(db, results)
                for table in ("actors", "probes"):
                    db.executemany(
                        "UPDATE {} SET state='deleted',delete_ms=:delete_ms,"
                        "delete_already_absent=:delete_already_absent,"
                        "operation_retries=operation_retries+:operation_retries "
                        "WHERE actor_id=:object_id".format(table), results,
                    )
                db.commit()
            if errors:
                raise RuntimeError(
                    "{} public cleanup(s) failed; first ordinal {}".format(
                        len(errors), errors[0][0][0],
                    )
                ) from errors[0][1]


def manifest_digest(db: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for table in ("actors", "probes"):
        digest.update(table.encode("ascii") + b"\0")
        rows = db.execute(
            "SELECT ordinal, actor_key, actor_id, runner_name, state, generation "
            "FROM {} ORDER BY ordinal".format(table)
        )
        for row in rows:
            encoded = json.dumps(row, separators=(",", ":")).encode("utf-8")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    digest.update(b"public_attempts\0")
    for row in db.execute(
            "SELECT object_id,kind,ordinal,prefix,state,scheduled_operations "
            "FROM public_attempts ORDER BY object_id"):
        encoded = json.dumps(row, separators=(",", ":")).encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def summarize(args: argparse.Namespace, db: sqlite3.Connection) -> Dict[str, Any]:
    metadata = dict(db.execute("SELECT key, value FROM metadata"))
    actor_states = dict(db.execute("SELECT state, COUNT(*) FROM actors GROUP BY state"))
    probe_states = dict(db.execute("SELECT state, COUNT(*) FROM probes GROUP BY state"))
    attempt_states = dict(db.execute("SELECT state,COUNT(*) FROM public_attempts GROUP BY state"))
    fresh = db.execute("SELECT COUNT(*) FROM actors WHERE created_fresh=1").fetchone()[0]
    idempotent_probe_deletes = db.execute(
        "SELECT COUNT(*) FROM probes WHERE delete_already_absent=1"
    ).fetchone()[0]
    idempotent_cleanup_deletes = db.execute(
        "SELECT COUNT(*) FROM actors WHERE delete_already_absent=1"
    ).fetchone()[0]
    operation_retries = sum(
        db.execute("SELECT COALESCE(SUM(operation_retries), 0) FROM {}".format(table)).fetchone()[0]
        for table in ("actors", "probes")
    )
    if args.mode == "summary":
        verdict = "informational"
    elif args.mode == "populate":
        verdict = (
            "passed"
            if actor_states.get("dormant", 0) == args.target_actors
            else "incomplete"
        )
    elif args.mode == "probe":
        verdict = (
            "passed"
            if actor_states.get("dormant", 0) == args.target_actors
            and probe_states.get("deleted", 0) == args.probe_actors
            else "incomplete"
        )
    else:
        cleanup_complete = (
            actor_states.get("dormant", 0) == 0
            and attempt_states.get("pending", 0) == 0
            and attempt_states.get("confirmed", 0) == 0
        ) if args.api_mode == "workers-v1" else (
            actor_states.get("deleted", 0) == args.target_actors
        )
        verdict = (
            "passed"
            if cleanup_complete and probe_states.get("dormant", 0) == 0
            else "incomplete"
        )
    return {
        "verdict": verdict,
        "manifest_schema_version": metadata["schema_version"],
        "api_mode": args.api_mode,
        "public_api_only": args.api_mode == "workers-v1",
        "cell_id": args.cell_id,
        "run_id": args.run_id,
        "mode": args.mode,
        "target_actors": args.target_actors,
        "batch_size": args.batch_size,
        "batch_settle_seconds": args.batch_settle_seconds,
        "operation_rate": args.operation_rate,
        "max_idempotent_retries": args.max_idempotent_retries,
        "runner_names": args.runner_name,
        "worker_release": (
            {
                "worker": metadata["worker_name"],
                "version_ids": [metadata["version_id"]],
                "deployment_id": metadata["deployment_id"],
                "version_pool_size": int(metadata["version_pool_size"]),
            }
            if args.api_mode == "workers-v1"
            else None
        ),
        "manifest": str(args.manifest.resolve()),
        "manifest_sha256": manifest_digest(db),
        "actor_states": actor_states,
        "probe_states": probe_states,
        "public_attempt_states": attempt_states,
        "public_scheduled_operations": db.execute(
            "SELECT COALESCE(SUM(scheduled_operations),0) FROM public_attempts",
        ).fetchone()[0],
        "created_fresh": fresh,
        "idempotent_delete_retries": {
            "cardinality_probe": idempotent_probe_deletes,
            "cleanup": idempotent_cleanup_deletes,
        },
        "transport_or_overload_retries": operation_retries,
        "latency": {
            "population_create": latency_summary(db, "create_ms", "actors"),
            "population_initial_open": latency_summary(db, "open_ms", "actors"),
            "cardinality_dormant_reopen": latency_summary(db, "reopen_ms", "actors"),
            "cardinality_get_or_create": latency_summary(db, "create_ms", "probes"),
            "cardinality_fresh_create": latency_summary(
                db, "create_ms", "probes", "fresh_create"
            ),
            "cardinality_delete": latency_summary(
                db, "delete_ms", "probes", "committed_delete"
            ),
            "cleanup_delete": latency_summary(
                db, "delete_ms", "actors", "committed_delete"
            ),
        },
        "byte_measurement": (
            "stop every Engine/application writer, then run qualify_fdb_footprint.py twice"
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("populate", "probe", "cleanup", "summary"))
    parser.add_argument("--engine-url", default="http://127.0.0.1:6420")
    parser.add_argument("--api-mode", choices=("actor", "workers-v1"), default="actor")
    parser.add_argument("--workers-url", default="http://127.0.0.1:8080")
    parser.add_argument("--worker-name", default="q01-fdb-autoscale-gate")
    parser.add_argument("--class-name", default=PUBLIC_CLASS_NAME)
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--cell-id", required=True)
    parser.add_argument("--actor-name", default="workerd-counter")
    parser.add_argument("--runner-name", action="append", required=True)
    parser.add_argument("--target-actors", type=int, default=1_000_000)
    parser.add_argument("--probe-actors", type=int, default=10_000)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--batch-settle-seconds", type=float, default=0.0)
    parser.add_argument(
        "--operation-rate",
        type=float,
        default=0.0,
        help="maximum high-level Object operations per second; zero is unbounded",
    )
    parser.add_argument("--max-idempotent-retries", type=int, default=3)
    parser.add_argument("--retry-base-delay-seconds", type=float, default=0.1)
    parser.add_argument("--request-timeout-seconds", type=float, default=180)
    parser.add_argument("--run-id")
    parser.add_argument(
        "--probe-epoch",
        default="default",
        help="stable identity for one create/delete probe phase within a resumed run",
    )
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--execution-site-file", type=pathlib.Path)
    parser.add_argument(
        "--auth-token-env",
        help="environment variable containing an API bearer token; never put tokens on argv",
    )
    parser.add_argument("--output", type=pathlib.Path)
    return parser.parse_args()


def run(args: argparse.Namespace) -> Dict[str, Any]:
    if args.target_actors <= 0:
        raise ValueError("target-actors must be positive")
    if args.probe_actors <= 0 or args.probe_actors > args.target_actors:
        raise ValueError("probe-actors must be positive and no larger than target-actors")
    if args.concurrency <= 0 or args.concurrency > MAX_CONCURRENCY:
        raise ValueError("concurrency must be between 1 and {}".format(MAX_CONCURRENCY))
    if args.batch_size <= 0 or args.batch_size > MAX_BATCH_SIZE:
        raise ValueError("batch-size must be between 1 and {}".format(MAX_BATCH_SIZE))
    if args.batch_settle_seconds < 0 or args.batch_settle_seconds > 300:
        raise ValueError("batch-settle-seconds must be between 0 and 300")
    if args.operation_rate < 0 or args.operation_rate > 1000:
        raise ValueError("operation-rate must be between 0 and 1000")
    if args.max_idempotent_retries < 0 or args.max_idempotent_retries > 10:
        raise ValueError("max-idempotent-retries must be between 0 and 10")
    if args.retry_base_delay_seconds <= 0 or args.retry_base_delay_seconds > 5:
        raise ValueError("retry-base-delay-seconds must be between 0 and 5")
    if not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", args.probe_epoch or "") or len(args.probe_epoch) > 32:
        raise ValueError("probe-epoch must be a safe identity of at most 32 characters")
    if not args.runner_name or any(not name for name in args.runner_name):
        raise ValueError("at least one non-empty runner-name is required")
    validate_cloud_execution(args)
    if args.api_mode == "workers-v1":
        if not args.workers_url.startswith(("http://", "https://")):
            raise ValueError("workers-url must be HTTP(S)")
        if not args.worker_name or not args.class_name:
            raise ValueError("public Worker and class names must be non-empty")
    token = None
    if args.auth_token_env:
        token = os.environ.get(args.auth_token_env)
        if token is None:
            raise ValueError("auth token environment variable is not set")

    with manifest_owner(args.manifest):
        return run_manifest(args, token)


def run_manifest(args, token):
    public_release = None
    db = connect_manifest(args.manifest)
    try:
        existing_run_id = db.execute(
            "SELECT value FROM metadata WHERE key='run_id'"
        ).fetchone()
        if args.run_id is None:
            args.run_id = existing_run_id[0] if existing_run_id else uuid.uuid4().hex
        config = {
            "schema_version": SCHEMA_VERSION,
            "run_id": args.run_id,
            "cell_id": args.cell_id,
            "namespace": args.namespace,
            "actor_name": args.actor_name,
            "runner_names": json.dumps(args.runner_name, separators=(",", ":")),
            "target_actors": str(args.target_actors),
            "probe_actors": str(args.probe_actors),
            "api_mode": args.api_mode,
            "workers_url": args.workers_url if args.api_mode == "workers-v1" else "",
            "worker_name": args.worker_name if args.api_mode == "workers-v1" else "",
            "class_name": args.class_name if args.api_mode == "workers-v1" else "",
            # A large Agent qualification measures the data plane. Every
            # Object in one run intentionally shares one immutable Version;
            # unique-code publication is a separate Code Plane benchmark.
            "version_pool_size": "1" if args.api_mode == "workers-v1" else "0",
        }
        existing = dict(db.execute("SELECT key,value FROM metadata"))
        if existing:
            # Validate the selected endpoint and scope before any Code Plane
            # write. Recovery must not silently publish to another Worker.
            initialize_manifest(db, config)
        if args.api_mode == "workers-v1":
            if args.mode in ("cleanup", "summary"):
                if not existing:
                    raise RuntimeError("public cleanup/summary requires an initialized manifest")
                public_release = {
                    "version_id": existing["version_id"],
                    "deployment_id": existing["deployment_id"],
                }
            else:
                public_release = prepare_public_worker(args)
        config.update({
            "version_id": public_release["version_id"] if public_release else "",
            "deployment_id": public_release["deployment_id"] if public_release else "",
        })
        initialize_manifest(db, config)
        if args.mode == "populate":
            populate(args, db, token)
        elif args.mode == "probe":
            probe(args, db, token)
        elif args.mode == "cleanup":
            cleanup(args, db, token)
        return summarize(args, db)
    finally:
        db.close()


def main() -> int:
    args = parse_args()
    result = run(args)
    encoded = json.dumps(result, indent=2, sort_keys=True)
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(encoded + "\n")
        os.replace(str(temporary), str(args.output))
    return 0 if result["verdict"] in ("passed", "informational") else 1


if __name__ == "__main__":
    raise SystemExit(main())
