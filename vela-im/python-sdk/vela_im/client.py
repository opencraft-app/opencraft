"""Bot-scoped Vela IM client for Python Agents. Standard library only.

Python cannot run Tencent's SDK, so each Bot has a local Node worker that logs in with the official SDK. This client
talks to that worker over its Unix socket. IM operations go to Tencent directly; platform group operations (create,
members, reply rules) go to the LightVela backend with the Bot's own short-lived session.
"""
import json
import os
import re
import time
import uuid
from urllib.parse import quote
from enum import Enum
from pathlib import Path
from typing import Literal, TypedDict

from .worker import AgentWorker, WorkerEndpoint, WorkerError, read_endpoint, socket_request


class GroupReplyMode(str, Enum):
    MENTION = "mention"
    MENTION_CONTEXT = "mention_context"
    ALL = "all"


class GroupReplyPolicy(TypedDict):
    groupID: str
    platformGroupId: str | None
    mode: Literal["mention", "mention_context", "all"]
    effectiveMode: Literal["mention", "mention_context", "all"]
    contextMessages: int
    members: list[dict]
    canManage: bool


class GroupReplyInput(TypedDict):
    message: dict
    policy: GroupReplyPolicy
    shouldReply: bool
    reason: str
    context: list[dict]
    contextStatus: str
    lineage: dict


MESSAGE_TYPES = ("text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward")
_PLATFORM_GROUP = re.compile(r"^(?:GROUP)?vg_([0-9a-f]{32})$", re.IGNORECASE)


def destination(to, conversation_type):
    """Tencent addressing: groups use the raw GroupId, never the GROUP conversation prefix."""
    if conversation_type == "GROUP" and (to.startswith("GROUP@TGS#") or to.startswith("GROUPvg_")):
        return to[5:]
    return to


def platform_group_id(value):
    """Platform group UUID from a UUID, Tencent GroupId (vg_…) or GROUP conversation ID; None for other groups."""
    value = str(value or "").strip()
    try:
        return str(uuid.UUID(value))
    except ValueError:
        pass
    match = _PLATFORM_GROUP.match(value)
    return str(uuid.UUID(match.group(1))) if match else None


