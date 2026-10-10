#!/usr/bin/env python3
"""Build/cold-verify ONE pinned worker overlay; quarantine only, never a product receipt.

Source labels describe the inherited parent, not a full-source A3 build. This
entry point cannot promote an inventory, touch Kubernetes, or bypass release gates.
An interrupted push must be reconciled, never repeated.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import gzip
import io
import json
import os
import re
import stat
import subprocess
import tempfile
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOST = "actor-fleet-beijing.tencentcloudcr.com"
REPOSITORY = "actor-fleet/rivet-runtime"
PARENT = HOST + "/" + REPOSITORY + "@sha256:9b925bb50e6ca9bcdd21ca6f1856cc8a4d9b83c7a5b5979a2b18c70af5be869b"
PARENT_REV = "20ab5f0cfffedef22dca468fec78cbc9de9f0036"
PARENT_MANIFEST = "408177c107a2af29d3dfb380130cabfce5eef883ff42d35bb4c4baaba0bc071d"
OVERLAY_REV = "a3ed8e6ffb6cbcebd072de3dd7bc3bb91ebe505c"
OVERLAY_SHA = "52063187c546d4e413540061270c22c08cc918a4b1bfb9599717b710ef31d7cd"
WORKER = "opt/actor/share/worker.js"
LABELS = {
    "fleet.actor.dev/composition-kind": "worker-js-overlay/v1",
    "fleet.actor.dev/composition-parent-image": PARENT,
    "fleet.actor.dev/composition-status": "quarantine",
    "fleet.actor.dev/overlay-path": "/" + WORKER,
    "fleet.actor.dev/overlay-source-revision": OVERLAY_REV,
    "fleet.actor.dev/overlay-worker-js-sha256": OVERLAY_SHA,
}
BINARY_LABELS = {
    "opt/actor/bin/rivet-engine": "fleet.actor.dev/engine-sha256",
    "opt/actor/bin/workerd": "fleet.actor.dev/workerd-sha256",
    "opt/actor/bin/rivet-workerd-host": "fleet.actor.dev/workerd-host-sha256",
    "opt/actor/share/stateless-worker.js": "fleet.actor.dev/stateless-worker-js-sha256",
}


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value):
    return "sha256:" + hashlib.sha256(encoded(value)).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_new(path, value):
    # Never overwrite an immutable receipt.
    data = encoded(value)
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o600)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Registry:
    def __init__(self, auth):
        require(auth.is_file() and not auth.is_symlink() and not auth.stat().st_mode & 0o077,
                "registry auth must be a private regular file")
        self.basic = json.loads(auth.read_text())["auths"][HOST]["auth"]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.bearer = None

    def request(self, path, method="GET", accept="application/json"):
        url = "https://" + HOST + "/v2/" + REPOSITORY + "/" + path
        headers = {"Accept": accept}
        if self.bearer:
            headers["Authorization"] = "Bearer " + self.bearer
        try:
            return self.opener.open(urllib.request.Request(url, method=method, headers=headers), timeout=60)
        except urllib.error.HTTPError as error:
            if error.code != 401 or self.bearer:
                raise
            challenge = error.headers.get("WWW-Authenticate", "")
            require(challenge.lower().startswith("bearer "), "unsupported registry challenge")
            fields = dict(re.findall(r'([A-Za-z]+)="([^"]*)"', challenge))
            realm = urllib.parse.urlsplit(fields["realm"])
            require(realm.scheme == "https" and realm.hostname == HOST and not realm.username,
                    "registry token realm is outside the pinned registry")
            query = urllib.parse.parse_qsl(realm.query) + [
                ("service", fields.get("service", HOST)),
                ("scope", "repository:" + REPOSITORY + ":pull"),
            ]
            token_url = urllib.parse.urlunsplit((realm.scheme, realm.netloc, realm.path,
                                                urllib.parse.urlencode(query), ""))
            request = urllib.request.Request(token_url, headers={"Authorization": "Basic " + self.basic})
            with self.opener.open(request, timeout=60) as response:
                token = json.load(response)
            self.bearer = token.get("token") or token.get("access_token")
            require(isinstance(self.bearer, str), "registry did not issue a read token")
            return self.request(path, method, accept)

    def manifest(self, reference):
        accept = "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"
        with self.request("manifests/" + reference, accept=accept) as response:
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "manifest is too large")
            identity = "sha256:" + hashlib.sha256(raw).hexdigest()
            require(response.headers.get("Docker-Content-Digest") == identity,
                    "registry manifest digest does not match its bytes")
        manifest = json.loads(raw)
        require(manifest.get("schemaVersion") == 2 and "config" in manifest and "layers" in manifest,
                "only one exact platform image is supported")
        config_digest = manifest["config"]["digest"]
        response = self.blob_response(config_digest)
        with response:
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024 and "sha256:" + hashlib.sha256(raw).hexdigest() == config_digest,
                    "registry config digest does not match its bytes")
        return identity, manifest, json.loads(raw)

    def blob_response(self, identity):
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", identity), "invalid blob digest")
        try:
            return self.request("blobs/" + identity)
        except urllib.error.HTTPError as error:
            # Authenticated TCR redirects blobs to this exact backing bucket.
            # The external request receives NO registry Authorization.
            require(error.code == 307, "unexpected registry blob response")
            location = error.headers.get("Location", "")
            target = urllib.parse.urlsplit(location)
            require(target.scheme == "https" and target.hostname ==
                    "tcr-q9w0spg4-1388575217.cos.ap-beijing.myqcloud.com"
                    and not target.username and not target.password and not target.fragment,
                    "blob redirect is outside the pinned TCR backing bucket")
            return self.opener.open(urllib.request.Request(location), timeout=60)

    def materialize_blob(self, descriptor, directory):
        identity, expected_size = descriptor["digest"], descriptor["size"]
        require(isinstance(expected_size, int) and 0 <= expected_size <= 2 * 1024**3,
                "blob size is outside the bounded image contract")
        path = directory / identity.split(":", 1)[1]
        if path.exists():
            require(path.stat().st_size == expected_size and "sha256:" + file_hash(path) == identity,
                    "existing OCI blob differs")
            return
        hasher = hashlib.sha256(); size = 0
        with self.blob_response(identity) as response, path.open("xb") as stream:
            while True:
                block = response.read(4 * 1024 * 1024)
                if not block:
                    break
                size += len(block)
                require(size <= expected_size, "blob exceeded its descriptor size")
                hasher.update(block); stream.write(block)
        require(size == expected_size and "sha256:" + hasher.hexdigest() == identity,
                "parent layer blob differs from immutable manifest")

    def absent(self, tag):
        try:
            response = self.request("manifests/" + tag, method="HEAD")
        except urllib.error.HTTPError as error:
            require(error.code == 404, "new tag absence is unproven")
            return
        response.close()
        raise ValueError("tag already exists; refusing overwrite")


def root_inventory(root):
    # Extracted directory mtimes are storage-driver artifacts. Attest contents,
    # links, hardlink topology, ownership, modes, device identities and xattrs.
    # Regular-file mtimes are included; only the replacement's mtime may change.
    records, links = {}, {}
    def visit(path, relative):
        metadata = path.lstat()
        row = {"mode": stat.S_IMODE(metadata.st_mode), "uid": metadata.st_uid, "gid": metadata.st_gid}
        row["xattrs"] = {key: base64.b64encode(os.getxattr(path, key, follow_symlinks=False)).decode()
                         for key in sorted(os.listxattr(path, follow_symlinks=False))}
        if stat.S_ISREG(metadata.st_mode):
            row.update(kind="file", bytes=metadata.st_size, sha256=file_hash(path), mtimeNs=metadata.st_mtime_ns)
            if metadata.st_nlink > 1:
                links.setdefault((metadata.st_dev, metadata.st_ino), []).append(relative)
        elif stat.S_ISLNK(metadata.st_mode):
            row.update(kind="symlink", target=os.readlink(path))
        elif stat.S_ISDIR(metadata.st_mode):
            row["kind"] = "directory"
        elif stat.S_ISCHR(metadata.st_mode) or stat.S_ISBLK(metadata.st_mode):
            row.update(kind="device", rdev=metadata.st_rdev)
        elif stat.S_ISFIFO(metadata.st_mode):
            row["kind"] = "fifo"
        else:
            raise ValueError("unsupported rootfs object")
        records[relative] = row
        if row["kind"] == "directory":
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                visit(child, child.name if relative == "." else relative + "/" + child.name)
    visit(root, ".")
    return records, sorted(sorted(group) for group in links.values())


class Operation:
    def __init__(self, args):
        self.args = args
        self.root = args.operation_dir
        require(self.root.is_absolute() and self.root.resolve() == self.root
                and str(self.root).startswith("/var/lib/actor-build/runtime-workspace/website-worker-overlay-")
                and self.root.is_dir() and self.root.stat().st_mode & 0o777 == 0o700,
                "operation directory must be a private dedicated builder path")
        require(re.fullmatch(r"website-readiness-overlay-20ab-a3-[0-9a-f]{24}", args.tag), "tag is not quarantine-scoped")
        require(args.worker.is_file() and not args.worker.is_symlink() and file_hash(args.worker) == OVERLAY_SHA,
                "worker is not the exact reviewed A3 blob")
        self.registry = Registry(args.registry_auth_file)
        self.ledger = self.root / "composition-ledger.json"
        if args.command == "build-and-push":
            require(not self.ledger.exists(), "existing operation must be reconciled, never reissued")
            self.state = {"schema": "actor-worker-overlay-operation/v1", "phase": "planned", "tag": args.tag,
                          "parent": PARENT, "overlaySha256": OVERLAY_SHA, "pushCallCount": 0}
            write_new(self.ledger, self.state)
        else:
            self.state = json.loads(self.ledger.read_text())
            require(self.state["tag"] == args.tag and self.state["parent"] == PARENT
                    and self.state["overlaySha256"] == OVERLAY_SHA, "operation binding differs")
        self.log = self.root / "composition-command-private.log"

    def save(self, **fields):
        self.state.update(fields)
        temporary = self.ledger.with_suffix(".part")
        with temporary.open("wb") as stream:
            stream.write(encoded(self.state)); stream.flush(); os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, self.ledger)

    def run(self, command, timeout=900):
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        with self.log.open("ab") as log:
            log.write(result.stdout); log.write(result.stderr)
        self.log.chmod(0o600)
        if result.returncode:
            self.save(commandExit=result.returncode,
                      failureMarkers=[x for x in ["No space left", "unauthorized", "denied", "x509", "timed out"]
                                      if x.lower().encode() in result.stderr.lower()])
            raise RuntimeError("image command failed; private diagnostic retained")
        return result.stdout.decode().strip()

    def buildah(self, graph):
        return [os.environ.get("BUILDAH", "buildah"), "--root", str(graph / "storage"),
                "--runroot", str(graph / "runroot"), "--storage-driver", "vfs"]

    def mounted(self, graph, ref):
        command = self.buildah(graph)
        container = self.run(command + ["from", "--authfile", str(self.args.registry_auth_file), ref])
        try:
            mount = Path(self.run(command + ["mount", container]))
            records, links = root_inventory(mount)
            return records, links
        finally:
            try:
                self.run(command + ["unmount", container])
            finally:
                self.run(command + ["rm", container])

    def verify_parent(self, manifest, config):
        require(config.get("os") == "linux" and config.get("architecture") == "amd64", "parent platform differs")
        labels = config["config"].get("Labels", {})
        require(not any(key.startswith(("fleet.actor.dev/composition-", "fleet.actor.dev/overlay-")) for key in labels),
                "parent already has composition lineage")
        require(labels.get("org.opencontainers.image.revision") == PARENT_REV
                and labels.get("fleet.actor.dev/source-revision") == PARENT_REV
                and labels.get("fleet.actor.dev/source-manifest-sha256") == PARENT_MANIFEST,
                "immutable parent source identity differs")
        return labels

    def compare(self, parent_manifest, parent_config, candidate_manifest, candidate_config,
                parent_records, parent_links, candidate_records, candidate_links):
        inherited = self.verify_parent(parent_manifest, parent_config)
        config = json.loads(json.dumps(candidate_config["config"]))
        candidate_labels = config.get("Labels", {})
        require(candidate_labels == {**inherited, **LABELS}, "candidate altered inherited labels or lineage")
        config["Labels"] = inherited
        require(config == parent_config["config"], "startup/user/environment/config differs from parent")
        for key in ["os", "architecture", "variant", "os.version", "os.features"]:
            require(candidate_config.get(key) == parent_config.get(key), "candidate platform changed")
        base_layers = parent_manifest["layers"]
        require(candidate_manifest["layers"][:len(base_layers)] == base_layers,
                "candidate does not preserve the exact parent layer chain")
        base_diffids = parent_config["rootfs"]["diff_ids"]
        require(candidate_config["rootfs"]["diff_ids"][:len(base_diffids)] == base_diffids,
                "candidate rootfs lineage differs")
        require(parent_links == candidate_links, "candidate changed hardlink topology")
        changed = sorted(key for key in set(parent_records) | set(candidate_records)
                         if parent_records.get(key) != candidate_records.get(key))
        require(changed == [WORKER], "rootfs delta is not the one allowed worker file")
        old, new = parent_records[WORKER], candidate_records[WORKER]
        require(old["sha256"] == inherited.get("fleet.actor.dev/worker-js-sha256")
                and new["sha256"] == OVERLAY_SHA and old["kind"] == new["kind"] == "file",
                "worker bytes differ from the parent/overlay identities")
        require({k:v for k,v in old.items() if k not in ["sha256", "bytes", "mtimeNs"]}
                == {k:v for k,v in new.items() if k not in ["sha256", "bytes", "mtimeNs"]},
                "replacement changed worker permissions/ownership/xattrs")
        for path, label in BINARY_LABELS.items():
            require(parent_records[path]["sha256"] == inherited.get(label)
                    and candidate_records[path] == parent_records[path], "parent binary attestation differs")
        return {"allowedPaths": ["/" + WORKER], "changedPaths": ["/" + WORKER],
                "unchangedEntries": len(parent_records)-1, "parentInventoryDigest": digest(parent_records),
                "candidateInventoryDigest": digest(candidate_records), "startupConfigDigest": digest(config),
                "hardlinksEqual": True, "directoryMtimesAttested": False,
                "fileMtimesAttested": True, "binaryHashes": {path: parent_records[path]["sha256"] for path in BINARY_LABELS}}

    def cold_verify(self):
        self.save(phase="cold_verifying")
        parent_digest, parent_manifest, parent_config = self.registry.manifest(PARENT.split("@", 1)[1])
        candidate_digest, candidate_manifest, candidate_config = self.registry.manifest(self.args.tag)
        require(parent_digest == PARENT.split("@", 1)[1], "parent digest changed")
        require(not self.state.get("pushDigest") or candidate_digest == self.state["pushDigest"],
                "remote candidate digest differs from the original push")
        require(candidate_manifest["config"]["digest"] == "sha256:" + self.state["imageId"],
                "remote candidate config differs from the built image")
        self.verify_parent(parent_manifest, parent_config)
        with tempfile.TemporaryDirectory(prefix="actor-overlay-cold.", dir="/data/tmp") as directory:
            graph = Path(directory)
            command = self.buildah(graph)
            ref = HOST + "/" + REPOSITORY + "@" + candidate_digest
            self.run(command + ["pull", "--quiet", "--authfile", str(self.args.registry_auth_file), "docker://" + PARENT])
            self.run(command + ["pull", "--quiet", "--authfile", str(self.args.registry_auth_file), "docker://" + ref])
            parent_records, parent_links = self.mounted(graph, PARENT)
            candidate_records, candidate_links = self.mounted(graph, ref)
            proof = self.compare(parent_manifest, parent_config, candidate_manifest, candidate_config,
                                 parent_records, parent_links, candidate_records, candidate_links)
        receipt = {"schema": "actor-runtime-worker-overlay-quarantine/v1", "verificationVerdict": "passed",
                   "qualification": "quarantine", "promotionEligible": False, "jointAcceptanceReady": False,
                   "compositionRecipeSha256": file_hash(Path(__file__)),
                   "ref": ref, "parent": {"ref": PARENT, "configDigest": parent_manifest["config"]["digest"],
                                           "sourceRevision": PARENT_REV, "sourceManifestDigest": "sha256:"+PARENT_MANIFEST},
                   "overlay": {"path": "/"+WORKER, "sourceRevision": OVERLAY_REV, "sha256": OVERLAY_SHA},
                   "lineageLabels": LABELS, "candidateConfigDigest": candidate_manifest["config"]["digest"],
                   "registryColdPullVerified": True, "rootfsProof": proof,
                   "processQualificationVerified": False, "completeInventoryAccepted": False,
                   "pushCallCount": self.state["pushCallCount"], "runtimeDeployed": False}
        output = self.root / "quarantine-composition-receipt.json"
        if output.exists():
            require(output.read_bytes() == encoded(receipt), "immutable quarantine receipt differs")
        else:
            write_new(output, receipt)
        self.save(phase="quarantined", candidateRef=ref, receiptSha256=file_hash(output))
        print(json.dumps({"phase": "quarantined", "candidateRef": ref, "receipt": receipt,
                          "receiptSha256": file_hash(output)}, sort_keys=True))

    def execute(self):
        if self.args.command == "reconcile":
            require(self.state.get("pushCallCount") == 1 and self.state.get("imageId"),
                    "no original push to reconcile; will not issue a push")
            return self.cold_verify()
        self.registry.absent(self.args.tag)
        parent_digest, parent_manifest, parent_config = self.registry.manifest(PARENT.split("@",1)[1])
        require(parent_digest == PARENT.split("@",1)[1], "parent digest differs")
        self.verify_parent(parent_manifest, parent_config)
        require(os.statvfs("/data/tmp").f_bavail * os.statvfs("/data/tmp").f_frsize > 4*1024**3,
                "insufficient isolated image workspace space")
        with tempfile.TemporaryDirectory(prefix="actor-overlay-build.", dir="/data/tmp") as directory:
            graph = Path(directory)
            command = self.buildah(graph)
            self.save(phase="pulling_parent")
            self.run(command + ["pull", "--quiet", "--authfile", str(self.args.registry_auth_file), "docker://"+PARENT])
            parent_records, parent_links = self.mounted(graph, PARENT)
            metadata = parent_records[WORKER]
            require(metadata["kind"] == "file" and not metadata["xattrs"],
                    "replacement requires an ordinary parent file without xattrs")
            self.save(phase="composing_exact_oci")
            layout = graph / "composition-oci"
            blobs = layout / "blobs" / "sha256"
            blobs.mkdir(parents=True)
            # Copy authenticated original layer bytes, preserving every descriptor.
            for descriptor in parent_manifest["layers"]:
                self.registry.materialize_blob(descriptor, blobs)
            payload = self.args.worker.read_bytes()
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
                member = tarfile.TarInfo(WORKER)
                member.size = len(payload); member.uid = metadata["uid"]; member.gid = metadata["gid"]
                member.mode = metadata["mode"]
                member.mtime = metadata["mtimeNs"] // 10**9
                member.pax_headers = {"mtime": str(metadata["mtimeNs"] // 10**9) + "." +
                                      str(metadata["mtimeNs"] % 10**9).zfill(9)}
                tar.addfile(member, io.BytesIO(payload))
            uncompressed = archive.getvalue()
            layer = gzip.compress(uncompressed, mtime=0)
            layer_sha = hashlib.sha256(layer).hexdigest()
            (blobs / layer_sha).write_bytes(layer)
            candidate_config = json.loads(json.dumps(parent_config))
            candidate_config["config"]["Labels"] = {**parent_config["config"].get("Labels", {}), **LABELS}
            candidate_config["rootfs"]["diff_ids"].append("sha256:" + hashlib.sha256(uncompressed).hexdigest())
            candidate_config.setdefault("history", []).append({
                "created_by": "exact immutable parent + reviewed worker.js overlay (quarantine)",
                "empty_layer": False,
            })
            config_bytes = encoded(candidate_config)
            image_id = hashlib.sha256(config_bytes).hexdigest()
            (blobs / image_id).write_bytes(config_bytes)
            candidate_manifest = json.loads(json.dumps(parent_manifest))
            candidate_manifest["config"]["digest"] = "sha256:" + image_id
            candidate_manifest["config"]["size"] = len(config_bytes)
            oci = parent_manifest.get("mediaType") == "application/vnd.oci.image.manifest.v1+json"
            layer_type = "application/vnd.oci.image.layer.v1.tar+gzip" if oci else "application/vnd.docker.image.rootfs.diff.tar.gzip"
            candidate_manifest["layers"].append({"mediaType": layer_type, "digest": "sha256:"+layer_sha, "size": len(layer)})
            manifest_bytes = encoded(candidate_manifest)
            manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
            (blobs / manifest_sha).write_bytes(manifest_bytes)
            (layout / "oci-layout").write_bytes(encoded({"imageLayoutVersion": "1.0.0"}))
            (layout / "index.json").write_bytes(encoded({"schemaVersion": 2, "manifests": [{
                "mediaType": candidate_manifest["mediaType"], "digest": "sha256:"+manifest_sha,
                "size": len(manifest_bytes), "annotations": {"org.opencontainers.image.ref.name": "quarantine"},
            }]}))
            self.run(command + ["pull", "--quiet", "oci:"+str(layout)+":quarantine"])
            tag = HOST + "/" + REPOSITORY + ":" + self.args.tag
            self.run(command + ["tag", image_id, tag])
            self.save(phase="built", imageId=image_id, localManifestDigest="sha256:"+manifest_sha)
            candidate_records, candidate_links = self.mounted(graph, image_id)
            proof = self.compare(parent_manifest, parent_config, candidate_manifest, candidate_config,
                                 parent_records, parent_links, candidate_records, candidate_links)
            self.save(phase="local_verified", localRootfsProof=proof)
            self.registry.absent(self.args.tag)
            self.save(phase="push_issuing", pushCallCount=1)
            digest_file = self.root / "registry-digest"
            self.run(command + ["push", "--authfile", str(self.args.registry_auth_file),
                               "--digestfile", str(digest_file), tag, "docker://"+tag])
            require(re.fullmatch("sha256:[0-9a-f]{64}", digest_file.read_text().strip()), "push digest missing")
            self.save(phase="pushed", pushDigest=digest_file.read_text().strip())
        self.cold_verify()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build-and-push", "reconcile"])
    parser.add_argument("--operation-dir", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--registry-auth-file", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    operation = None
    try:
        operation = Operation(args)
        operation.execute()
    except Exception as error:
        # Never echo registry requests, command output, auth or configuration.
        result = {"verificationVerdict": "failed", "errorClass": type(error).__name__,
                  "message": str(error) if isinstance(error, ValueError) else "operation failed; reconcile ledger",
                  "promotionEligible": False, "runtimeDeployed": False}
        if isinstance(error, urllib.error.HTTPError):
            result["httpStatus"] = error.code
        if operation:
            result["phase"] = operation.state.get("phase")
            result["pushCallCount"] = operation.state.get("pushCallCount")
        print(json.dumps(result, sort_keys=True))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
