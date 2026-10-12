"""Agent tools: the same SDK operations human clients use, served by this Agent's own worker."""
import json
from pathlib import Path
from .runtime import client_for, outbound_lineage, current_delivery, setting
from .vela_im import VelaClient, destination, reply_custom_data, MESSAGE_TYPES


def attachment(path):
    root = setting('VELA_FILE_ROOT')
    if root and not Path(path).expanduser().resolve(strict=True).is_relative_to(Path(root).resolve(strict=True)):
        raise ValueError('Attachment is outside the configured Vela media directory')
    return VelaClient.attachment(path)


def schema(name, description, properties=None, required=None):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties or {},
                           "required": required or [], "additionalProperties": False}}


STR = {"type": "string"}
OBJ = {"type": "object"}
ARR = {"type": "array", "items": STR}
TYPE = {"type": "string", "enum": ["C2C", "GROUP"], "default": "C2C"}
TOOLS = [
    schema("vela_identity", "查看当前 IM 身份、SDK 能力和支持的消息类型；人类与 Agent 的权限规则相同。"),
    schema("vela_send_message", "以当前身份给人类或其他 Agent 发送单聊/群聊。所有腾讯 SDK 消息类型均可发送。媒体可用 vela_send_file。合并/转发先 vela_history 缓存消息，再传 message_ids。群聊 @ 用 textAt，payload 包含 text 与 atUserList。", {
        "to": {"type": "string", "description": "对方 userID 或原始 groupID（如 @TGS#…），不要添加 C2C/GROUP 会话前缀。"}, "conversation_type": TYPE,
        "type": {"type": "string", "enum": list(MESSAGE_TYPES), "default": "text"},
        "payload": OBJ, "message_ids": ARR, "cloud_custom_data": STR, "need_read_receipt": {"type": "boolean"}}, ["to", "payload"]),
    schema("vela_send_file", "上传本地附件并作为腾讯 IM 原生图片、语音、视频或文件发送。语音可在 payload 中给 second（WAV/MP3/Ogg 可自动读取）。", {
        "to": STR, "path": STR, "conversation_type": TYPE,
        "type": {"type": "string", "enum": ["image", "audio", "video", "file"], "default": "file"},
        "payload": OBJ}, ["to", "path"]),
    schema("vela_conversations", "列出当前身份的所有单聊、群聊和未读数。"),
    schema("vela_history", "分页获取会话历史并缓存原生消息实例。conversation_id 格式为 C2C加userID 或 GROUP加groupID。", {
        "conversation_id": STR, "next_req_message_id": STR}, ["conversation_id"]),
    schema("vela_friends", "好友列表、申请、确认、拒绝和删除；不绕过对方确认规则。", {
        "action": {"type": "string", "enum": ["list", "requests", "add", "accept", "refuse", "delete"]},
        "user_id": STR, "wording": STR, "remark": STR}, ["action"]),
    schema("vela_groups", "群聊创建、列表、资料、加入、退出、修改与解散。create 使用 name 与 member_ids（人类和 Agent 都可以），默认 Public 群。reply_policy 查看群类型和回复规则，set_reply_policy 用 mode 设置 mention（仅@）、mention_context（@及前10条上下文）、all（每条消息）；只有群主/管理员能设置。update 的 options 为官方群资料字段。", {
        "action": {"type": "string", "enum": ["list", "create", "profile", "update", "join", "quit", "dismiss", "reply_policy", "set_reply_policy"]},
        "group_id": STR, "name": STR, "member_ids": ARR, "group_type": {"type": "string", "enum": ["Public", "Private", "ChatRoom", "Community"]},
        "mode": {"type": "string", "enum": ["mention", "mention_context", "all"]}, "options": OBJ}, ["action"]),
    schema("vela_group_members", "群成员列表、拉人、踢人、禁言、设置角色、转让群主；Agent 遵守与人类相同的群管理权限。", {
        "action": {"type": "string", "enum": ["list", "add", "remove", "mute", "role", "transfer"]},
        "group_id": STR, "user_ids": ARR, "role": {"type": "string", "enum": ["Admin", "Member"]},
        "seconds": {"type": "integer", "minimum": 0}, "reason": STR}, ["action", "group_id"]),
    schema("vela_profile", "查看/更新个人资料或查询其他用户资料。", {
        "action": {"type": "string", "enum": ["me", "users", "update"]}, "user_ids": ARR, "options": OBJ}, ["action"]),
    schema("vela_sdk_call", "调用当前普通身份的腾讯 V4 公开 SDK API，覆盖消息撤回/已读/扩展/回应、会话、好友分组、黑名单、话题、关注及信令。先 vela_identity 获取 method 清单。args 为官方位置参数数组。消息对象可用 {\"$messageID\":\"ID\"} 引用，先 vela_history 缓存。", {
        "method": STR, "args": {"type": "array", "items": {}}}, ["method"]),
    schema("vela_events", "读取包含完整原生 payload 的持久化 IM 事件；调用方保存 cursor，下一次通过 after 续读。", {
        "after": {"type": "integer", "minimum": 0, "default": 0}, "wait_ms": {"type": "integer", "minimum": 0, "maximum": 30000, "default": 0}}),
]


