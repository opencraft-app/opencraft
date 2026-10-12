"""Identity-scoped Vela IM client for Python Agents. Standard library only.

Python cannot run Tencent's SDK, so each identity gets a local Node worker (started on demand) that logs
in with the official SDK. This client speaks to that worker; the high-level methods mirror the JS SDK.
"""
import json
import os
from enum import Enum
from pathlib import Path
from typing import Literal, TypedDict
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .worker import AgentWorker, WorkerEndpoint


class GroupReplyMode(str, Enum):
    MENTION = "mention"
    MENTION_CONTEXT = "mention_context"
    ALL = "all"


class GroupReplyPolicy(TypedDict):
    groupID: str
    groupKind: Literal["bot", "mixed"]
    mode: Literal["mention", "mention_context", "all"]
    effectiveMode: Literal["mention", "mention_context", "all"]
    contextMessages: int
    canManage: bool
    memberCount: int
    updatedAt: int


class GroupReplyInput(TypedDict):
    message: dict
    policy: GroupReplyPolicy
    shouldReply: bool
    reason: str
    context: list[dict]
    contextStatus: str
    lineage: dict


MESSAGE_TYPES = ("text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward")


def destination(to, conversation_type):
    # Built-in Tencent group IDs are unambiguous; custom IDs may legitimately start GROUP.
    if conversation_type == "GROUP" and to.startswith("GROUP@TGS#"):
        return to[5:]
    return to


def reply_custom_data(lineage, sender_kind="agent"):
    """cloudCustomData for an automatic reply: same chain, one more hop."""
    return json.dumps({"vela": {"chainId": lineage["chainId"], "hops": int(lineage["hops"]) + 1, "senderKind": sender_kind}})


class VelaHTTPError(RuntimeError):
    def __init__(self, status, detail, code=None):
        self.status = status
        self.code = code
        super().__init__(f"Vela HTTP {status}: {detail}")


