"""vela_im: the IM command line for an Agent.

It finds this Agent's own worker through HERMES_HOME (set per profile by Hermes for every command it runs), so there
is no identity or token argument. Without --to it targets the conversation the Agent is currently answering
(HERMES_SESSION_CHAT_ID), and replies carry the current message's hop chain (HERMES_SESSION_MESSAGE_ID).
"""
import argparse
import json
import os
import sys

from .client import MESSAGE_TYPES, GroupReplyMode, VelaClient, VelaHTTPError, media_kind, platform_group_id
from .worker import WorkerError


def _print(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _current_chat():
    chat = os.getenv("HERMES_SESSION_CHAT_ID", "")
    if chat.startswith("GROUP"):
        return chat[5:], "GROUP"
    if chat.startswith("C2C"):
        return chat[3:], "C2C"
    return None, None


def _target(args):
    if args.to:
        if args.to.startswith("GROUP"):
            return args.to[5:], "GROUP"
        if args.to.startswith("C2C"):
            return args.to[3:], "C2C"
        return args.to, "GROUP" if args.group or platform_group_id(args.to) or args.to.startswith("@TGS#") else "C2C"
    to, kind = _current_chat()
    if not to:
        raise SystemExit("缺少 --to：当前不在某个会话里")
    return to, kind


def _group_arg(value):
    if value:
        return value
    to, kind = _current_chat()
    if kind != "GROUP":
        raise SystemExit("缺少群 ID：当前不在群会话里")
    return to


def cmd_whoami(client, args):
    capabilities = client.capabilities()
    control = client.control()
    _print({"identity": capabilities.get("identity"), "commandPolicy": control.get("commandPolicy"),
            "ownerUserIds": control.get("owner", {}).get("userIds", [])})


def cmd_send(client, args):
    to, kind = _target(args)
    reply_to = None if args.to else os.getenv("HERMES_SESSION_MESSAGE_ID") or None
    if args.file:
        message_type = args.type if args.type in ("image", "audio", "video", "file") else media_kind(args.file)
        payload = json.loads(args.payload) if args.payload else {}
        _print(client.send(to, kind, message_type, payload, reply_to_message_id=reply_to, attachment=client.attachment(args.file)))
        return
    if args.payload:
        payload, message_type = json.loads(args.payload), args.type
    else:
        if args.text is None:
            raise SystemExit("需要 --text 或 --payload")
        payload = {"text": args.text}
        message_type = "textAt" if args.at else "text"
        if args.at:
            payload["atUserList"] = args.at
    _print(client.send(to, kind, message_type, payload, reply_to_message_id=reply_to))


def cmd_conversations(client, args):
    _print(client.get_conversations())


def cmd_history(client, args):
    conversation = args.conversation or os.getenv("HERMES_SESSION_CHAT_ID")
    if not conversation:
        raise SystemExit("缺少 --conversation")
    _print(client.get_messages(conversation, args.next, args.count))


def cmd_group(client, args):
    action = args.action
    if action == "create":
        _print(client.create_group(args.name, args.members or [], args.reply_mode))
    elif action == "info":
        group = _group_arg(args.group)
        _print(client.group(group) if platform_group_id(group) else client.get_group_profile(group))
    elif action == "members":
        _print(client.get_group_members(_group_arg(args.group)))
    elif action == "set":
        _print(client.update_group(_group_arg(args.group), name=args.name, reply_mode=args.reply_mode))
    elif action == "add":
        _print(client.add_group_members(_group_arg(args.group), args.users))
    elif action == "remove":
        _print(client.remove_group_members(_group_arg(args.group), args.users))
    elif action == "quit":
        _print(client.quit_group(_group_arg(args.group)))
    elif action == "dismiss":
        _print(client.dismiss_group(_group_arg(args.group)))
    elif action == "list":
        _print(client.get_groups())


def cmd_friend(client, args):
    action = args.action
    if action == "list":
        _print(client.get_friends())
    elif action == "requests":
        _print(client.get_friend_applications())
    elif not args.user:
        raise SystemExit("需要用户 ID")
    elif action == "add":
        _print(client.add_friend(args.user, args.wording or ""))
    elif action == "accept":
        _print(client.accept_friend(args.user))
    elif action == "refuse":
        _print(client.refuse_friend(args.user))
    elif action == "delete":
        _print(client.delete_friend(args.user))


def cmd_profile(client, args):
    _print(client.get_user_profiles(args.users) if args.users else client.get_my_profile())


def cmd_events(client, args):
    _print(client.events(args.after, 0))


def cmd_call(client, args):
    _print(client.call(args.method, *json.loads(args.args or "[]")))


def parser():
    root = argparse.ArgumentParser(prog="vela_im", description="以当前 Agent 自己的 IM 身份收发消息、管理群聊。")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("whoami", help="当前身份、命令权限与主人").set_defaults(run=cmd_whoami)

    send = commands.add_parser("send", help="发送消息（默认发到当前会话）")
    send.add_argument("--to", help="对方 userID 或群 ID；省略时发到当前会话")
    send.add_argument("--group", action="store_true", help="--to 是群 ID")
    send.add_argument("--text")
    send.add_argument("--at", nargs="*", help="群里 @ 的 userID（@all 表示全体）")
    send.add_argument("--type", default="text", choices=MESSAGE_TYPES)
    send.add_argument("--payload", help="原生消息 payload（JSON）")
    send.add_argument("--file", help="本地图片/语音/视频/文件路径")
    send.set_defaults(run=cmd_send)

    commands.add_parser("conversations", help="会话列表与未读").set_defaults(run=cmd_conversations)

    history = commands.add_parser("history", help="会话历史（默认当前会话）")
    history.add_argument("--conversation", help="C2C<userID> 或 GROUP<groupID>")
    history.add_argument("--next", help="上一页返回的 nextReqMessageID")
    history.add_argument("--count", type=int)
    history.set_defaults(run=cmd_history)

    group = commands.add_parser("group", help="群聊：建群、查看、改名/回复模式、拉人、踢人、退群、解散")
    group.add_argument("action", choices=["create", "list", "info", "members", "set", "add", "remove", "quit", "dismiss"])
    group.add_argument("group", nargs="?", help="群 ID（省略时用当前群）")
    group.add_argument("users", nargs="*", help="add/remove 的 userID")
    group.add_argument("--name")
    group.add_argument("--members", nargs="*", help="create 的初始成员 userID")
    group.add_argument("--reply-mode", choices=[mode.value for mode in GroupReplyMode])
    group.set_defaults(run=cmd_group)

    friend = commands.add_parser("friend", help="好友")
    friend.add_argument("action", choices=["list", "requests", "add", "accept", "refuse", "delete"])
    friend.add_argument("user", nargs="?")
    friend.add_argument("--wording")
    friend.set_defaults(run=cmd_friend)

    profile = commands.add_parser("profile", help="自己或他人的资料")
    profile.add_argument("--users", nargs="*")
    profile.set_defaults(run=cmd_profile)

    events = commands.add_parser("events", help="持久化事件")
    events.add_argument("--after", type=int, default=0)
    events.set_defaults(run=cmd_events)

    call = commands.add_parser("call", help="其余用户级腾讯 SDK 方法")
    call.add_argument("method")
    call.add_argument("args", nargs="?", help="官方位置参数（JSON 数组）")
    call.set_defaults(run=cmd_call)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == "group" and args.action in ("add", "remove") and args.group and not args.users and not platform_group_id(args.group):
        # `group add a_x` inside the current group: the positional is a user, not a group.
        args.users, args.group = [args.group], None
    try:
        client = VelaClient.for_profile()
        args.run(client, args)
    except (WorkerError, VelaHTTPError, ValueError) as error:
        print(f"vela_im: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
