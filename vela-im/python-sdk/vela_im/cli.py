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


def _in_vela_session():
    """The terminal belongs to a Vela IM conversation. A QQ or WeChat session of the same Agent has its own chat and
    message IDs, which must never be taken for IM ones."""
    platform = os.getenv("HERMES_SESSION_PLATFORM", "")
    return platform in ("", "vela_im")


def _current_chat():
    chat = os.getenv("HERMES_SESSION_CHAT_ID", "") if _in_vela_session() else ""
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
        raise SystemExit("缺少 --to：当前不在 Vela IM 会话里" if _in_vela_session() else "当前是其他平台的会话，请用 --to 指定 Vela IM 的接收方")
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


def _mention_text(client, group_id, users, text):
    """Tencent clients show a mention through the @name in the text; prepend the ones the text lacks."""
    names = {}
    if any(user not in ("@all", "all") for user in users):
        names = {member.get("userID"): member.get("nick") or member.get("userID") for member in client.get_group_members(group_id)}
    missing = []
    for user in users:
        if user in ("@all", "all"):
            label = "所有人"
        elif user in names:
            label = names[user]
        else:
            raise SystemExit(f"{user} 不在这个群里；用 vela_im group members 查看成员")
        if f"@{label}" not in text:
            missing.append(f"@{label}")
    return " ".join(missing + [text])


def cmd_send(client, args):
    to, kind = _target(args)
    # Inside a Vela IM turn every send continues the current message's chain, so the agent hop limit also bounds
    # mentions sent through this CLI.
    reply_to = os.getenv("HERMES_SESSION_MESSAGE_ID") or None if _in_vela_session() else None
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
            if kind != "GROUP":
                raise SystemExit("--at 只能用于群消息")
            payload = {"text": _mention_text(client, to, args.at, args.text), "atUserList": args.at}
    _print(client.send(to, kind, message_type, payload, reply_to_message_id=reply_to))


def cmd_conversations(client, args):
    _print(client.get_conversations())


def cmd_history(client, args):
    conversation = args.conversation or (os.getenv("HERMES_SESSION_CHAT_ID") if _in_vela_session() else None)
    if not conversation:
        raise SystemExit("缺少 --conversation")
    _print(client.get_messages(conversation, args.next, args.count))


def cmd_group(client, args):
    action = args.action
    if action == "create":
        _print(client.create_group(args.name, args.members or [], args.reply_mode))
    elif action == "list":
        _print(client.get_groups())
    elif action == "info":
        group = _group_arg(args.group)
        _print(client.group(group) if platform_group_id(group) else client.get_group_profile(group))
    elif action == "members":
        _print(client.get_group_members(_group_arg(args.group)))
    elif action == "set":
        if not args.name and not args.reply_mode:
            raise SystemExit("需要 --name 或 --reply-mode")
        _print(client.update_group(_group_arg(args.group), name=args.name, reply_mode=args.reply_mode))
    elif action == "add":
        _print(client.add_group_members(_group_arg(args.group), args.users))
    elif action == "remove":
        _print(client.remove_group_members(_group_arg(args.group), args.users))
    elif action == "quit":
        _print(client.quit_group(_group_arg(args.group)))
    elif action == "dismiss":
        _print(client.dismiss_group(_group_arg(args.group)))


def cmd_friend(client, args):
    _print(client.get_friends() if args.action == "list" else client.get_friend_applications())


def cmd_profile(client, args):
    _print(client.get_user_profiles(args.users) if args.users else client.get_my_profile())


def cmd_call(client, args):
    _print(client.call(args.method, *json.loads(args.args or "[]")))


GROUP_HELP = "群 ID（vg_… 或 GROUPvg_…）；在群会话里省略时用当前群"


def _command(parent, name, summary, examples, run=None, **kwargs):
    """A subcommand whose --help shows what it does and how to call it."""
    command = parent.add_parser(name, help=summary, description=summary, epilog="示例：\n" + "\n".join("  " + e for e in examples),
                                formatter_class=argparse.RawDescriptionHelpFormatter, **kwargs)
    if run:
        command.set_defaults(run=run)
    return command


