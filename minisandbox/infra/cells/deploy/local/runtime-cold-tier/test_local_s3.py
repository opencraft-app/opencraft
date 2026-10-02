#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET


HERE = pathlib.Path(__file__).resolve().parent
ADMIN_TOKEN = "local-test-admin-token-000000000000000000000000"


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class LocalS3Process:
    def __init__(self, root: pathlib.Path, port: int):
        self.root = root
        self.port = port
        self.process = None

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        env = os.environ.copy()
        env.update(
            {
                "LOCAL_S3_ROOT": str(self.root),
                "LOCAL_S3_BUCKETS": "a,b",
                "LOCAL_S3_PORT": str(self.port),
                "LOCAL_S3_ADMIN_TOKEN": ADMIN_TOKEN,
            }
        )
        self.process = subprocess.Popen(
            ["python3", str(HERE / "local_s3.py")],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                self.request("GET", "/__health")
                return
            except (OSError, urllib.error.URLError):
                if self.process.poll() is not None:
                    error = self.process.stderr.read()
                    self.process.stderr.close()
                    raise RuntimeError(error)
                time.sleep(0.02)
        raise TimeoutError("local S3 process did not become ready")

    def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        self.process.wait(timeout=5)
        self.process.stderr.close()
        self.process = None

    def request(
        self, method: str, path: str, body: bytes | None = None, admin: bool = False
    ):
        request = urllib.request.Request(self.endpoint + path, data=body, method=method)
        if admin:
            request.add_header("X-Local-S3-Admin-Token", ADMIN_TOKEN)
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)


