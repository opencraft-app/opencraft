#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import hmac
import json
import os
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def _sigv4_request(method, url, region):
    secret_id = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not secret_id or not secret_key:
        raise RuntimeError("SigV4 inventory requires injected AWS credentials")
    parsed = urllib.parse.urlsplit(url)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    canonical_query = "&".join(
        f"{urllib.parse.quote(key, safe='-_.~')}={urllib.parse.quote(value, safe='-_.~')}"
        for key, value in sorted(query)
    )
    canonical_uri = urllib.parse.quote(
        urllib.parse.unquote(parsed.path or "/"), safe="/-_.~"
    )
    headers = {
        "host": parsed.netloc,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    session_token = os.environ.get("AWS_SESSION_TOKEN")
    if session_token:
        headers["x-amz-security-token"] = session_token
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in sorted(headers))
    canonical_request = "\n".join(
        [
            method,
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )

    def sign(key, value):
        return hmac.new(key, value.encode(), hashlib.sha256).digest()

    signing_key = sign(
        sign(sign(sign(("AWS4" + secret_key).encode(), date), region), "s3"),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, method=method)
    for key, value in headers.items():
        request.add_header(key, value)
    request.add_header(
        "Authorization",
        f"AWS4-HMAC-SHA256 Credential={secret_id}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}",
    )
    return request


def _url(endpoint, bucket, addressing_style, key="", query=None):
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("S3 endpoint must be an absolute HTTP(S) URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("S3 endpoint must not contain credentials, path, query, or fragment")
    quoted_key = urllib.parse.quote(key, safe="/-_.~")
    if addressing_style == "virtual":
        authority = f"{bucket}.{parsed.netloc}"
        path = f"/{quoted_key}" if quoted_key else "/"
    else:
        authority = parsed.netloc
        path = f"/{bucket}"
        if quoted_key:
            path += f"/{quoted_key}"
    encoded_query = urllib.parse.urlencode(sorted((query or {}).items()))
    return urllib.parse.urlunsplit(
        (parsed.scheme, authority, path, encoded_query, "")
    )


def _request(method, endpoint, bucket, addressing_style, auth, region, key="", query=None):
    url = _url(endpoint, bucket, addressing_style, key=key, query=query)
    if auth == "sigv4":
        return _sigv4_request(method, url, region)
    return urllib.request.Request(url, method=method)


def _elements(root, local_name):
    return [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == local_name]


def list_keys(endpoint, bucket, addressing_style="path", auth="anonymous", region="local"):
    request = _request(
        "GET",
        endpoint,
        bucket,
        addressing_style,
        auth,
        region,
        query={"list-type": "2", "max-keys": "1000"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        root = ET.fromstring(response.read())
    truncated = _elements(root, "IsTruncated")
    if len(truncated) != 1 or truncated[0].text != "false":
        raise RuntimeError("qualification bucket exceeded the bounded 1000-object inventory")
    return sorted(node.text for node in _elements(root, "Key"))


def delete_delta(
    endpoint,
    bucket,
    baseline_path,
    addressing_style="path",
    auth="anonymous",
    region="local",
):
    baseline = set(json.loads(open(baseline_path).read()))
    deleted = []
    for key in list_keys(endpoint, bucket, addressing_style, auth, region):
        if key in baseline:
            continue
        request = _request(
            "DELETE", endpoint, bucket, addressing_style, auth, region, key=key
        )
        with urllib.request.urlopen(request, timeout=10):
            pass
        deleted.append(key)
    return deleted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["list", "delete-delta"])
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--baseline")
    parser.add_argument("--addressing-style", choices=["path", "virtual"], default="path")
    parser.add_argument("--auth", choices=["anonymous", "sigv4"], default="anonymous")
    parser.add_argument("--region", default="local")
    args = parser.parse_args()
    if args.operation == "list":
        value = list_keys(
            args.endpoint, args.bucket, args.addressing_style, args.auth, args.region
        )
    else:
        if not args.baseline:
            parser.error("--baseline is required for delete-delta")
        value = delete_delta(
            args.endpoint,
            args.bucket,
            args.baseline,
            args.addressing_style,
            args.auth,
            args.region,
        )
    print(json.dumps(value, indent=2))


if __name__ == "__main__":
    main()
