#!/usr/bin/env python3
"""Offline Host drain profile transformation/check. Never contacts Kubernetes."""

import copy
import json
from pathlib import Path
import re
import sys


PROFILE_ANNOTATION = "fleet.actor.dev/host-drain-profile"
PROFILES = {"production": ("5m", "5s"), "exploration": ("30s", "2s")}
TIMERS = ("HOST_DRAIN_STABILIZATION", "HOST_DRAIN_RECONCILE_INTERVAL")
FIXED_GUARDS = {
    "HOST_DRAIN_TIMEOUT": "10m",
    "HOST_DRAIN_METRICS_FRESHNESS": "45s",
    "HOST_DRAIN_REQUIRED_ZONES": "3",
    "HOST_DRAIN_TOPOLOGY_KEY": "topology.kubernetes.io/zone",
    "HOST_DRAIN_MAX_REMAINING_USAGE_PERCENT": "70",
}
MAX_INPUT_BYTES = 1024 * 1024


def controller_parts(document):
    if (
        not isinstance(document, dict)
        or document.get("apiVersion") != "apps/v1"
        or document.get("kind") != "Deployment"
    ):
        raise ValueError("expected Host drain Deployment")
    metadata = document.get("metadata", {})
    if (
        not isinstance(metadata, dict)
        or metadata.get("labels", {}).get("fleet.actor.dev/component") != "host-drain-controller"
    ):
        raise ValueError("wrong controller component")
    template = document["spec"]["template"]
    annotations = template["metadata"]["annotations"]
    if (
        not isinstance(annotations, dict)
        or annotations.get("fleet.actor.dev/runtime-release-hold-protocol") != "statefulset-uid-cas-v1"
    ):
        raise ValueError("release hold protocol missing")
    containers = template["spec"]["containers"]
    if not isinstance(containers, list) or len(containers) != 1:
        raise ValueError("expected one controller container")
    container = containers[0]
    if (
        container.get("name") != "controller"
        or container.get("command") != ["/usr/local/bin/workerd-host-drain-controller"]
    ):
        raise ValueError("wrong controller entrypoint")
    entries = container["env"]
    if not isinstance(entries, list):
        raise ValueError("environment list required")
    env = {}
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("name"), str)
            or not entry["name"]
            or entry["name"] in env
        ):
            raise ValueError("invalid or duplicate environment entry")
        env[entry["name"]] = entry
    for name, value in FIXED_GUARDS.items():
        if env.get(name) != {"name": name, "value": value}:
            raise ValueError("fixed drain guard changed")
    for name in TIMERS:
        if (
            name not in env
            or set(env[name]) != {"name", "value"}
            or not isinstance(env[name]["value"], str)
        ):
            raise ValueError("literal drain timers required")
    return annotations, env


def profile_of(document):
    annotations, env = controller_parts(document)
    # Existing production manifests have no annotation. Never infer exploration
    # from short timers alone; only the complete named contract is classifiable.
    profile = annotations.get(PROFILE_ANNOTATION, "production")
    if not isinstance(profile, str) or profile not in PROFILES:
        raise ValueError("unknown profile")
    if tuple(env[name]["value"] for name in TIMERS) != PROFILES[profile]:
        raise ValueError("profile marker and timers disagree")
    return profile


def check_profile(document, expected):
    if expected not in PROFILES or profile_of(document) != expected:
        raise ValueError("unexpected profile")


def render_profile(document, profile):
    if profile not in PROFILES:
        raise ValueError("unknown profile")
    profile_of(document)  # Reject drift instead of silently overwriting it.
    result = copy.deepcopy(document)
    annotations, env = controller_parts(result)
    for name, value in zip(TIMERS, PROFILES[profile]):
        env[name]["value"] = value
    if profile == "production":
        annotations.pop(PROFILE_ANNOTATION, None)
    else:
        annotations[PROFILE_ANNOTATION] = profile
    return result


def render_bundle(document, profile):
    if not isinstance(document, dict) or document.get("kind") != "List":
        return render_profile(document, profile)
    if document.get("apiVersion") != "v1" or set(document) - {"apiVersion", "kind", "metadata", "items"}:
        raise ValueError("invalid manifest List")
    items = document.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 32:
        raise ValueError("bounded manifest List required")
    allowed = {
        "ServiceAccount", "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding",
        "HorizontalPodAutoscaler", "Deployment",
    }
    identities, targets = set(), []
    for index, item in enumerate(items):
        if not isinstance(item, dict) or item.get("kind") not in allowed:
            raise ValueError("unexpected manifest resource")
        metadata = item.get("metadata", {})
        if not isinstance(metadata, dict):
            raise ValueError("resource metadata required")
        name, namespace = metadata.get("name"), metadata.get("namespace", "")
        if not isinstance(name, str) or not name or not isinstance(namespace, str):
            raise ValueError("resource identity missing")
        identity = (item["kind"], namespace, name)
        if identity in identities:
            raise ValueError("duplicate manifest resource")
        identities.add(identity)
        if item["kind"] == "Deployment":
            targets.append(index)
    if len(targets) != 1:
        raise ValueError("exactly one controller required")
    result = copy.deepcopy(document)
    result["items"][targets[0]] = render_profile(items[targets[0]], profile)
    return result


