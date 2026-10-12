# vela-im-client

Python 端的 Vela IM 客户端与 `vela_im` 命令行，无第三方依赖。Python 跑不了腾讯 SDK，所以每个 Bot 在本机有一个 Node worker
（wheel 内置，需要 Node.js ≥ 22.16），由它以该 Bot 的身份登录腾讯 IM；本客户端经 0600 的 Unix socket 与它通信。
与 Hermes 插件使用的是同一份代码。

```sh
pip install ./vela_im_client-0.3.0-py3-none-any.whl
```

```python
from vela_im import VelaClient, GroupReplyMode

# 在 Hermes profile 里：连接插件已经拉起的 worker，不读取凭据
im = VelaClient.for_profile()                     # 默认 $HERMES_HOME

# 自己托管 Bot：用平台交付的凭据文件拉起或复用 worker
im = VelaClient.start("https://api.example.com/v1/collaboration", "/path/to/credential", "/path/to/state")

im.send_text(peer_id, "你好")
im.send_file(peer_id, "chart.png", "image")       # 本地文件原生上传
group = im.create_group("周报", [human_id, bot_id], reply_mode=GroupReplyMode.MENTION_CONTEXT)
im.set_group_reply_mode(group["id"], GroupReplyMode.ALL)
im.remove_group_members(group["id"], [bot_id])
batch = im.events(after=saved_cursor, wait=25000) # 持久化 inbox
saved_cursor = batch["cursor"]
im.close()                                        # 只停止自己拉起的 worker
```

群的创建、拉人、踢人、改名 / 改规则、退出、解散走平台接口（`platform_group_id` 可以从腾讯 GroupId 或会话 ID 得到平台群 ID）；
其余方法与 JS SDK 一一对应：`get_conversations`、`get_messages`、`mark_read`、`revoke_message`、`get_friends`、
`get_friend_applications`、`add_friend`、`accept_friend`、`refuse_friend`、`delete_friend`、`get_groups`、
`get_group_profile`、`get_group_members`、`get_my_profile`、`get_user_profiles`、`update_my_profile`。
其余用户级原生方法用 `im.call(method, *args)`。

## 命令行

```sh
vela_im whoami
vela_im send --to u_xxx --text 你好
vela_im group create --name 周报 --members u_xxx a_yyy --reply-mode mention
vela_im history --conversation GROUPvg_xxx --count 20
```

在 Hermes 里运行时，命令行按 `HERMES_HOME` 找到当前 Bot，`send` / `history` / `group` 省略目标时用当前会话
（`HERMES_SESSION_CHAT_ID`）。

## 通用 Agent 循环

```python
from vela_im import VelaClient, reply_custom_data
im = VelaClient.start(api_url, credential_file, state_dir)
cursor = restored_cursor
while True:
    batch = im.events(cursor, wait=25000)
    for event in batch["events"]:
        message = event["data"]
        if event["event"] != "MESSAGE_RECEIVED" or not message.get("conversationID", "").startswith("GROUP"):
            continue
        item = im.prepare_group_reply(message["ID"], max_agent_hops=3)   # 按后台群规则判断，附上下文
        if item["shouldReply"]:
            answer = your_agent(item["message"], item["context"])
            im.send_text(item["policy"]["groupID"], answer, "GROUP", cloudCustomData=reply_custom_data(item["lineage"]))
    cursor = batch["cursor"]
    persist_cursor(cursor)
```
