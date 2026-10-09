#!/usr/bin/env python3
"""Publish a checksummed first-install payload to the existing Beijing installer bucket.

Authentication is loaded from a private coscmd-compatible INI file, never CLI values.
No bucket policy, ACL, Bot credentials or running services are changed.
"""
import argparse
import configparser
import hashlib
import json
import logging
from pathlib import Path
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    root = Path(args.payload).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    version = manifest["version"]
    prefix = f"vela-im/releases/{version}/linux-amd64/"
    expected_base = f"https://vela-installer-1388575217.cos.ap-beijing.myqcloud.com/{prefix}"
    if manifest["binaryUrl"] != expected_base + "vela-computer" or manifest["installerUrl"] != expected_base + "install.sh":
        raise ValueError("Payload does not target the Beijing installer bucket")
    names = {"vela-computer", "install.sh", "manifest.json", "VERSION"}
    checksums = {}
    for line in (root / "SHA256SUMS").read_text().splitlines():
        checksum, name = line.split("  ", 1)
        if name not in names or name in checksums or (root / name).is_symlink():
            raise ValueError("Unexpected checksum entry")
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != checksum:
            raise ValueError("Payload checksum mismatch")
        checksums[name] = checksum
    if checksums.keys() != names or checksums["vela-computer"] != manifest["binarySha256"] or checksums["install.sh"] != manifest["installerSha256"]:
        raise ValueError("Incomplete or inconsistent payload")
    config = configparser.ConfigParser()
    config.read(args.config)
    settings = config["common"]
    secret_id = settings.get("secret_id", "").strip()
    secret_key = settings.get("secret_key", "").strip()
    if not secret_id or not secret_key:
        raise ValueError("COS upload authentication is missing")
    from qcloud_cos import CosConfig, CosS3Client, CosServiceError
    logging.disable(logging.CRITICAL)
    client = CosS3Client(CosConfig(Region="ap-beijing", SecretId=secret_id, SecretKey=secret_key,
                                  Token=settings.get("token", "").strip() or None, Scheme="https"))
    bucket = "vela-installer-1388575217"
    for name in ["vela-computer", "install.sh", "VERSION", "manifest.json", "SHA256SUMS"]:
        data = (root / name).read_bytes()
        checksum = hashlib.sha256(data).hexdigest()
        key = prefix + name
        try:
            client.head_object(Bucket=bucket, Key=key)
        except CosServiceError as error:
            if str(error.get_status_code()) != "404":
                raise
            client.put_object(Bucket=bucket, Key=key, Body=data, EnableMD5=True,
                              CacheControl="public,max-age=31536000,immutable",
                              Metadata={"x-cos-forbid-overwrite": "true", "x-cos-meta-sha256": checksum})
        # Verify the ordinary URL the Bot uses, including preexisting immutable objects.
        with urllib.request.urlopen(expected_base + name, timeout=180) as response:
            actual = hashlib.sha256(response.read()).hexdigest()
        if actual != checksum:
            raise ValueError("Public download does not match local payload")
        print(f"Verified {name}: {checksum}")
    print("All Beijing COS downloads verified; the frontend release may now be marked published.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/request exceptions can carry headers or signed URLs. Never print them.
        raise SystemExit(f"IM client publication failed ({type(error).__name__}); no release enabled")