class LocalS3Test(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.server = LocalS3Process(pathlib.Path(self.temporary.name), free_port())
        self.server.start()

    def tearDown(self) -> None:
        self.server.stop()
        self.temporary.cleanup()

    def test_contract_isolation_integrity_fault_and_restart(self) -> None:
        status, _, headers = self.server.request("PUT", "/a/key", b"alpha")
        self.assertEqual(200, status)
        self.assertIn("ETag", headers)
        self.assertEqual((200, b"alpha"), self.server.request("GET", "/a/key")[:2])
        self.assertEqual(404, self.server.request("GET", "/b/key")[0])

        self.assertEqual(200, self.server.request("PUT", "/a/key", b"alpha")[0])
        self.assertEqual(409, self.server.request("PUT", "/a/key", b"beta")[0])
        self.assertEqual(5, int(self.server.request("HEAD", "/a/key")[2]["Content-Length"]))

        self.assertEqual(
            204,
            self.server.request(
                "PUT", "/__admin/fault?operation=get&status=503", admin=True
            )[0],
        )
        self.assertEqual(403, self.server.request("GET", "/__admin/stats")[0])
        self.assertEqual(503, self.server.request("GET", "/a/key")[0])
        self.assertEqual(
            204,
            self.server.request("DELETE", "/__admin/fault?operation=get", admin=True)[0],
        )
        self.assertEqual((200, b"alpha"), self.server.request("GET", "/a/key")[:2])

        self.assertEqual(200, self.server.request("PUT", "/a/corrupt", b"payload")[0])
        self.assertEqual(
            204,
            self.server.request(
                "POST", "/__admin/corrupt?bucket=a&key=corrupt", admin=True
            )[0],
        )
        self.assertEqual(500, self.server.request("GET", "/a/corrupt")[0])

        self.server.stop()
        self.server.start()
        self.assertEqual((200, b"alpha"), self.server.request("GET", "/a/key")[:2])
        self.assertEqual(204, self.server.request("DELETE", "/a/key")[0])
        self.assertEqual(204, self.server.request("DELETE", "/a/key")[0])
        self.assertEqual(404, self.server.request("GET", "/a/key")[0])
        alpha_digest = hashlib.sha256(b"alpha").hexdigest()
        alpha_blob = (
            pathlib.Path(self.temporary.name)
            / "blobs"
            / alpha_digest[:2]
            / alpha_digest[2:]
        )
        self.assertFalse(alpha_blob.exists())

    def test_list_objects_v2_is_sorted_paginated_and_bucket_isolated(self) -> None:
        for key, content in (("zeta", b"z"), ("alpha", b"aa"), ("middle", b"mmm")):
            self.assertEqual(200, self.server.request("PUT", f"/a/{key}", content)[0])
        self.assertEqual(200, self.server.request("PUT", "/b/foreign", b"other")[0])

        status, body, _ = self.server.request("GET", "/a?list-type=2&max-keys=2")
        self.assertEqual(200, status)
        root = ET.fromstring(body)
        namespace = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        self.assertEqual(["alpha", "middle"], [node.text for node in root.findall("s3:Contents/s3:Key", namespace)])
        self.assertEqual("true", root.findtext("s3:IsTruncated", namespaces=namespace))
        token = root.findtext("s3:NextContinuationToken", namespaces=namespace)
        self.assertIsNotNone(token)

        status, body, _ = self.server.request(
            "GET", f"/a?list-type=2&max-keys=2&continuation-token={token}"
        )
        self.assertEqual(200, status)
        root = ET.fromstring(body)
        self.assertEqual(["zeta"], [node.text for node in root.findall("s3:Contents/s3:Key", namespace)])
        self.assertEqual("false", root.findtext("s3:IsTruncated", namespaces=namespace))
        self.assertIsNone(root.find("s3:NextContinuationToken", namespace))

        status, body, _ = self.server.request("GET", "/b?list-type=2&max-keys=100")
        self.assertEqual(200, status)
        root = ET.fromstring(body)
        self.assertEqual(["foreign"], [node.text for node in root.findall("s3:Contents/s3:Key", namespace)])

    def test_bounded_rate_limit_request_accounting_and_durable_put_gate(self) -> None:
        self.assertEqual(
            204,
            self.server.request(
                "PUT",
                "/__admin/fault?operation=put&status=429&count=2",
                admin=True,
            )[0],
        )
        self.assertEqual(429, self.server.request("PUT", "/a/retry", b"payload")[0])
        self.assertEqual(429, self.server.request("PUT", "/a/retry", b"payload")[0])
        self.assertEqual(200, self.server.request("PUT", "/a/retry", b"payload")[0])

        self.assertEqual(
            204,
            self.server.request(
                "PUT", "/__admin/gate?point=put_after_commit", admin=True
            )[0],
        )
        result = []
        put = threading.Thread(
            target=lambda: result.append(
                self.server.request("PUT", "/a/durable-before-response", b"committed")
            ),
            daemon=True,
        )
        put.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status, body, _ = self.server.request("GET", "/__admin/stats", admin=True)
            self.assertEqual(200, status)
            stats = json.loads(body)
            if stats["gates"]["put_after_commit"]["waiting"] == 1:
                break
            time.sleep(0.02)
        else:
            self.fail("PUT did not reach the durable post-commit gate")
        self.assertTrue(put.is_alive())
        self.assertEqual(
            204,
            self.server.request(
                "DELETE", "/__admin/gate?point=put_after_commit", admin=True
            )[0],
        )
        put.join(timeout=2)
        self.assertFalse(put.is_alive())
        self.assertEqual(200, result[0][0])
        self.assertEqual(
            (200, b"committed"),
            self.server.request("GET", "/a/durable-before-response")[:2],
        )

        status, body, _ = self.server.request("GET", "/__admin/stats", admin=True)
        self.assertEqual(200, status)
        stats = json.loads(body)
        put_stats = stats["requests"]["a"]["put"]
        self.assertEqual(4, put_stats["requests"])
        self.assertEqual(2, put_stats["succeeded"])
        self.assertEqual(2, put_stats["failed"])
        self.assertEqual(len(b"payload") + len(b"committed"), put_stats["request_bytes"])
        self.assertGreaterEqual(put_stats["max_active"], 1)
        self.assertEqual(
            204, self.server.request("DELETE", "/__admin/stats", admin=True)[0]
        )
        status, body, _ = self.server.request("GET", "/__admin/stats", admin=True)
        self.assertEqual(200, status)
        self.assertEqual({}, json.loads(body)["requests"])

    def test_delete_is_idempotent_after_durable_commit_and_response_loss(self) -> None:
        self.assertEqual(200, self.server.request("PUT", "/a/delete-response-loss", b"gone")[0])
        self.assertEqual(
            204,
            self.server.request(
                "PUT", "/__admin/gate?point=delete_after_commit", admin=True
            )[0],
        )
        result = []
        def lose_delete_response():
            try:
                result.append(self.server.request("DELETE", "/a/delete-response-loss"))
            except OSError:
                result.append("response-lost")
        delete = threading.Thread(
            target=lose_delete_response,
            daemon=True,
        )
        delete.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status, body, _ = self.server.request("GET", "/__admin/stats", admin=True)
            self.assertEqual(200, status)
            stats = json.loads(body)
            if stats["gates"]["delete_after_commit"]["waiting"] == 1:
                break
            time.sleep(0.02)
        else:
            self.fail("DELETE did not reach the durable post-commit gate")

        # Losing the process at this point loses the response, not the durable mutation.
        self.server.stop()
        delete.join(timeout=2)
        self.server.start()
        self.assertEqual(404, self.server.request("GET", "/a/delete-response-loss")[0])
        self.assertEqual(204, self.server.request("DELETE", "/a/delete-response-loss")[0])

    def test_delete_faults_cover_rate_limit_and_service_unavailable(self) -> None:
        for status in (429, 503):
            key = f"delete-{status}"
            self.assertEqual(200, self.server.request("PUT", f"/a/{key}", b"payload")[0])
            self.assertEqual(
                204,
                self.server.request(
                    "PUT",
                    f"/__admin/fault?operation=delete&status={status}&count=2",
                    admin=True,
                )[0],
            )
            self.assertEqual(status, self.server.request("DELETE", f"/a/{key}")[0])
            self.assertEqual(status, self.server.request("DELETE", f"/a/{key}")[0])
            self.assertEqual(204, self.server.request("DELETE", f"/a/{key}")[0])
            self.assertEqual(404, self.server.request("GET", f"/a/{key}")[0])


if __name__ == "__main__":
    unittest.main()
