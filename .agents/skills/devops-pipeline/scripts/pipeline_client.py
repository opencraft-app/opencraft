#!/usr/bin/env python3
"""
蓝盾流水线 Python 客户端

用于管理蓝盾流水线构建操作，包括：
- 查询流水线列表 (pipelines)
- 查询构建历史 (list)
- 获取启动参数 (startup-info)
- 启动构建 (start)
- 查看构建状态 (status)

使用方法:
    python pipeline_client.py <command> [options]

身份验证:
    通过 --access-token 参数或 BK_CI_ACCESS_TOKEN 环境变量传递访问令牌
"""

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, Optional
import urllib.parse
import urllib.request
import urllib.error
import yaml


def print_data(data: Dict[str, Any]) -> None:
    """以 YAML 打印数据"""
    print(yaml.dump(data, allow_unicode=True, sort_keys=False))


BASE_URL = "https://devops.apigw.o.woa.com/prod/v4/apigw-user"


def build_url(url: str, params: Dict[str, Any]) -> str:
    """Append URL-encoded query parameters to an API URL."""
    return f"{url}?{urllib.parse.urlencode(params)}" if params else url


def make_request(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    data: Optional[Dict[str, Any]] = None,
    access_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    发起 HTTP 请求

    Args:
        url: 请求 URL
        method: HTTP 方法 (GET/POST)
        headers: 自定义请求头
        data: POST 请求体数据
        access_token: 访问令牌

    Returns:
        API 响应的 JSON 数据
    """
    req_headers = headers or {}
    req_headers["Content-Type"] = "application/json"

    if access_token:
        auth_header = json.dumps({"access_token": access_token}, separators=(",", ":"))
        req_headers["X-Bkapi-Authorization"] = auth_header

    req_data = None
    if data is not None and method in ("POST", "PUT"):
        req_data = json.dumps(data).encode("utf-8")


    request = urllib.request.Request(
        url,
        data=req_data,
        headers=req_headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"HTTP Error {e.code}: {error_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"JSON Decode Error: {e}", file=sys.stderr)
        sys.exit(1)


def get_access_token(args_token: Optional[str]) -> str:
    """
    获取访问令牌，优先使用命令行参数，其次环境变量

    Args:
        args_token: 命令行传入的令牌

    Returns:
        访问令牌

    Raises:
        SystemExit: 未找到令牌时退出
    """
    token = args_token or os.environ.get("BK_CI_ACCESS_TOKEN")
    if not token:
        print(
            "\n".join(
                [
                    "错误：未提供蓝盾访问令牌。",
                    "请通过 --access-token 参数或 BK_CI_ACCESS_TOKEN 环境变量设置。",
                    "如果当前没有 token，请使用已登录浏览器打开以下地址获取：",
                    "  https://devops.woa.com/ms/auth/api/user/bkToken/get",
                    "拿到 token 后建议仅在当前 shell 会话中使用：",
                    '  export BK_CI_ACCESS_TOKEN="<your_token>"',
                    "不要把 token 写入仓库、文档、提交信息或持久日志。",
                ]
            ),
            file=sys.stderr,
        )
        sys.exit(1)
    return token


def cmd_startup_info(args: argparse.Namespace) -> None:
    """
    获取流水线手动启动参数

    API: GET /projects/{projectId}/build_manual_startup_info

    返回流水线启动所需的参数定义，用于构建启动前的参数准备
    """
    access_token = get_access_token(args.access_token)

    url = f"{BASE_URL}/projects/{args.project_id}/build_manual_startup_info"
    params = {"pipelineId": args.pipeline_id}

    if args.version:
        params["version"] = args.version

    full_url = build_url(url, params)

    result = make_request(full_url, access_token=access_token)
    print_data(result)


def cmd_start(args: argparse.Namespace) -> None:
    """
    启动流水线构建

    API: POST /projects/{projectId}/build_start

    手动触发流水线构建，支持传递构建参数
    """
    access_token = get_access_token(args.access_token)

    url = f"{BASE_URL}/projects/{args.project_id}/build_start"
    params = {"pipelineId": args.pipeline_id}

    if args.build_no is not None:
        params["buildNo"] = args.build_no

    full_url = build_url(url, params)

    # 解析构建参数
    body_data = {}
    if args.params:
        try:
            body_data = json.loads(args.params)
        except json.JSONDecodeError as e:
            print(f"参数解析错误: {e}", file=sys.stderr)
            sys.exit(1)

    result = make_request(
        full_url, method="POST", data=body_data, access_token=access_token
    )
    print_data(result)


def cmd_stop(args: argparse.Namespace) -> None:
    """
    取消流水线构建

    API: POST /projects/{projectId}/build_stop

    取消指定的构建任务，通常用于停止运行中或排队中的构建
    """
    access_token = get_access_token(args.access_token)
    current = read_build_status(args, access_token)
    channel = resolve_build_channel(current, getattr(args, "channel", None))
    if current.get("status") == "CANCELED":
        print_data({"buildId": args.build_id, "channel": channel,
                    "status": "CANCELED", "stopRequested": False, "cancellationVerified": True})
        return
    if current.get("status") not in {"RUNNING", "QUEUE", "STAGE_SUCCESS", "PAUSE", "PREPARE_ENV"}:
        raise SystemExit("目标构建已结束或状态未知；未发起停止请求")
    url = f"{BASE_URL}/projects/{args.project_id}/build_stop"
    params = {"buildId": args.build_id, "pipelineId": args.pipeline_id}

    full_url = build_url(url, params)

    result = make_request(
        full_url, method="POST", data={}, access_token=access_token,
        headers={"X-DEVOPS-CHANNEL": channel},
    )
    if result.get("status") not in (0, "0") or result.get("result") is False or result.get("data") is not True:
        raise SystemExit("CI 未接受停止请求；未确认中止，不自动重试")
    deadline = time.monotonic() + getattr(args, "wait_seconds", 30)
    while True:
        latest = read_build_status(args, access_token)
        status = latest.get("status")
        verified = status == "CANCELED"
        if verified or status in {"SUCCEED", "FAILED", "TERMINATE"} or time.monotonic() >= deadline:
            print_data({"buildId": args.build_id, "channel": channel, "status": status,
                        "stopRequested": True, "cancellationVerified": verified})
            if not verified:
                raise SystemExit(2)
            return
        time.sleep(min(2, max(0, deadline - time.monotonic())))


def read_build_status(args: argparse.Namespace, access_token: str) -> Dict[str, Any]:
    url = build_url(f"{BASE_URL}/projects/{args.project_id}/build_status",
                    {"pipelineId": args.pipeline_id, "buildId": args.build_id})
    response = make_request(url, access_token=access_token)
    data = response.get("data")
    if response.get("status") not in (0, "0") or response.get("result") is False or not isinstance(data, dict):
        raise SystemExit("无法读取构建状态；不猜测渠道，不发起或重复停止请求")
    if data.get("id") != args.build_id or data.get("pipelineId", args.pipeline_id) != args.pipeline_id:
        raise SystemExit("构建身份不匹配；不发起或重复停止请求")
    return data


def resolve_build_channel(data: Dict[str, Any], explicit: Optional[str] = None) -> str:
    """Match the authenticated target's routing channel; never default Stream to BS."""
    supported = {"BS", "GIT", "CREATIVE_STREAM"}
    webhook = data.get("webhookInfo")
    variables = data.get("variables")
    if webhook is None:
        webhook = {}
    if variables is None:
        variables = {}
    if not isinstance(webhook, dict) or not isinstance(variables, dict):
        raise SystemExit("构建渠道元数据格式异常；未发起停止请求")
    observed = [data.get("channelCode"), webhook.get("channelCode"),
                variables.get("pipeline.start.channel"), variables.get("BK_CI_START_CHANNEL")]
    channels = set()
    for value in observed:
        if value is None or value == "":
            continue
        if not isinstance(value, str) or value not in supported:
            raise SystemExit("构建渠道未知或不受支持；未发起停止请求")
        channels.add(value)
    if explicit is not None:
        if explicit not in supported:
            raise SystemExit("指定渠道不受支持；未发起停止请求")
        channels.add(explicit)
    if len(channels) != 1:
        raise SystemExit("构建渠道缺失或冲突；先核对实际归属，禁止猜测或切换渠道重试")
    return channels.pop()


def cmd_status(args: argparse.Namespace) -> None:
    """
    查看构建状态

    API: GET /projects/{projectId}/build_status

    获取指定构建的详细状态，包括各阶段状态、执行时间、错误信息等
    """
    access_token = get_access_token(args.access_token)

    url = f"{BASE_URL}/projects/{args.project_id}/build_status"
    params = {"buildId": args.build_id, "pipelineId": args.pipeline_id}

    full_url = build_url(url, params)

    result = make_request(full_url, access_token=access_token)
    print_data(result)



def cmd_list(args: argparse.Namespace) -> None:
    """
    获取流水线构建历史

    API: GET /projects/{projectId}/build_histories

    查询流水线的历史构建记录，支持分页和多种筛选条件
    """
    access_token = get_access_token(args.access_token)

    url = f"{BASE_URL}/projects/{args.project_id}/build_histories"
    params: Dict[str, Any] = {"pipelineId": args.pipeline_id}

    # 分页参数
    if args.page is not None:
        params["page"] = args.page
    if args.page_size is not None:
        params["pageSize"] = args.page_size

    # 筛选参数
    if args.status:
        params["status"] = args.status
    if args.trigger:
        params["trigger"] = args.trigger
    if args.start_user:
        params["startUser"] = args.start_user
    if args.build_no_start is not None:
        params["buildNoStart"] = args.build_no_start
    if args.build_no_end is not None:
        params["buildNoEnd"] = args.build_no_end
    if args.start_time_start:
        params["startTimeStartTime"] = args.start_time_start
    if args.start_time_end:
        params["startTimeEndTime"] = args.start_time_end
    if args.end_time_start:
        params["endTimeStartTime"] = args.end_time_start
    if args.end_time_end:
        params["endTimeEndTime"] = args.end_time_end
    if args.archive_flag:
        params["archiveFlag"] = args.archive_flag
    if args.build_msg:
        params["buildMsg"] = args.build_msg
    if args.remark:
        params["remark"] = args.remark
    if args.material_alias:
        params["materialAlias"] = args.material_alias
    if args.material_branch:
        params["materialBranch"] = args.material_branch
    if args.material_commit_id:
        params["materialCommitId"] = args.material_commit_id
    if args.update_time_desc is not None:
        params["updateTimeDesc"] = args.update_time_desc

    full_url = build_url(url, params)

    result = make_request(full_url, access_token=access_token)
    print_data(result)


def clean_pipeline_data(records: list) -> list:
    """
    清洗流水线列表数据，保留关键字段

    Args:
        records: 原始流水线记录列表

    Returns:
        清洗后的数据列表
    """
    cleaned = []
    for record in records:
        clean_record = {
            "pipelineId": record.get("pipelineId"),
            "pipelineName": record.get("pipelineName"),
            "pipelineDesc": record.get("pipelineDesc"),
            "creator": record.get("creator"),
            "createTime": record.get("createTime"),
            "updater": record.get("updater"),
            "updateTime": record.get("updateTime"),
            "latestBuildStatus": record.get("latestBuildStatus"),
            "latestBuildStartTime": record.get("latestBuildStartTime"),
            "latestBuildEndTime": record.get("latestBuildEndTime"),
            "latestBuildNum": record.get("latestBuildNum"),
            "buildCount": record.get("buildCount"),
            "runningBuildCount": record.get("runningBuildCount"),
            "canManualStartup": record.get("canManualStartup"),
            "hasPermission": record.get("hasPermission"),
            "hasCollect": record.get("hasCollect"),
            "delete": record.get("delete"),
            "version": record.get("version"),
            "pipelineVersion": record.get("pipelineVersion"),
            "viewNames": record.get("viewNames"),
        }
        cleaned.append(clean_record)
    return cleaned


def cmd_update_params(args: argparse.Namespace) -> None:
    """
    修改流水线默认启动参数

    API: GET + PUT /projects/{projectId}/pipelines/pipeline

    先 GET 流水线定义，修改 stages[0].containers[0].params 中对应参数的 defaultValue，再 PUT 回去
    """
    access_token = get_access_token(args.access_token)

    # 解析要修改的参数
    try:
        new_params = json.loads(args.params)
    except json.JSONDecodeError as e:
        print(f"参数解析错误: {e}", file=sys.stderr)
        sys.exit(1)

    url = f"{BASE_URL}/projects/{args.project_id}/pipelines/pipeline"
    params: Dict[str, Any] = {"pipelineId": args.pipeline_id}

    full_url = build_url(url, params)

    # GET 流水线定义
    result = make_request(full_url, access_token=access_token)
    if result.get("status") != 0:
        print(f"GET 失败: {result}", file=sys.stderr)
        sys.exit(1)

    data = result["data"]
    params_list = data["stages"][0]["containers"][0].get("params", [])

    # 检查所有要修改的参数是否存在
    existing_ids = {p.get("id") for p in params_list}
    for key in new_params:
        if key not in existing_ids:
            print(f"错误：参数 '{key}' 在流水线中不存在，可用参数：{existing_ids}", file=sys.stderr)
            sys.exit(1)

    # 执行修改
    for p in params_list:
        pid = p.get("id")
        if pid in new_params:
            old_val = p.get("defaultValue")
            p["defaultValue"] = new_params[pid]
            print(f"修改参数: {pid}: {old_val} -> {new_params[pid]}")

    # PUT 回去
    put_result = make_request(
        full_url, method="PUT", data=data, access_token=access_token
    )
    if put_result.get("status") != 0:
        print(f"PUT 失败: {put_result}", file=sys.stderr)
        sys.exit(1)

    # 验证修改结果
    verify_result = make_request(full_url, access_token=access_token)
    if verify_result.get("status") == 0:
        new_version = verify_result["data"].get("latestVersion")
        verify_params = verify_result["data"]["stages"][0]["containers"][0].get("params", [])
        print(f"PUT 成功，新版本号: {new_version}")
        for p in verify_params:
            if p.get("id") in new_params:
                print(f"验证成功: {p['id']} = {p.get('defaultValue')}")


def cmd_pipelines(args: argparse.Namespace) -> None:
    """
    获取项目流水线列表

    API: GET /projects/{projectId}/pipelineView/listViewPipelines

    查询项目下的流水线列表，支持分页和多种筛选条件。
    适用于用户未指定具体流水线ID时获取可选流水线。
    """
    access_token = get_access_token(args.access_token)

    url = f"{BASE_URL}/projects/{args.project_id}/pipelineView/listViewPipelines"
    params: Dict[str, Any] = {
        "viewId": args.view_id if args.view_id else "allPipeline",
        "sortType": args.sort_type if args.sort_type else "LAST_EXEC_TIME",
        "collation": args.collation if args.collation else "DESC",
    }

    # 分页参数
    if args.page is not None:
        params["page"] = args.page
    if args.page_size is not None:
        params["pageSize"] = args.page_size

    # 筛选参数
    if args.filter_by_pipeline_name:
        params["filterByPipelineName"] = args.filter_by_pipeline_name
    if args.filter_by_creator:
        params["filterByCreator"] = args.filter_by_creator
    if args.filter_by_labels:
        params["filterByLabels"] = args.filter_by_labels
    if args.filter_by_view_ids:
        params["filterByViewIds"] = args.filter_by_view_ids
    if args.view_name:
        params["viewName"] = args.view_name
    if args.is_project is not None:
        params["isProject"] = str(args.is_project).lower()
    if args.show_delete is not None:
        params["showDelete"] = str(args.show_delete).lower()

    full_url = build_url(url, params)

    result = make_request(full_url, access_token=access_token)

    # 清洗数据，只保留关键字段
    if result.get("status") == 0 and "data" in result and "records" in result["data"]:
        result["data"]["records"] = clean_pipeline_data(result["data"]["records"])
        result["_cleaned"] = True
        result["_original_fields_count"] = "已清洗字段，保留关键信息"

    print_data(result)


def main():
    parser = argparse.ArgumentParser(
        prog="pipeline_client.py",
        description="蓝盾流水线 Python 客户端",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 获取项目流水线列表
  python pipeline_client.py pipelines --project-id myproject

  # 获取启动参数
  python pipeline_client.py startup-info --project-id myproject --pipeline-id p-abc123

  # 启动构建（无参数）
  python pipeline_client.py start --project-id myproject --pipeline-id p-abc123

  # 启动构建（带参数）
  python pipeline_client.py start --project-id myproject --pipeline-id p-abc123 \\
      --params '{"branch":"master","env":"prod"}'

  # 查看构建状态
  python pipeline_client.py status --project-id myproject --pipeline-id p-abc123 --build-id b-xyz789

  # 查询最近10条构建历史
  python pipeline_client.py list --project-id myproject --pipeline-id p-abc123 --page-size 10

环境变量:
  BK_CI_ACCESS_TOKEN     蓝盾 API 访问令牌
        """,
    )

    parser.add_argument(
        "--access-token",
        help="蓝盾 API 访问令牌（也可通过 BK_CI_ACCESS_TOKEN 环境变量设置）",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # pipelines 子命令 - 获取流水线列表
    pipelines_parser = subparsers.add_parser(
        "pipelines",
        help="获取项目流水线列表",
        description="查询项目下的流水线列表，数据已清洗保留关键字段",
    )
    pipelines_parser.add_argument(
        "--project-id", required=True, help="项目英文名"
    )
    pipelines_parser.add_argument("--page", type=int, help="页码（默认0）")
    pipelines_parser.add_argument(
        "--page-size", type=int, help="每页条数（默认20）"
    )
    pipelines_parser.add_argument(
        "--filter-by-pipeline-name", help="按流水线名称筛选"
    )
    pipelines_parser.add_argument(
        "--filter-by-creator", help="按创建人筛选"
    )
    pipelines_parser.add_argument(
        "--filter-by-labels", help="按标签筛选"
    )
    pipelines_parser.add_argument(
        "--filter-by-view-ids", help="按流水线组ID筛选"
    )
    pipelines_parser.add_argument("--view-id", help="流水线组ID")
    pipelines_parser.add_argument("--view-name", help="流水线组名称")
    pipelines_parser.add_argument(
        "--sort-type",
        choices=["CREATE_TIME", "UPDATE_TIME", "PIPELINE_NAME", "LAST_EXEC_TIME"],
        help="排序类型"
    )
    pipelines_parser.add_argument(
        "--collation",
        choices=["ASC", "DESC"],
        help="排序方式（升序/降序）"
    )
    pipelines_parser.add_argument(
        "--is-project",
        type=lambda x: x.lower() == "true",
        help="是否为项目流水线（true/false）"
    )
    pipelines_parser.add_argument(
        "--show-delete",
        type=lambda x: x.lower() == "true",
        help="是否显示已删除流水线（true/false）"
    )

    # startup-info 子命令
    startup_info_parser = subparsers.add_parser(
        "startup-info",
        help="获取流水线手动启动参数",
        description="获取流水线启动所需的参数定义",
    )
    startup_info_parser.add_argument(
        "--project-id", required=True, help="项目英文名"
    )
    startup_info_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    startup_info_parser.add_argument("--version", help="流水线版本号")

    # start 子命令
    start_parser = subparsers.add_parser(
        "start", help="启动流水线构建", description="手动触发流水线构建"
    )
    start_parser.add_argument("--project-id", required=True, help="项目英文名")
    start_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    start_parser.add_argument(
        "--build-no", type=int, help="指定构建版本号"
    )
    start_parser.add_argument(
        "--params",
        help='构建参数 JSON 字符串，如：\'{"branch":"master"}\'',
    )

    # stop 子命令
    stop_parser = subparsers.add_parser(
        "stop",
        aliases=["cancel"],
        help="取消流水线构建",
        description="取消指定构建（通常用于运行中或排队中的构建）",
    )
    stop_parser.add_argument("--project-id", required=True, help="项目英文名")
    stop_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    stop_parser.add_argument(
        "--build-id", required=True, help="构建 ID（b-开头）"
    )
    stop_parser.add_argument("--channel", choices=["BS", "GIT", "CREATIVE_STREAM"],
                             help="仅在另有可靠证据确认实际渠道时指定；必须与响应中的渠道一致")
    stop_parser.add_argument("--wait-seconds", type=int, default=30,
                             help="停止后的有限状态复查时长，0–60 秒，默认30；不自动重发停止")

    # status 子命令
    status_parser = subparsers.add_parser(
        "status", help="查看构建状态", description="查看指定构建的详细状态"
    )
    status_parser.add_argument("--project-id", required=True, help="项目英文名")
    status_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    status_parser.add_argument(
        "--build-id", required=True, help="构建 ID（b-开头）"
    )

    # list 子命令
    list_parser = subparsers.add_parser(
        "list",
        help="获取流水线构建历史",
        description="查询流水线的历史构建记录",
    )
    list_parser.add_argument("--project-id", required=True, help="项目英文名")
    list_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    list_parser.add_argument("--page", type=int, help="页码（默认1）")
    list_parser.add_argument(
        "--page-size", type=int, help="每页条数（最大100，默认20）"
    )
    list_parser.add_argument(
        "--status",
        choices=["SUCCEED", "FAILED", "CANCELED", "RUNNING", "QUEUE", "STAGE_SUCCESS"],
        help="按状态筛选",
    )
    list_parser.add_argument(
        "--trigger",
        choices=["MANUAL", "TIME_TRIGGER", "WEB_HOOK", "PIPELINE", "REMOTE"],
        help="按触发方式筛选",
    )
    list_parser.add_argument("--start-user", help="按启动人筛选")
    list_parser.add_argument("--build-no-start", type=int, help="构建号范围起始")
    list_parser.add_argument("--build-no-end", type=int, help="构建号范围结束")
    list_parser.add_argument(
        "--start-time-start", type=int, help="开始时间范围起始（13位时间戳）"
    )
    list_parser.add_argument(
        "--start-time-end", type=int, help="开始时间范围结束（13位时间戳）"
    )
    list_parser.add_argument(
        "--end-time-start", type=int, help="结束时间范围起始（13位时间戳）"
    )
    list_parser.add_argument(
        "--end-time-end", type=int, help="结束时间范围结束（13位时间戳）"
    )
    list_parser.add_argument(
        "--archive-flag", type=lambda x: x.lower() == "true", help="是否查询归档数据"
    )
    list_parser.add_argument("--build-msg", help="按构建信息筛选")
    list_parser.add_argument("--remark", help="按备注筛选")
    list_parser.add_argument("--material-alias", help="按代码库别名筛选")
    list_parser.add_argument("--material-branch", help="按代码库分支筛选")
    list_parser.add_argument("--material-commit-id", help="按提交ID筛选")
    list_parser.add_argument(
        "--update-time-desc",
        type=lambda x: x.lower() == "true",
        help="是否按更新时间降序",
    )

    # update-params 子命令
    update_params_parser = subparsers.add_parser(
        "update-params",
        help="修改流水线默认启动参数",
        description="修改流水线变量的默认值（stages[0].containers[0].params）",
    )
    update_params_parser.add_argument("--project-id", required=True, help="项目英文名")
    update_params_parser.add_argument(
        "--pipeline-id", required=True, help="流水线 ID（p-开头）"
    )
    update_params_parser.add_argument(
        "--params",
        required=True,
        help='要修改的参数，JSON 字符串，如：\'{"BRANCH_NAME": "release/1.4.0.0"}\'',
    )

    args = parser.parse_args()
    if args.command in {"stop", "cancel"} and not 0 <= args.wait_seconds <= 60:
        parser.error("--wait-seconds must be between 0 and 60")

    if args.command == "pipelines":
        cmd_pipelines(args)
    elif args.command == "startup-info":
        cmd_startup_info(args)
    elif args.command == "start":
        cmd_start(args)
    elif args.command in {"stop", "cancel"}:
        cmd_stop(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "update-params":
        cmd_update_params(args)



if __name__ == "__main__":
    main()