def _send(c, p, tool):
    options = {}
    if tool == "vela_send_file":
        options["attachment"] = attachment(p["path"])
    else:
        if p.get("message_ids"): options["messageIDs"] = p["message_ids"]
        if p.get("cloud_custom_data"): options["cloudCustomData"] = p["cloud_custom_data"]
        if p.get("need_read_receipt"): options["needReadReceipt"] = True
    parent = outbound_lineage.get()
    if parent and "cloudCustomData" not in options:
        options["cloudCustomData"] = reply_custom_data(parent)
    type_ = p.get("conversation_type", "C2C"); target = destination(p["to"], type_)
    result = c.send(target, type_, p.get("type", "file" if tool == "vela_send_file" else "text"), p.get("payload", {}), **options)
    delivery = current_delivery.get(); message_id = result.get("data", {}).get("message", {}).get("ID")
    if delivery and message_id and delivery["target"] == target and delivery["type"] == type_:
        delivery["message_ids"].append(message_id)
    return result


def execute(tool, p, client=None):
    c = client or client_for()
    if tool == "vela_identity": return c.capabilities()
    if tool == "vela_sdk_call": return c.call(p["method"], *p.get("args", []))
    if tool == "vela_events": return c.events(p.get("after", 0), p.get("wait_ms", 0))
    if tool == "vela_conversations": return c.get_conversations()
    if tool == "vela_history": return c.get_messages(p["conversation_id"], p.get("next_req_message_id"))
    if tool in ("vela_send_message", "vela_send_file"): return _send(c, p, tool)
    action = p["action"]
    if tool == "vela_friends":
        if action == "list": return c.get_friends()
        if action == "requests": return c.get_friend_applications()
        user = p["user_id"]
        if action == "add": return c.add_friend(user, p.get("wording", ""), p.get("remark", ""))
        if action == "accept": return c.accept_friend(user, p.get("remark"))
        if action == "refuse": return c.refuse_friend(user)
        if action == "delete": return c.delete_friend(user)
    if tool == "vela_groups":
        options = dict(p.get("options") or {})
        if action == "list": return c.get_groups()
        if action == "create":
            return c.create_group(p.get("name") or options.pop("name"), p.get("member_ids") or options.pop("memberIDs", []),
                                  p.get("group_type") or options.pop("type", "Public"), **options)
        group = p["group_id"]
        if action == "profile": return c.get_group_profile(group)
        if action == "update": return c.update_group_profile(group, **options)
        if action == "join": return c.join_group(group, options.get("applyMessage"))
        if action == "quit": return c.quit_group(group)
        if action == "dismiss": return c.dismiss_group(group)
        if action == "reply_policy": return c.get_group_reply_policy(group)
        if action == "set_reply_policy": return c.set_group_reply_policy(group, p.get("mode") or options["mode"])
    if tool == "vela_group_members":
        group, users = p["group_id"], p.get("user_ids") or []
        if action == "list": return c.get_group_members(group)
        if action == "add": return c.add_group_members(group, users)
        if action == "remove": return c.remove_group_members(group, users, p.get("reason"))
        if action == "mute": return [c.mute_group_member(group, user, p.get("seconds", 600)) for user in users]
        if action == "role": return [c.set_group_member_role(group, user, p.get("role", "Admin")) for user in users]
        if action == "transfer": return c.transfer_group_owner(group, users[0])
    if tool == "vela_profile":
        if action == "me": return c.get_my_profile()
        if action == "users": return c.get_user_profiles(p["user_ids"])
        return c.update_my_profile(**p["options"])
    raise ValueError("Unsupported Vela action")


def register_tools(ctx):
    if getattr(ctx, "_vela_registered", False): return
    ctx._vela_registered = True
    for item in TOOLS:
        name = item["name"]
        def handler(params, _tool=name, **kwargs):
            del kwargs
            try:
                return json.dumps({"success": True, "result": execute(_tool, params)}, ensure_ascii=False)
            except Exception as error:
                return json.dumps({"success": False, "error": str(error)}, ensure_ascii=False)
        ctx.register_tool(name=name, toolset="vela_im", schema=item, handler=handler, description=item["description"])
