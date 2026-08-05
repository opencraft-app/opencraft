"""
Build a release image from the central release bundle manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from contracts.bundles import (
    ImageTarget,
    is_playground_env,
    load_bundle,
    load_manifest,
    playground_region,
    require_build_metadata,
)
from contracts.image_existence import ImageCheckResult, verify_images


RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNTIME_DIR.parents[1]


def validate_command(command: list[str]) -> list[str]:
    if not command or not all(isinstance(part, str) and part for part in command):
        raise ValueError("command must be a non-empty list of non-empty strings")
    return command


def run_command(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[Any]:
    return subprocess.run(validate_command(command), **kwargs)  # nosemgrep: dangerous-subprocess-use-audit


def playground_frontend_auth_api_base_url(env: str) -> str:
    return f"https://api-{env}.lightclaw.tech"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a release image from .ci/runtime/release-bundles.manifest")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. payment")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox or shprod")
    parser.add_argument("--tag", required=True, help="Image tag to build")
    parser.add_argument("--platform", default="linux/amd64", help="Docker build platform")
    parser.add_argument("--push", action="store_true", help="Push after successful build")
    parser.add_argument(
        "--reuse-existing",
        action="store_true",
        help="Skip docker build when the exact target image tag already exists in the remote registry",
    )
    parser.add_argument(
        "--push-verify-timeout-seconds",
        type=int,
        default=int(os.environ.get("RELEASE_IMAGE_PUSH_VERIFY_TIMEOUT_SECONDS", "300")),
        help="Seconds to wait for a pushed image manifest to become readable in the remote registry",
    )
    parser.add_argument(
        "--push-verify-interval-seconds",
        type=int,
        default=int(os.environ.get("RELEASE_IMAGE_PUSH_VERIFY_INTERVAL_SECONDS", "5")),
        help="Seconds between pushed image manifest visibility checks",
    )
    parser.add_argument(
        "--push-max-attempts",
        type=int,
        default=int(os.environ.get("RELEASE_IMAGE_PUSH_MAX_ATTEMPTS", "3")),
        help="Maximum docker login/push attempts for transient registry failures",
    )
    parser.add_argument(
        "--push-retry-interval-seconds",
        type=int,
        default=int(os.environ.get("RELEASE_IMAGE_PUSH_RETRY_INTERVAL_SECONDS", "10")),
        help="Base seconds between docker push retries; multiplied by the failed attempt number",
    )
    parser.add_argument("--image-output-file", help="Optional file path to receive the built image ref")
    return parser.parse_args()


def docker_login(image_repo: str) -> None:
    raw_username = os.environ.get("REGISTRY_USERNAME", "")
    raw_password = os.environ.get("REGISTRY_PASSWORD", "")
    username = raw_username.strip()
    password = raw_password.strip()  # pragma: allowlist secret -- registry credential variable, not a literal secret
    if not username or not password:
        return

    registry = image_repo.split("/", 1)[0]
    try:
        run_command(
            ["docker", "login", "-u", username, "--password-stdin", registry],
            input=password.encode(),
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        source = os.environ.get("REGISTRY_PASSWORD_SOURCE", "unknown")
        fingerprint = hashlib.sha256(password.encode()).hexdigest()[:12]
        print(
            (
                "docker login failed: "
                f"registry={registry} "
                f"username={username} "
                f"username_raw_len={len(raw_username)} "
                f"username_len={len(username)} "
                f"password_source={source} "
                f"password_raw_len={len(raw_password)} "
                f"password_len={len(password)} "
                f"password_trimmed={'yes' if raw_password != password else 'no'} "
                f"password_fingerprint={fingerprint}"
            ),
            file=sys.stderr,
        )
        if exc.stderr:
            print(exc.stderr.decode(errors="replace"), file=sys.stderr)
        raise


def push_image_with_retry(
    image_repo: str,
    image: str,
    *,
    max_attempts: int,
    retry_interval_seconds: int,
) -> None:
    attempts = max(max_attempts, 1)
    base_sleep_seconds = max(retry_interval_seconds, 1)
    last_error: subprocess.CalledProcessError | None = None
    last_phase = "push"

    for attempt in range(1, attempts + 1):
        try:
            docker_login(image_repo)
        except subprocess.CalledProcessError as exc:
            last_error = exc
            last_phase = "login"
            print(
                f"docker login attempt failed: image={image} attempt={attempt}/{attempts}",
                file=sys.stderr,
            )
        else:
            try:
                run_command(["docker", "push", image], check=True)
                return
            except subprocess.CalledProcessError as exc:
                last_error = exc
                last_phase = "push"
                print(
                    f"docker push attempt failed: image={image} attempt={attempt}/{attempts}",
                    file=sys.stderr,
                )

                result = verify_images([image], skip_login=True)[0]
                if result.exists:
                    digest_suffix = f" digest={result.digest}" if result.digest else ""
                    print(f"docker push command failed but remote image is visible: {image}{digest_suffix}")
                    return

        if attempt >= attempts:
            break

        sleep_seconds = base_sleep_seconds * attempt
        print(
            f"retrying docker {last_phase} in {sleep_seconds}s: "
            f"image={image} next_attempt={attempt + 1}/{attempts}",
            file=sys.stderr,
        )
        time.sleep(sleep_seconds)

    raise RuntimeError(
        f"docker {last_phase} failed after {attempts} attempts: image={image}"
    ) from last_error


def single_target_from_bundle(service: str, dockerfile: str, build_context: str, image_repo: str) -> ImageTarget:
    return ImageTarget(
        name=service,
        image_key=None,
        dockerfile=dockerfile,
        build_context=build_context,
        image_repo=image_repo,
    )


def image_key(service: str, target: ImageTarget) -> str:
    return target.image_key or f"{service.upper().replace('-', '_')}_IMAGE"


def image_for_target(target: ImageTarget, tag: str) -> str:
    return f"{target.image_repo}:{tag}"


def encode_built_output(built: dict[str, str], has_explicit_targets: bool) -> str:
    if len(built) == 1 and not has_explicit_targets:
        return next(iter(built.values()))
    return encode_image_payload(built)


def all_target_images_exist(targets: list[ImageTarget], tag: str) -> tuple[bool, list[ImageCheckResult]]:
    images = [image_for_target(target, tag) for target in targets]
    results = verify_images(images)
    return all(result.exists for result in results), results


def resolve_docker_build_args(service: str, env: str) -> dict[str, str]:
    if service == "frontend" and is_playground_env(env):
        build_args = {"VITE_AUTH_API_BASE_URL": playground_frontend_auth_api_base_url(env)}
        if playground_region(env) == "jp":
            build_args.update(
                {
                    "NEXT_PUBLIC_REGION": "global",
                    "VITE_REGION": "global",
                }
            )
        return build_args
    return {}


def docker_build_command(target: ImageTarget, image: str, platform: str, build_args: dict[str, str]) -> list[str]:
    cmd = [
        "docker",
        "build",
        "--platform",
        platform,
        "-f",
        target.dockerfile,
        "-t",
        image,
    ]
    for key, value in sorted(build_args.items()):
        cmd.extend(["--build-arg", f"{key}={value}"])
    cmd.append(target.build_context)
    return cmd


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def print_runner_diagnostics() -> None:
    print("docker runner diagnostics:")
    print(f"cwd={REPO_ROOT}")
    print(f"DOCKER_HOST={os.environ.get('DOCKER_HOST', '')}")
    for cmd in (
        ["hostname"],
        ["id"],
        ["groups"],
        ["docker", "version"],
        ["docker", "info"],
        ["ls", "-l", "/var/run/docker.sock", "/run/docker.sock"],
        ["sh", "-c", "ps -ef | grep -E 'dockerd|containerd' | grep -v grep || true"],
    ):
        print(f"+ {' '.join(cmd)}")
        try:
            run_command(cmd, check=False)
        except FileNotFoundError:
            print(f"{cmd[0]}: command not found")


def docker_daemon_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return run_command(
            ["docker", "info"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
    except FileNotFoundError:
        return False


def wait_for_remote_image(
    image: str,
    *,
    timeout_seconds: int,
    interval_seconds: int,
) -> ImageCheckResult:
    deadline = time.monotonic() + max(timeout_seconds, 0)
    attempt = 0
    last_result = ImageCheckResult(image=image, exists=False)

    while True:
        attempt += 1
        results = verify_images([image])
        last_result = results[0]
        if last_result.exists and last_result.digest:
            print(f"pushed image is visible: {image} digest={last_result.digest}")
            return last_result

        if time.monotonic() >= deadline:
            break

        sleep_seconds = max(interval_seconds, 1)
        print(f"pushed image is not visible yet; retrying in {sleep_seconds}s: {image} attempt={attempt}")
        time.sleep(sleep_seconds)

    raise RuntimeError(
        f"pushed image did not become visible before timeout: {image} "
        f"timeout_seconds={timeout_seconds} exists={last_result.exists} digest={last_result.digest or '-'}"
    )


def build_target(
    target: ImageTarget,
    tag: str,
    platform: str,
    push: bool,
    build_args: dict[str, str],
    *,
    push_verify_timeout_seconds: int = 300,
    push_verify_interval_seconds: int = 5,
    push_max_attempts: int = 3,
    push_retry_interval_seconds: int = 10,
) -> str:
    image = image_for_target(target, tag)
    cmd = docker_build_command(target, image, platform, build_args)
    if build_args:
        rendered_args = " ".join(f"{key}={value}" for key, value in sorted(build_args.items()))
        print(f"docker build args: {rendered_args}")
    if env_flag("PRINT_RUNNER_DIAGNOSTICS"):
        print_runner_diagnostics()
    if not docker_daemon_available():
        print("docker daemon is unavailable before docker build; see docker runner diagnostics in this step.", file=sys.stderr)
        if not env_flag("PRINT_RUNNER_DIAGNOSTICS"):
            print_runner_diagnostics()
        raise RuntimeError("docker daemon unavailable")
    run_command(cmd, cwd=REPO_ROOT, check=True)
    if push:
        push_image_with_retry(
            target.image_repo,
            image,
            max_attempts=push_max_attempts,
            retry_interval_seconds=push_retry_interval_seconds,
        )
        wait_for_remote_image(
            image,
            timeout_seconds=push_verify_timeout_seconds,
            interval_seconds=push_verify_interval_seconds,
        )
    return image


def encode_image_payload(images: dict[str, str]) -> str:
    return json.dumps({"images": images}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main() -> int:
    args = parse_args()
    try:
        bundle = require_build_metadata(load_bundle(load_manifest(), args.service, args.env))
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    targets = bundle.image_targets or [
        single_target_from_bundle(args.service, bundle.dockerfile or "", bundle.build_context or "", bundle.image_repo or "")
    ]
    has_explicit_targets = bool(bundle.image_targets)

    build_args = resolve_docker_build_args(args.service, args.env)
    built: dict[str, str] = {}
    try:
        if args.reuse_existing:
            all_exist, image_results = all_target_images_exist(targets, args.tag)
            if all_exist:
                for target in targets:
                    key = image_key(args.service, target)
                    built[key] = image_for_target(target, args.tag)
                print("remote release image already exists; skip docker build")
                for result in image_results:
                    digest_suffix = f" digest={result.digest}" if result.digest else ""
                    print(f"reuse existing image: {result.image}{digest_suffix}")
                output = encode_built_output(built, has_explicit_targets)
                if args.image_output_file:
                    Path(args.image_output_file).write_text(f"{output}\n")
                else:
                    print(output)
                return 0
            print("remote release image missing; continue with docker build")
        for target in targets:
            image = build_target(
                target,
                args.tag,
                args.platform,
                args.push,
                build_args,
                push_verify_timeout_seconds=args.push_verify_timeout_seconds,
                push_verify_interval_seconds=args.push_verify_interval_seconds,
                push_max_attempts=args.push_max_attempts,
                push_retry_interval_seconds=args.push_retry_interval_seconds,
            )
            built[image_key(args.service, target)] = image
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    output = encode_built_output(built, has_explicit_targets)
    if args.image_output_file:
        Path(args.image_output_file).write_text(f"{output}\n")
    else:
        print(output)
    return 0
