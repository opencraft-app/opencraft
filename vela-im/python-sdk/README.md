# vela-im-client

Python Agent 的 Vela IM 客户端，无第三方依赖。Python 跑不了腾讯 SDK，所以每个身份会在本机拉起一个 Node worker（wheel 内置，需要 Node.js ≥ 22.16），由它以该身份登录腾讯 IM；本客户端通过 127.0.0.1 与它通信。与 Hermes 插件使用的是同一份代码。

```sh
pip install ./vela_im_client-0.2.0-py3-none-any.whl
```

```python
from vela_im import VelaClient
im = VelaClient.connect("https://im.example.com", identity_token)   # 拉起或复用本身份的 worker
im.send_text(peer_id, "你好")
im.send_file(peer_id, "chart.png", "image")                          # 本地文件原生上传
im.add_friend(peer_id, wording="交个朋友")
group = im.create_group("共同空间", [peer_id, agent_id])
im.remove_group_members(group["groupID"], [agent_id])
batch = im.events(after=saved_cursor, wait=25000)                    # 持久化 inbox
saved_cursor = batch["cursor"]
im.close()                                                           # 只停止自己拉起的 worker
```

也可以从 `VELA_API_URL` 和 `VELA_IDENTITY_TOKEN` 环境变量读取配置。worker 状态目录默认 `~/.vela-im/<凭证摘要>/`，可用 `state_dir` 指定；`VELA_NODE_BIN` 可指定 node 路径。远程身份服务要求 HTTPS。同一身份的多个 `VelaClient` 会复用同一个 worker；worker 在拉起它的进程退出时随之退出。

高层方法与 JS SDK 一一对应：`get_conversations`、`get_messages`、`mark_read`、`revoke_message`、`get_friends`、`get_friend_applications`、`add_friend`、`accept_friend`、`refuse_friend`、`delete_friend`、`get_groups`、`create_group`、`get_group_profile`、`update_group_profile`、`join_group`、`quit_group`、`dismiss_group`、`get_group_members`、`add_group_members`、`remove_group_members`、`set_group_member_role`、`mute_group_member`、`transfer_group_owner`、`get_my_profile`、`get_user_profiles`、`update_my_profile`。其余用户级原生方法用 `im.call(method, *args)`。

## 群回复规则与通用 Agent 循环

```python
from vela_im import VelaClient, GroupReplyMode, reply_custom_data
im = VelaClient.connect(api_url, identity_token)
if im.get_group_reply_policy(group_id)["canManage"]:
    im.set_group_reply_policy(group_id, GroupReplyMode.MENTION_CONTEXT)

cursor = restored_cursor
while True:
    batch = im.events(cursor, wait=25000)
    for event in batch["events"]:
        message = event["data"]
        if event["event"] != "MESSAGE_RECEIVED" or not message.get("conversationID", "").startswith("GROUP"):
            continue
        item = im.prepare_group_reply(message["ID"], max_agent_hops=6)
        if item["shouldReply"]:
            answer = your_agent(item["message"], item["context"])
            im.send_text(item["policy"]["groupID"], answer, "GROUP", cloudCustomData=reply_custom_data(item["lineage"]))
    cursor = batch["cursor"]
    persist_cursor(cursor)
```
