#!/usr/bin/env python3
"""Opt-in Engine session-file wiring; rendering reads frozen references only.

References schema 1: cellName, cellUID, namespace, coldBucket, coldSecret
{name, uid, managedBy}. Session JSON matches the Rust provider's four fields.
Live validation reads Secret JSON from stdin, emits no credential data, and
requires the live Cell UID plus exact owner/Secret UIDs. No cloud calls here.
"""

import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path

SESSION_DIR = "/etc/actor/cold-session"
SESSION_FIELDS = {"access_key_id", "secret_access_key", "session_token", "expires_at"}


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode_json(text):
    return json.loads(text, object_pairs_hook=unique_object)


def references(path, cell_name, namespace, cold_bucket):
    refs = decode_json(path.read_text())
    require(set(refs) == {"schema", "cellName", "cellUID", "namespace", "coldBucket", "coldSecret"},
            "references schema differs")
    require(type(refs["schema"]) is int and refs["schema"] == 1, "references version differs")
    require((refs["cellName"], refs["namespace"], refs["coldBucket"]) ==
            (cell_name, namespace, cold_bucket), "references Cell or storage binding differs")
    secret = refs["coldSecret"]
    require(set(secret) == {"name", "uid", "managedBy"}, "Secret references schema differs")
    for value in (cell_name, namespace, secret["name"]):
        require(isinstance(value, str) and len(value) <= 63 and
                re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", value), "invalid resource name")
    for value in (refs["cellUID"], secret["uid"]):
        require(isinstance(value, str) and re.fullmatch(
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value), "invalid frozen UID")
    require(isinstance(secret["managedBy"], str) and len(secret["managedBy"]) <= 63 and
            re.fullmatch(r"[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?", secret["managedBy"]),
            "invalid managed-by label")
    return refs


def validate_secret(secret, cell, refs):
    cm = cell["metadata"]
    require(cell["kind"] == "RivetCell" and cell["apiVersion"] == "fleet.actor.dev/v1alpha1" and
            (cm["name"], cm["namespace"], cm["uid"]) ==
            (refs["cellName"], refs["namespace"], refs["cellUID"]) and
            not cm.get("deletionTimestamp"), "live Cell binding differs")
    m = secret["metadata"]
    require(secret["kind"] == "Secret" and secret["apiVersion"] == "v1" and
            secret["type"] == "Opaque" and secret.get("immutable", False) is False and
            not m.get("deletionTimestamp"), "Secret must be live mutable Opaque")
    require((m["name"], m["namespace"], m["uid"]) ==
            (refs["coldSecret"]["name"], refs["namespace"], refs["coldSecret"]["uid"]),
            "live Secret binding differs")
    labels = m.get("labels", {})
    require(labels.get("fleet.actor.dev/cell-name") == refs["cellName"] and
            labels.get("app.kubernetes.io/managed-by") == refs["coldSecret"]["managedBy"],
            "session Secret labels differ")
    owners = m.get("ownerReferences", [])
    require(len(owners) == 1 and
            (owners[0].get("apiVersion"), owners[0].get("kind"), owners[0].get("name"), owners[0].get("uid")) ==
            ("fleet.actor.dev/v1alpha1", "RivetCell", refs["cellName"], refs["cellUID"]),
            "session Secret exact Cell owner differs")
    require(set(secret["data"]) == {"session.json"} and not secret.get("stringData"),
            "session Secret data schema differs")
    raw = base64.b64decode(secret["data"]["session.json"], validate=True)
    require(len(raw) <= 16384, "session file exceeds provider bound")
    session = decode_json(raw)
    require(set(session) == SESSION_FIELDS, "session tuple schema differs")
    for key in SESSION_FIELDS - {"expires_at"}:
        require(isinstance(session[key], str) and bool(session[key].strip()), "session tuple incomplete")
    expiry = session["expires_at"]
    require(type(expiry) is int and time.time() + 30 < expiry <= 2**64 - 1,
            "session expiry invalid or expiring")
    annotations = m.get("annotations", {})
    require(annotations.get("fleet.actor.dev/session-expiry") == str(expiry),
            "session expiry annotation differs")
    generation = annotations.get("fleet.actor.dev/session-generation")
    require(isinstance(generation, str) and re.fullmatch(r"(?:[0-9a-f]{24}|[0-9a-f]{32})", generation),
            "session generation annotation invalid")


def replace_once(text, old, new):
    require(text.count(old) == 1, "Engine render anchor differs")
    return text.replace(old, new, 1)


def render(document, refs):
    cell = refs["cellName"]
    marker = f"kind: Deployment\nmetadata:\n  name: {cell}-engine\n"
    docs = document.split("\n---\n")
    indexes = [i for i, doc in enumerate(docs) if marker in doc]
    require(len(indexes) == 1, "expected exactly one Engine Deployment")
    index = indexes[0]
    engine = docs[index]
    require(f"\n  namespace: {refs['namespace']}\n" in engine and
            "          envFrom:" not in engine, "Engine namespace or envFrom differs")
    legacy = "".join(
        f"            - name: {key}\n"
        "              valueFrom:\n"
        "                secretKeyRef:\n"
        f"                  name: {cell}-runtime-cos\n"
        f"                  key: {key}\n"
        for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
    )
    engine = replace_once(engine, legacy,
                          "            - name: ACTOR_COLD_STORAGE_SESSION_FILE\n"
                          f"              value: {SESSION_DIR}/session.json\n")
    require(not any(f"- name: {name}\n" in engine for name in
                    ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")),
            "file mode must not retain static AWS credentials")
    engine = replace_once(engine, "          volumeMounts:\n",
                          "          volumeMounts:\n"
                          "            - name: cold-session\n"
                          f"              mountPath: {SESSION_DIR}\n"
                          "              readOnly: true\n")
    engine = replace_once(engine, "      volumes:\n", "      volumes:\n"
                          "        - name: cold-session\n"
                          "          secret:\n"
                          f"            secretName: {refs['coldSecret']['name']}\n"
                          "            defaultMode: 288\n")
    docs[index] = engine
    return "\n---\n".join(docs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("references", "validate-secret", "render"))
    parser.add_argument("--references", type=Path, required=True)
    parser.add_argument("--cell-name", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--cold-bucket", required=True)
    parser.add_argument("--cell-json", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    refs = references(args.references, args.cell_name, args.namespace, args.cold_bucket)
    if args.action == "references":
        print(json.dumps(refs, sort_keys=True, separators=(",", ":")))
    elif args.action == "validate-secret":
        require(args.cell_json is not None, "live Cell JSON required")
        # No printing of input or exceptions: JSON parser errors may contain secrets.
        raw = sys.stdin.read(65537)
        require(len(raw) <= 65536, "Secret JSON exceeds input bound")
        validate_secret(decode_json(raw), decode_json(args.cell_json.read_text()), refs)
    else:
        require(args.input is not None and args.output is not None, "render input/output required")
        args.output.write_text(render(args.input.read_text(), refs))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, AttributeError):
        print("cold session references, live identity, schema or render validation failed", file=sys.stderr)
        raise SystemExit(1)
