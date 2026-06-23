"""Start frontend EdgeOne release approval pipelines from a build pipeline."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


BASE_URL = "https://devops.apigw.o.woa.com/prod/v4/apigw-user"
DEFAULT_PROJECT_ID = "git_1731878"


@dataclass(frozen=True)
class EdgeOneReleasePipeline:
    name: str
    combo: str
    pipeline_id: str


PIPELINES = {
    "orchestrator": EdgeOneReleasePipeline(
        name="frontend EdgeOne 正式站编排",
        combo="edgeone-release-orchestrator",
        pipeline_id="p-9f8b7c9ae96448e8b6b03b2318cf6091",
    ),
    "cn": EdgeOneReleasePipeline(
        name="frontend EdgeOne 国内正式站",
        combo="eo:cn-lightvela-prod-next",
        pipeline_id="p-14693956c7f44dadb83d00c523de0dd7",
    ),
    "intl": EdgeOneReleasePipeline(
        name="frontend EdgeOne 国际正式站",
        combo="eo:global-lightvela-intl-prod-next",
        pipeline_id="p-1538e39f666f4be48ddf7cfea2acb589",
    ),
}


def read_secret_value(value: str) -> str:
    return value.replace("\r", "").replace("\n", "").strip()


def resolve_access_token() -> str:
    token = os.environ.get("BK_CI_ACCESS_TOKEN", "")
    if token and "${{" not in token:
        return read_secret_value(token)

    token_file = os.environ.get("BK_CI_ACCESS_TOKEN_FILE", "/etc/lightclaw-ci/bk_ci_access_token")
    try:
        with open(token_file, encoding="utf-8") as file:
            return read_secret_value(file.read())
    except FileNotFoundError:
        pass

    raise SystemExit(
        "BK_CI_ACCESS_TOKEN is required to auto-trigger frontend EdgeOne release pipelines; "
        f"set CI setting BK_CI_ACCESS_TOKEN or provide {token_file}"
    )


def build_url(url: str, params: dict[str, str]) -> str:
    return f"{url}?{urllib.parse.urlencode(params)}"


def post_json(url: str, *, body: dict[str, str], access_token: str) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Bkapi-Authorization": json.dumps({"access_token": access_token}, separators=(",", ":")),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"failed to trigger BK-CI pipeline: HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"failed to trigger BK-CI pipeline: {error.reason}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"failed to parse BK-CI response: {error}") from error


def trigger_pipeline(
    *,
    project_id: str,
    pipeline: EdgeOneReleasePipeline,
    source_sha: str,
    branch: str,
    build_message: str,
    access_token: str,
) -> dict:
    url = build_url(
        f"{BASE_URL}/projects/{project_id}/build_start",
        {"pipelineId": pipeline.pipeline_id},
    )
    body = {
        "branch": branch,
        "buildMsg": build_message,
        "FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA": source_sha,
        "FRONTEND_EDGEONE_ARTIFACT_REF": "",
    }
    return post_json(url, body=body, access_token=access_token)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Trigger frontend EdgeOne release approval pipelines.")
    parser.add_argument("--source-sha", required=True, help="Frontend artifact source SHA.")
    parser.add_argument("--project-id", default=DEFAULT_PROJECT_ID)
    parser.add_argument("--branch", default="master")
    parser.add_argument(
        "--target",
        action="append",
        choices=sorted(PIPELINES),
        help="Release target to trigger. Repeatable. Defaults to both cn and intl.",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_sha = args.source_sha.strip()
    if not source_sha:
        raise SystemExit("--source-sha is required")

    targets = args.target or ["cn", "intl"]
    build_message = f"Auto trigger frontend EdgeOne release from {source_sha[:12]}"
    access_token = "" if args.dry_run else resolve_access_token()

    for target in targets:
        pipeline = PIPELINES[target]
        print("============================================================")
        print(f"frontend EdgeOne 自动发起：{pipeline.name}")
        print(f"project_id={args.project_id}")
        print(f"pipeline_id={pipeline.pipeline_id}")
        print(f"combo={pipeline.combo}")
        print(f"branch={args.branch}")
        print(f"artifact_source_sha={source_sha}")
        print("发布动作：只启动目标流水线，目标流水线仍需人工 check-in 后才会发布")
        print("============================================================")
        if args.dry_run:
            continue

        result = trigger_pipeline(
            project_id=args.project_id,
            pipeline=pipeline,
            source_sha=source_sha,
            branch=args.branch,
            build_message=build_message,
            access_token=access_token,
        )
        status = result.get("status")
        if status not in (0, "0", None):
            raise SystemExit(f"BK-CI build_start failed for {pipeline.name}: {json.dumps(result, ensure_ascii=False)}")
        data = result.get("data") or {}
        print(
            "frontend EdgeOne 发布候选流水线已启动："
            f"name={pipeline.name} build_id={data.get('id')} build_num={data.get('num')}"
        )

    return 0