def _group_target(command):
    command.add_argument("group_positional", nargs="?", metavar="GROUP", help=GROUP_HELP)
    command.add_argument("--group", help=GROUP_HELP)


def parser():
    root = argparse.ArgumentParser(
        prog="vela_im", description="以当前 Agent 自己的 IM 身份收发消息、管理群聊。身份由 HERMES_HOME 决定，不需要也不接受 ID 或 Token。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("常用：\n"
                "  vela_im send --to <IM userID|群ID> --text 你好      # 省略 --to 时发到当前会话\n"
                "  vela_im send --to vg_xxx --file ./report.pdf\n"
                "  vela_im group create --name 周报 --members u_xxx a_yyy\n"
                "  vela_im group add a_yyy                            # 当前群\n"
                "  vela_im history --count 20                         # 当前会话\n"
                "每个子命令都有自己的说明，例如 vela_im group --help、vela_im group add --help。\n"
                "IM userID：人类以 u_ 开头，Agent 以 a_ 开头；平台群 ID 以 vg_ 开头。"))
    commands = root.add_subparsers(dest="command", required=True, metavar="COMMAND")

    _command(commands, "whoami", "当前身份、命令权限与主人的 IM 身份", ["vela_im whoami"], cmd_whoami)

    send = _command(commands, "send", "发送消息（省略 --to 时发到当前会话）", [
        "vela_im send --text 收到                              # 当前会话",
        "vela_im send --to u_xxx --text 你好                   # 单聊",
        "vela_im send --to vg_xxx --text 大家好 --at a_yyy     # 群里 @ 某人（--at @all 表示全体）",
        "vela_im send --to vg_xxx --file ./chart.png           # 图片/音频/视频/文件按类型发送",
        "vela_im send --to u_xxx --type location --payload '{\"description\":\"公司\",\"longitude\":116.3,\"latitude\":39.9}'",
    ], cmd_send)
    send.add_argument("--to", help="接收方：IM userID（u_…/a_…）或群 ID（vg_…）；也接受 C2C…/GROUP… 会话 ID")
    send.add_argument("--group", action="store_true", help="--to 是非平台群的群 ID")
    send.add_argument("--text", help="文本内容")
    send.add_argument("--at", nargs="*", metavar="USER", help="群里 @ 的 IM userID（@all 表示全体）；正文缺少的 @名字 会自动补上")
    send.add_argument("--type", default="text", choices=MESSAGE_TYPES, help="消息类型，配合 --payload 使用")
    send.add_argument("--payload", help="原生消息 payload（JSON）")
    send.add_argument("--file", help="本地图片/音频/视频/文件路径")

    _command(commands, "conversations", "会话列表与未读数", ["vela_im conversations"], cmd_conversations)

    history = _command(commands, "history", "会话历史（省略 --conversation 时为当前会话）", [
        "vela_im history --count 20",
        "vela_im history --conversation GROUPvg_xxx --count 20",
        "vela_im history --conversation C2Cu_xxx --next <上一页的 nextReqMessageID>",
    ], cmd_history)
    history.add_argument("--conversation", help="会话 ID：C2C<userID> 或 GROUP<群ID>")
    history.add_argument("--next", help="上一页返回的 nextReqMessageID")
    history.add_argument("--count", type=int, help="每页条数")

    group = _command(commands, "group", "群聊：建群、查看、改名/回复模式、拉人、踢人、退群、解散", [
        "vela_im group create --name 周报 --members u_xxx a_yyy --reply-mode mention",
        "vela_im group list",
        "vela_im group info                                    # 当前群",
        "vela_im group set --name 新名字 --reply-mode mention_context",
        "vela_im group add a_yyy u_zzz --group vg_xxx",
        "vela_im group remove a_yyy",
        "vela_im group quit",
        "vela_im group dismiss --group vg_xxx",
    ])
    actions = group.add_subparsers(dest="action", required=True, metavar="ACTION")
    create = _command(actions, "create", "建群（成员和回复规则由平台登记）", [
        "vela_im group create --name 周报 --members u_xxx a_yyy",
        "vela_im group create --name 讨论 --members a_yyy --reply-mode all",
    ], cmd_group)
    create.add_argument("--name", required=True, help="群名")
    create.add_argument("--members", nargs="*", metavar="USER", help="初始成员的 IM userID")
    create.add_argument("--reply-mode", choices=[mode.value for mode in GroupReplyMode],
                        help="mention：@ 才回复（默认）；mention_context：@ 时附前 10 条上下文；all：无需 @")
    _command(actions, "list", "我所在的群", ["vela_im group list"], cmd_group)
    for name, summary in (("info", "群资料与回复规则"), ("members", "群成员")):
        _group_target(_command(actions, name, summary, [f"vela_im group {name}", f"vela_im group {name} --group vg_xxx"], cmd_group))
    update = _command(actions, "set", "改群名或回复模式（群主/管理员）", [
        "vela_im group set --name 新名字", "vela_im group set --group vg_xxx --reply-mode mention_context"], cmd_group)
    _group_target(update)
    update.add_argument("--name", help="新群名")
    update.add_argument("--reply-mode", choices=[mode.value for mode in GroupReplyMode], help="mention / mention_context / all")
    for name, summary in (("add", "拉人进群（群主/管理员可拉任何人；普通成员只能拉自己的 Agent）"),
                          ("remove", "把人移出群（群主/管理员；普通成员只能移出自己的 Agent）")):
        members = _command(actions, name, summary, [f"vela_im group {name} a_yyy", f"vela_im group {name} a_yyy u_zzz --group vg_xxx"], cmd_group)
        members.add_argument("users", nargs="+", metavar="USER", help="IM userID")
        members.add_argument("--group", help=GROUP_HELP)
    for name, summary in (("quit", "退出群"), ("dismiss", "解散群（只有群主）")):
        _group_target(_command(actions, name, summary, [f"vela_im group {name}", f"vela_im group {name} --group vg_xxx"], cmd_group))

    friend = _command(commands, "friend", "好友（只读；单聊不需要加好友）", ["vela_im friend list", "vela_im friend requests"])
    friend_actions = friend.add_subparsers(dest="action", required=True, metavar="ACTION")
    _command(friend_actions, "list", "好友列表", ["vela_im friend list"], cmd_friend)
    _command(friend_actions, "requests", "收到和发出的好友申请", ["vela_im friend requests"], cmd_friend)

    profile = _command(commands, "profile", "自己或他人的资料", ["vela_im profile", "vela_im profile --users u_xxx a_yyy"], cmd_profile)
    profile.add_argument("--users", nargs="*", metavar="USER", help="IM userID；省略时为自己")

    call = _command(commands, "call", "调用腾讯 SDK 的只读查询与少量消息操作（参数为官方位置参数）。群的变更请用 vela_im group", [
        "vela_im call getGroupMemberList '[{\"groupID\":\"vg_xxx\",\"count\":15,\"offset\":0}]'",
        "vela_im call searchCloudMessages '[{\"keywordList\":[\"周报\"]}]'",
        "vela_im call revokeMessage '[{\"$messageID\":\"<消息 ID>\"}]'"], cmd_call)
    call.add_argument("method", help="腾讯 SDK 方法名")
    call.add_argument("args", nargs="?", help="官方位置参数（JSON 数组）")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if getattr(args, "group_positional", None) and not args.group:
        args.group = args.group_positional
    if args.command == "group" and args.action in ("add", "remove") and not args.group and len(args.users) > 1 and platform_group_id(args.users[0]):
        # `group add vg_x a_y`: the first positional names the group.
        args.group, args.users = args.users[0], args.users[1:]
    try:
        client = VelaClient.for_profile()
        args.run(client, args)
    except (WorkerError, VelaHTTPError, ValueError) as error:
        print(f"vela_im: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
