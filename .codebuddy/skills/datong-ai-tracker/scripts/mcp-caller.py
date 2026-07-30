"""
大同 MCP 工具调用脚本

当用户项目未配置 MCP 时，通过 HTTP 网关调用大同 MCP 工具。
支持 2 个工具：get_page_structure / start_realtime_debug_mode

用法：
    python mcp-caller.py <工具名> [参数...]

示例：
    # 查询可用工具列表
    python mcp-caller.py list

    # 通过 appId + pageId 获取页面结构
    python mcp-caller.py get_page_structure --appId xxx --pageId 123

    # 开启实时联调
    python mcp-caller.py start_realtime_debug_mode --appId xxx --appkey xxx
"""

import json
import sys
import argparse
import urllib.request
import urllib.error

GATEWAY_URL = "http://03.mcp-gateway.woa.com/bbnqvGTGIQoizpwI/sse"


def parse_sse_response(body: str) -> dict:
    """解析 SSE 格式响应，提取最后一条 data 中的 JSON"""
    last_data = None
    for line in body.splitlines():
        if line.startswith("data:"):
            last_data = line[len("data:"):].strip()
    if last_data:
        return json.loads(last_data)
    # 不是 SSE 格式，尝试直接解析
    return json.loads(body)


def call_mcp(method: str, params: dict = None) -> dict:
    """发送 JSON-RPC 2.0 请求到 MCP 网关"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
    }
    if params:
        payload["params"] = params

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GATEWAY_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return parse_sse_response(body)
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.reason}"}
    except urllib.error.URLError as e:
        return {"error": f"连接失败: {e.reason}"}
    except json.JSONDecodeError:
        return {"error": f"响应解析失败，原始内容：{body[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def list_tools():
    """查询可用工具列表"""
    result = call_mcp("tools/list")
    print(json.dumps(result, indent=2, ensure_ascii=False))


def call_tool(name: str, arguments: dict):
    """调用指定工具"""
    result = call_mcp("tools/call", {"name": name, "arguments": arguments})
    print(json.dumps(result, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(
        description="大同 MCP 工具调用脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python mcp-caller.py list
  python mcp-caller.py get_page_structure --appId xxx --pageId 123
  python mcp-caller.py start_realtime_debug_mode --appId xxx --appkey xxx
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="工具名称")

    # list - 查询工具列表
    subparsers.add_parser("list", help="查询可用工具列表")

    # get_page_structure
    p2 = subparsers.add_parser("get_page_structure", help="通过 appId+pageId 获取页面结构")
    p2.add_argument("--appId", required=True, help="大同应用 ID")
    p2.add_argument("--pageId", required=True, type=int, help="页面 ID")

    # start_realtime_debug_mode
    p3 = subparsers.add_parser("start_realtime_debug_mode", help="开启实时联调")
    p3.add_argument("--appId", required=True, help="大同应用 ID")
    p3.add_argument("--appkey", required=True, help="SDK 应用密钥")
    p3.add_argument("--existingDebugId", default=None, help="已有的 debugId（可选）")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "list":
        list_tools()
        return

    # 构建参数字典
    tool_args = {}

    if args.command == "get_page_structure":
        tool_args = {"appId": args.appId, "pageId": args.pageId}

    elif args.command == "start_realtime_debug_mode":
        tool_args = {"appId": args.appId, "appkey": args.appkey}
        if args.existingDebugId:
            tool_args["existingDebugId"] = args.existingDebugId

    call_tool(args.command, tool_args)


if __name__ == "__main__":
    main()