def transition_patch(document, profile):
    """Change only the profile on one existing, installer-owned controller."""
    rendered = render_profile(document, profile)
    replicas = document["spec"].get("replicas")
    if type(replicas) is not int or replicas != 1 or document["spec"].get("strategy", {}).get("type") != "Recreate":
        raise ValueError("single-writer Recreate controller required")
    metadata = document["metadata"]
    for name in ("uid", "resourceVersion", "name", "namespace"):
        value = metadata.get(name)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", value):
            raise ValueError("live controller identity required")
    annotations = metadata.get("annotations", {})
    labels = metadata.get("labels", {})
    if (
        "argocd.argoproj.io/tracking-id" in annotations
        or "argocd.argoproj.io/instance" in annotations
        or "argocd.argoproj.io/instance" in labels
        or "app.kubernetes.io/instance" in labels
        or any("argocd" in str(item.get("manager", "")).lower()
               for item in metadata.get("managedFields", []))
    ):
        raise ValueError("controller has another declarative owner")
    container = document["spec"]["template"]["spec"]["containers"][0]
    if not re.fullmatch(r"[^\s]+/actor-fleet/actor-fleet-controller@sha256:[0-9a-f]{64}",
                        str(container.get("image", ""))):
        raise ValueError("immutable controller image required")
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
    ]
    values = dict(zip(TIMERS, PROFILES[profile]))
    for index, entry in enumerate(container["env"]):
        if entry["name"] in values:
            patch.append({"op": "replace",
                          "path": f"/spec/template/spec/containers/0/env/{index}/value",
                          "value": values[entry["name"]]})
    path = "/spec/template/metadata/annotations/" + PROFILE_ANNOTATION.replace("~", "~0").replace("/", "~1")
    before = document["spec"]["template"]["metadata"]["annotations"]
    after = rendered["spec"]["template"]["metadata"]["annotations"]
    if PROFILE_ANNOTATION in after:
        patch.append({"op": "add", "path": path, "value": after[PROFILE_ANNOTATION]})
    elif PROFILE_ANNOTATION in before:
        patch.append({"op": "remove", "path": path})
    return patch


def check_transition(before, after, profile):
    transition_patch(before, profile)
    # Revalidate ownership and literal guards at the final evidence boundary.
    transition_patch(after, profile)
    check_profile(after, profile)
    for name in ("uid", "name", "namespace"):
        if before["metadata"][name] != after["metadata"][name]:
            raise ValueError("controller identity changed")
    if render_profile(before, "production")["spec"] != render_profile(after, "production")["spec"]:
        raise ValueError("unrelated controller spec changed")


def parse_document(raw):
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("input too large")
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("duplicate JSON field")
        result[name] = value
    return result


def reject_constant(_value):
    raise ValueError("non-finite JSON constant")


def main():
    args = sys.argv[1:]
    valid = (len(args) == 2 and args[0] in ("render", "check", "patch")) or (
        len(args) == 3 and args[0] == "check-transition")
    if not valid or args[1] not in PROFILES:
        print("usage: host-drain-profile.py render|check|patch production|exploration < deployment.json; check-transition PROFILE BEFORE_FILE < after.json", file=sys.stderr)
        return 2
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        document = parse_document(raw)
        if args[0] in ("render", "patch"):
            rendered = (render_bundle if args[0] == "render" else transition_patch)(document, args[1])
            encoded = json.dumps(rendered, ensure_ascii=False, allow_nan=False)
            sys.stdout.write(encoded + "\n")
        elif args[0] == "check-transition":
            before_path = Path(args[2])
            if before_path.is_symlink() or not before_path.is_file():
                raise ValueError("before input must be a regular file")
            with before_path.open("rb") as source:
                before = parse_document(source.read(MAX_INPUT_BYTES + 1))
            check_transition(before, document, args[1])
        else:
            check_profile(document, args[1])
        return 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        # Do not echo the supplied object, raw values, URL, or exception text.
        print("Host drain profile input rejected", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
