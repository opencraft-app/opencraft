#!/usr/bin/env python3
"""Recover only the q01 Git publisher after replacement of its operator host."""

import base64
import fcntl
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


STATE = Path("/data/actor-qualification/git")
IMAGE = "lightclaw-bj82.tencentcloudcr.com/actor-fleet/git-service@sha256:f4b8d351d4b8cf29a2ce2b0dd792eec98b2dde026f3dae354e34256a01999b68"
USER = "release-publisher"
TOKEN_NAME = "q01-release-publisher"


def require_operation_lock():
    if os.environ.get("AUTONOMY_OPERATION_LOCK_HELD") != "1":
        raise RuntimeError("publisher recovery requires the shared operation lock wrapper")
    path = os.environ.get("AUTONOMY_CONTROL_LOCK_PATH", "/data/tmp/actor-autonomy-operations.lock")
    try:
        descriptor = os.fstat(9)
        expected = os.stat(path)
        if (descriptor.st_dev, descriptor.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError("operation lock descriptor does not match the shared lock")
        # FD 9 is inherited from the exec-based wrapper. Keep that same open
        # file description locked for this entire recovery process.
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise RuntimeError("shared operation lock is unavailable") from error


def save_private(path, document):
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(document, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def kube(*args, **kwargs):
    return subprocess.run(["kubectl", *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs).stdout


def main():
    require_operation_lock()
    os.environ.setdefault("KUBECONFIG", "/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    pod = json.loads(kube("-n", "actor-git-system", "get", "pod", "actor-git-0", "-o", "json"))
    images = [item["imageID"].replace("docker-pullable://", "", 1)
              for item in pod["status"]["containerStatuses"]]
    if IMAGE not in images:
        raise RuntimeError("unexpected Git service image")
    journal = STATE / "publisher-recovery.json"
    if journal.exists():
        if journal.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError("recovery journal must have mode 0600")
        recovery = json.loads(journal.read_text())
    else:
        recovery = {"password": secrets.token_hex(32)}
        save_private(journal, recovery)
    password = recovery["password"]
    if len(password) != 64 or any(c not in "0123456789abcdef" for c in password):
        raise RuntimeError("invalid recovery journal")
    # Persist the replacement password before changing the account. The same
    # password can be replayed safely if this process is interrupted.
    kube("-n", "actor-git-system", "exec", "-i", "actor-git-0", "--", "sh", "-c",
         'read -r password; exec gitea admin user change-password --username release-publisher --must-change-password=false --password "$password"',
         input=(password + "\n").encode())
    with tempfile.TemporaryFile() as log:
        forward = subprocess.Popen(["kubectl", "-n", "actor-git-system", "port-forward",
                                    "service/actor-git", "30091:3000"], stdout=log, stderr=log)
        try:
            def request(method, path, body=None, token=None):
                authorization = ("token " + token if token else "Basic " + base64.b64encode(
                    (USER + ":" + password).encode()).decode())
                req = urllib.request.Request("http://127.0.0.1:30091/api/v1/" + path,
                                             data=None if body is None else json.dumps(body).encode(),
                                             headers={"Authorization": authorization,
                                                      "Content-Type": "application/json"}, method=method)
                with urllib.request.urlopen(req, timeout=20) as response:
                    payload = response.read()
                    return json.loads(payload) if payload else None

            for _ in range(30):
                if forward.poll() is not None:
                    raise RuntimeError("Git port-forward exited")
                try:
                    request("GET", "user")
                    break
                except urllib.error.HTTPError:
                    raise
                except urllib.error.URLError:
                    time.sleep(1)
            else:
                raise RuntimeError("Git port-forward did not become ready")
            repo_path = "repos/release-publisher/fleet-desired"
            repo = request("GET", repo_path)
            if not repo["private"] or repo["owner"]["login"] != USER:
                raise RuntimeError("repository identity/private invariant failed")
            credentials = STATE / "credentials.json"
            document = json.loads(credentials.read_text()) if credentials.exists() else {
                "schemaVersion": "actor-q01-git-credentials/v1"}
            # Revoke only the publisher token owned by this workflow. Neither
            # the reader account nor its Argo CD Secret is changed.
            for token in request("GET", "users/" + USER + "/tokens"):
                if token["name"] == TOKEN_NAME:
                    request("DELETE", "users/" + USER + "/tokens/" + str(token["id"]))
            token = request("POST", "users/" + USER + "/tokens",
                            {"name": TOKEN_NAME, "scopes": ["write:repository"]})["sha1"]
            document["publisher"] = {"username": USER, "password": password, "token": token}
            save_private(credentials, document)
            verified = request("GET", repo_path, token=token)
            if verified["id"] != repo["id"] or not verified.get("permissions", {}).get("push"):
                raise RuntimeError("publisher token repository verification failed")
            save_private(STATE / "publisher-recovery-receipt.json", {
                "schemaVersion": "actor-q01-publisher-recovery/v1", "repositoryID": repo["id"],
                "repositoryPrivate": True, "publisherVerified": True, "readerModified": False})
            print("publisher_recovery=verified reader_modified=false repository_id=" + str(repo["id"]))
        finally:
            forward.terminate()
            try:
                forward.wait(timeout=10)
            except subprocess.TimeoutExpired:
                forward.kill()
                forward.wait()


if __name__ == "__main__":
    main()