def uuid7():
    """RFC 9562 UUIDv7 for client-generated platform IDs (retry-safe group creation)."""
    millis = time.time_ns() // 1_000_000
    raw = bytearray(millis.to_bytes(6, "big") + os.urandom(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
VIDEO_SUFFIXES = {".mp4"}


def media_kind(path):
    """Message type for a local file: Tencent previews images and mp4 videos inline, everything else is a file."""
    suffix = Path(str(path)).suffix.lower()
    return "image" if suffix in IMAGE_SUFFIXES else "video" if suffix in VIDEO_SUFFIXES else "file"


def reply_custom_data(lineage, sender_kind="bot"):
    """cloudCustomData for an automatic reply: same chain, one more hop."""
    return json.dumps({"vela": {"chainId": lineage["chainId"], "hops": int(lineage["hops"]) + 1, "senderKind": sender_kind}})


def state_dir_for(hermes_home=None):
    """Where a Hermes profile keeps this plugin's credential, config, inbox and worker.json."""
    home = Path(hermes_home or os.getenv("HERMES_HOME") or Path.home() / ".hermes")
    return home / "plugin-data" / "vela-im"


def delivered_config(state_dir):
    """Config the platform delivered with the credential (apiBaseUrl, imUserId, …); empty before provisioning."""
    try:
        return json.loads((Path(state_dir) / "config.json").read_text())
    except (OSError, ValueError):
        return {}


class VelaHTTPError(RuntimeError):
    def __init__(self, status, detail, code=None):
        self.status = status
        self.code = code
        super().__init__(f"Vela HTTP {status}: {detail}")


class VelaClient:
    """A normal IM identity. Humans and Bots have identical permissions in groups; the platform enforces them."""

    def __init__(self, endpoint: WorkerEndpoint, worker: AgentWorker | None = None):
        self.endpoint = endpoint
        self.worker = worker

    @classmethod
    def for_profile(cls, hermes_home=None):
        """Attach to the worker already serving this Hermes profile; never starts one or reads the credential."""
        endpoint = read_endpoint(state_dir_for(hermes_home))
        if endpoint is None:
            raise WorkerError("当前环境没有在线的 Vela IM worker：请在已开通 IM 的 Agent 里运行，或等待网关连接完成")
        return cls(endpoint)

    @classmethod
    def start(cls, api_url, credential_file, state_dir, file_root=None):
        """Start (or reuse) this Bot's worker and return a connected client."""
        worker = AgentWorker(api_url, credential_file, state_dir, file_root)
        return cls(worker.start(), worker=worker)

    @property
    def user_id(self):
        return self.endpoint.user_id

    def request(self, path, body=None, method=None, timeout=65):
        status, data = socket_request(self.endpoint.socket, method or ("GET" if body is None else "POST"), path, body, timeout)
        if status >= 400:
            data = data or {}
            raise VelaHTTPError(status, data.get("error", "IM request failed"), data.get("code"))
        return data

    def call(self, method, *args):
        """Any user-level Tencent SDK method with its official positional arguments."""
        return self.request("/call", {"method": method, "args": list(args)})

    def invoke(self, method, *args):
        """A high-level IM operation (same names as the JS SDK)."""
        return self.request("/invoke", {"method": method, "args": list(args)})

    def platform(self, method, *args):
        """A platform operation performed as this Bot (groups, members, reply rules, own identity)."""
        return self.request("/platform", {"method": method, "args": list(args)})

    def send(self, to, conversation_type="C2C", message_type="text", payload=None, reply_to_message_id=None, **options):
        if message_type not in MESSAGE_TYPES:
            raise ValueError(f"Unsupported message type {message_type}")
        body = {"to": destination(to, conversation_type), "conversationType": conversation_type,
                "type": message_type, "payload": payload or {}, **options}
        if reply_to_message_id:
            body["replyToMessageID"] = reply_to_message_id
        return self.request("/send", body)

    def send_text(self, to, text, conversation_type="C2C", **options):
        return self.send(to, conversation_type, "text", {"text": text}, **options)

    def send_file(self, to, path, message_type=None, conversation_type="C2C", payload=None, **options):
        """Upload a local file as a native Tencent media message; images and mp4 videos preview inline by default."""
        return self.send(to, conversation_type, message_type or media_kind(path), payload, attachment=self.attachment(path), **options)

    @staticmethod
    def attachment(path):
        file = Path(path).expanduser().resolve(strict=True)
        if not file.is_file():
            raise ValueError("Attachment must be a file")
        return {"path": str(file)}

    def capabilities(self):
        return self.request("/capabilities")

    def control(self):
        """This Bot's command policy ("owner" or "anyone") and every IM identity of its owner."""
        return self.request("/control")

    def events(self, after=0, wait=25000):
        return self.request(f"/events?after={int(after)}&wait={int(wait)}", timeout=max(65, wait / 1000 + 30))

    def message(self, message_id):
        """A message this Bot received or sent, from the worker's durable inbox."""
        return self.request("/message?id=" + quote(str(message_id), safe=""))

    def prepare_group_reply(self, message_id, max_agent_hops=3) -> GroupReplyInput:
        """Platform reply decision plus up to 10 preceding messages for a group message this Bot received."""
        return self.request("/group-reply", {"messageID": message_id, "maxAgentHops": max_agent_hops})

    # Conversations and messages
    def get_conversations(self):
        return self.invoke("getConversations")

    def get_messages(self, conversation_id, next_req_message_id=None, count=None):
        options = {k: v for k, v in (("nextReqMessageID", next_req_message_id), ("count", count)) if v}
        return self.invoke("getMessages", conversation_id, options)

    def mark_read(self, conversation_id):
        return self.invoke("markRead", conversation_id)

    def revoke_message(self, message_id):
        return self.invoke("revokeMessage", message_id)

    # Friends
    def get_friends(self):
        return self.invoke("getFriends")

    def get_friend_applications(self):
        return self.invoke("getFriendApplications")

    def add_friend(self, user_id, wording="", remark=""):
        return self.invoke("addFriend", user_id, {"wording": wording, "remark": remark})

    def accept_friend(self, user_id, remark=None):
        return self.invoke("acceptFriend", user_id, {"remark": remark} if remark else {})

    def refuse_friend(self, user_id):
        return self.invoke("refuseFriend", user_id)

    def delete_friend(self, user_id):
        return self.invoke("deleteFriend", user_id)

    # Groups: reads come from Tencent; every change goes through the platform so membership and rules stay authoritative.
    def get_groups(self):
        return self.invoke("getGroups")

    def get_group_profile(self, group_id):
        return self.invoke("getGroupProfile", destination(group_id, "GROUP"))

    def get_group_members(self, group_id):
        return self.invoke("getGroupMembers", destination(group_id, "GROUP"))

    def create_group(self, name, member_ids=(), reply_mode=None, group_id=None):
        body = {"name": name, "memberUserIds": list(member_ids), "groupId": group_id or uuid7()}
        if reply_mode:
            body["replyMode"] = GroupReplyMode(reply_mode).value
        return self.platform("createGroup", body)

    def group(self, group_id):
        return self.platform("group", self._platform_id(group_id))

    def update_group(self, group_id, name=None, reply_mode=None):
        body = {k: v for k, v in (("name", name), ("replyMode", reply_mode and GroupReplyMode(reply_mode).value)) if v}
        if not body:
            raise ValueError("Nothing to update")
        return self.platform("updateGroup", self._platform_id(group_id), body)

    def set_group_reply_mode(self, group_id, mode: GroupReplyMode | str):
        return self.update_group(group_id, reply_mode=mode)

    def add_group_members(self, group_id, user_ids):
        platform_id, result = self._platform_id(group_id), None
        for user_id in user_ids:
            result = self.platform("addGroupMember", platform_id, user_id)
        return result

    def remove_group_members(self, group_id, user_ids):
        platform_id, result = self._platform_id(group_id), None
        for user_id in user_ids:
            result = self.platform("removeGroupMember", platform_id, user_id)
        return result

    def quit_group(self, group_id):
        return self.remove_group_members(group_id, [self.user_id])

    def dismiss_group(self, group_id):
        return self.platform("dismissGroup", self._platform_id(group_id))

    @staticmethod
    def _platform_id(group_id):
        platform_id = platform_group_id(group_id)
        if not platform_id:
            raise ValueError(f"{group_id} 不是平台群；只有平台创建的群可以管理成员和回复规则")
        return platform_id

    # Profiles
    def get_my_profile(self):
        return self.invoke("getMyProfile")

    def get_user_profiles(self, user_ids):
        return self.invoke("getUserProfiles", list(user_ids))

    def update_my_profile(self, **profile):
        return self.invoke("updateMyProfile", profile)

    def close(self):
        if self.worker:
            self.worker.stop()