class VelaClient:
    """A normal IM identity. Humans and Agents have identical permissions; Tencent enforces them."""

    def __init__(self, endpoint: WorkerEndpoint | None = None, *, api_url=None, token=None, state_dir=None, file_root=None, worker=None):
        self.worker = worker
        if endpoint is None:
            self.worker = worker or AgentWorker(api_url or os.getenv("VELA_API_URL", ""), token or os.getenv("VELA_IDENTITY_TOKEN", ""),
                                                state_dir, file_root or os.getenv("VELA_FILE_ROOT") or None)
            endpoint = self.worker.start()
        self.endpoint = endpoint

    @classmethod
    def connect(cls, api_url=None, token=None, **options):
        """Start (or reuse) this identity's worker and return a connected client."""
        return cls(api_url=api_url, token=token, **options)

    @property
    def user_id(self):
        return self.endpoint.user_id

    def request(self, path, body=None, method=None, timeout=65):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = Request(self.endpoint.url + path, data=data, method=method or ("GET" if data is None else "POST"),
                          headers={"Authorization": "Bearer " + self.endpoint.secret, "Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                detail = json.loads(error.read())
            except ValueError:
                detail = {}
            raise VelaHTTPError(error.code, detail.get("error", "IM request failed"), detail.get("code")) from None

    def call(self, method, *args):
        """Any user-level Tencent SDK method with its official positional arguments."""
        return self.request("/call", {"method": method, "args": list(args)})

    def invoke(self, method, *args):
        """A Vela high-level operation (same names as the JS SDK)."""
        return self.request("/invoke", {"method": method, "args": list(args)})

    def send(self, to, conversation_type="C2C", message_type="text", payload=None, **options):
        if message_type not in MESSAGE_TYPES:
            raise ValueError(f"Unsupported message type {message_type}")
        return self.request("/send", {"to": destination(to, conversation_type), "conversationType": conversation_type,
                                      "type": message_type, "payload": payload or {}, **options})

    def send_text(self, to, text, conversation_type="C2C", **options):
        return self.send(to, conversation_type, "text", {"text": text}, **options)

    def send_file(self, to, path, message_type="file", conversation_type="C2C", payload=None, **options):
        """Upload a local image/audio/video/file as a native Tencent media message."""
        return self.send(to, conversation_type, message_type, payload, attachment=self.attachment(path), **options)

    @staticmethod
    def attachment(path):
        file = Path(path).expanduser().resolve(strict=True)
        if not file.is_file():
            raise ValueError("Attachment must be a file")
        return {"path": str(file)}

    def capabilities(self):
        return self.request("/capabilities")

    def events(self, after=0, wait=25000):
        return self.request(f"/events?after={int(after)}&wait={int(wait)}", timeout=max(65, wait / 1000 + 30))

    def prepare_group_reply(self, message_id, max_agent_hops=6) -> GroupReplyInput:
        """Trigger decision plus up to 10 preceding messages for a group message this identity received."""
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

    # Groups
    def get_groups(self):
        return self.invoke("getGroups")

    def create_group(self, name, member_ids=(), type="Public", **native):
        return self.invoke("createGroup", {"name": name, "memberIDs": list(member_ids), "type": type, **native})

    def get_group_profile(self, group_id):
        return self.invoke("getGroupProfile", destination(group_id, "GROUP"))

    def update_group_profile(self, group_id, **profile):
        return self.invoke("updateGroupProfile", destination(group_id, "GROUP"), profile)

    def join_group(self, group_id, apply_message=None):
        return self.invoke("joinGroup", destination(group_id, "GROUP"), *([apply_message] if apply_message else []))

    def quit_group(self, group_id):
        return self.invoke("quitGroup", destination(group_id, "GROUP"))

    def dismiss_group(self, group_id):
        return self.invoke("dismissGroup", destination(group_id, "GROUP"))

    def get_group_members(self, group_id):
        return self.invoke("getGroupMembers", destination(group_id, "GROUP"))

    def add_group_members(self, group_id, user_ids):
        return self.invoke("addGroupMembers", destination(group_id, "GROUP"), list(user_ids))

    def remove_group_members(self, group_id, user_ids, reason=None):
        return self.invoke("removeGroupMembers", destination(group_id, "GROUP"), list(user_ids), *([reason] if reason else []))

    def set_group_member_role(self, group_id, user_id, role):
        return self.invoke("setGroupMemberRole", destination(group_id, "GROUP"), user_id, role)

    def mute_group_member(self, group_id, user_id, seconds):
        return self.invoke("muteGroupMember", destination(group_id, "GROUP"), user_id, int(seconds))

    def transfer_group_owner(self, group_id, user_id):
        return self.invoke("transferGroupOwner", destination(group_id, "GROUP"), user_id)

    # Profiles
    def get_my_profile(self):
        return self.invoke("getMyProfile")

    def get_user_profiles(self, user_ids):
        return self.invoke("getUserProfiles", list(user_ids))

    def update_my_profile(self, **profile):
        return self.invoke("updateMyProfile", profile)

    def get_control(self):
        """This identity's command policy ("owner" or "anyone") and the identities of its owner."""
        return self.invoke("control")

    # Group reply policy (Vela extension; owner/admin may change it)
    def get_group_reply_policy(self, group_id) -> GroupReplyPolicy:
        return self.invoke("groupReplyPolicy", destination(group_id, "GROUP"))

    def set_group_reply_policy(self, group_id, mode: GroupReplyMode | str) -> GroupReplyPolicy:
        return self.invoke("setGroupReplyPolicy", destination(group_id, "GROUP"), GroupReplyMode(mode).value)

    def group_policy(self, group_id, mode=None):
        return self.get_group_reply_policy(group_id) if mode is None else self.set_group_reply_policy(group_id, mode)

    def close(self):
        if self.worker:
            self.worker.stop()
