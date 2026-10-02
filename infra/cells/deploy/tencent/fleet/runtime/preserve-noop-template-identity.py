#!/usr/bin/env python3
"""Keep a workload identity stable when only its identity annotation changed."""

import argparse
import copy
import json
from pathlib import Path
import re


ANNOTATION = "fleet.actor.dev/manifest-sha256"
IDENTITY = re.compile(r"^[0-9a-f]{64}$")


def template(document):
    value = copy.deepcopy(document["spec"]["template"])
    annotations = value.get("metadata", {}).get("annotations", {})
    annotations.pop(ANNOTATION, None)
    return value


def related_data(path):
    if path is None:
        return None
    return json.loads(path.read_text()).get("data", {})


def patch_manifest(path, kind, name, old, new):
    text = path.read_text()
    documents = text.split("\n---\n")
    matches = []
    for index, document in enumerate(documents):
        framed = "\n" + document + "\n"
        if f"\nkind: {kind}\n" in framed and f"\n  name: {name}\n" in framed:
            matches.append(index)
    if len(matches) != 1:
        raise SystemExit(f"manifest {path} does not contain exactly one {kind}/{name}")
    index = matches[0]
    wanted = f"fleet.actor.dev/manifest-sha256: {old}"
    replacement = f"fleet.actor.dev/manifest-sha256: {new}"
    if documents[index].count(wanted) != 1:
        raise SystemExit(f"manifest {path} does not contain the expected candidate identity")
    documents[index] = documents[index].replace(wanted, replacement, 1)
    temporary = path.with_name("." + path.name + ".identity.tmp")
    temporary.write_text("\n---\n".join(documents))
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--kind", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--related-live", type=Path)
    parser.add_argument("--related-candidate", type=Path)
    parser.add_argument("--require-noop", action="store_true")
    parser.add_argument("--probe-only", action="store_true")
    args = parser.parse_args()
    if (args.related_live is None) != (args.related_candidate is None):
        parser.error("related live and candidate documents must be supplied together")

    live = json.loads(args.live.read_text())
    candidate = json.loads(args.candidate.read_text())
    for document, label in ((live, "live"), (candidate, "candidate")):
        if document.get("kind") != args.kind or document.get("metadata", {}).get("name") != args.name:
            raise SystemExit(f"{label} workload identity mismatch")
    live_identity = live["spec"]["template"].get("metadata", {}).get("annotations", {}).get(ANNOTATION, "")
    candidate_identity = candidate["spec"]["template"].get("metadata", {}).get("annotations", {}).get(ANNOTATION, "")
    if not IDENTITY.fullmatch(live_identity) or not IDENTITY.fullmatch(candidate_identity):
        raise SystemExit("workload template identity is missing or malformed")

    same = template(live) == template(candidate)
    if args.related_live is not None:
        same = same and related_data(args.related_live) == related_data(args.related_candidate)
    if args.probe_only:
        print(json.dumps({
            "noop": same,
            "live_identity": live_identity,
            "candidate_identity": candidate_identity,
        }, sort_keys=True))
        if args.require_noop and not same:
            raise SystemExit("effective workload differs while a no-op release was required")
        return
    if not same:
        if args.require_noop:
            raise SystemExit("effective workload differs while a no-op release was required")
        print("preserved=false")
        return
    if live_identity == candidate_identity:
        print("preserved=false unchanged=true")
        return
    for manifest in args.manifest:
        patch_manifest(manifest, args.kind, args.name, candidate_identity, live_identity)
    print(f"preserved=true identity={live_identity}")


if __name__ == "__main__":
    main()
