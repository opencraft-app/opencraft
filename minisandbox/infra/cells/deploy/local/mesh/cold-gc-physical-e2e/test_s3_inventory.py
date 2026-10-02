#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("s3_inventory.py")
SPEC = importlib.util.spec_from_file_location("s3_inventory", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class S3InventoryTest(unittest.TestCase):
    def test_virtual_hosted_url_keeps_bucket_out_of_path(self):
        self.assertEqual(
            MODULE._url(
                "https://cos.ap-beijing.myqcloud.com",
                "backup-restore-qualification-123",
                "virtual",
                key="cold/v2/a b.cold",
                query={"max-keys": "1000", "list-type": "2"},
            ),
            "https://backup-restore-qualification-123.cos.ap-beijing.myqcloud.com/"
            "cold/v2/a%20b.cold?list-type=2&max-keys=1000",
        )

    def test_sigv4_signs_without_disclosing_secret(self):
        with mock.patch.dict(
            os.environ,
            {
                "AWS_ACCESS_KEY_ID": "qualification-access-id",
                "AWS_SECRET_ACCESS_KEY": "qualification-secret-key",
            },
            clear=True,
        ):
            request = MODULE._sigv4_request(
                "GET",
                "https://bucket.cos.ap-beijing.myqcloud.com/"
                "?list-type=2&max-keys=1000",
                "ap-beijing",
            )
        authorization = request.get_header("Authorization")
        self.assertIn("Credential=qualification-access-id/", authorization)
        self.assertIn("/ap-beijing/s3/aws4_request", authorization)
        self.assertNotIn("qualification-secret-key", authorization)
        self.assertEqual(
            request.get_header("X-amz-content-sha256"),
            "e3b0c44298fc1c149afbf4c8996fb924"
            "27ae41e4649b934ca495991b7852b855",
        )

    def test_endpoint_rejects_embedded_credentials_or_paths(self):
        for endpoint in (
            "https://user@cos.ap-beijing.myqcloud.com",
            "https://cos.ap-beijing.myqcloud.com/a",
            "https://cos.ap-beijing.myqcloud.com?bucket=other",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ValueError):
                    MODULE._url(endpoint, "qualification-bucket", "virtual")


if __name__ == "__main__":
    unittest.main()
