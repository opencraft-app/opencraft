# 用户交互与SendMessage出口

0.15.0/schema17，2026-11-04。用户问「完整的用户交互与交付 SendMessage 那你搞一下？但是要怎么搞呢」。提出人未确认。先在独立无界面runner完成本地消息内核，便于以后独立运行及内置OpenCraft；当前不是Join平台接入或部署。

## 怎么接

让主助理输出结构化发送意图，宿主验证后保存可见消息，再由配置渠道接受。沿用原有业务owner，保留结果检查、等待和原文历史：

```text
主助理回复/结果决策、进度、Interaction问题、Notification
  → ConversationHistory：canonical回退文字 + 稳定messageId
  → MessageService：同一事务保存不可变payload与pending outbox
  → MessageDispatcher：只重投同一消息
  → 已配置Channel adapter：真实文件/消息接受回执
```

这就是本实现的SendMessage边界。当前主模型使用原JSON协议中的`kind:send`，后台报告使用`deliver.message`；worker继续向主助理报告。发送文字、显示进度、渠道接受、完成工作和用户已读分别记实。

## 文件夹和所有权

| owner/入口                                                                     | 拥有什么                                   | 协作                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| [application/messages](../src/application/messages/AGENTS.md) / MessageService | 用户消息payload、outbox、接受回执/有限重投 | 只读canonical消息/Interaction/Work及附件元信息                             |
| ConversationHistory                                                            | 原文、来源与工作关联                       | 同UoW调用MessageService；原文只存回退文字+messageId，typed payload在消息表 |
| Interaction/InteractionLedger                                                  | 原问题、选项、revision、答案、拒绝、过期   | MessageService只引用问题；原生Pi继续原callId/submission                    |
| Outcome/Completion/Notification                                                | 结果检查、原mailbox交付、通知选择/合并     | typed附件跟随原父决策与通知流程，不越过完成条件                            |
| LocalAttachmentStore                                                           | 当前profile不可变manifest/blob字节         | 模型只得到ID；导入来自显式CLI选文件或真实publish_note                      |
| MessageDispatcher + transport                                                  | 临时在途句柄、实际I/O                      | 持久待办仍从MessageService查；不能因重启重新生成结果                       |

源码入口是[总分治地图](module-map.md)。没有新建万能聊天manager、另一份问题答案库或凭据库。

## 支持的消息

- `text`：正文，可带最多8个附件引用。
- `attachment`：一个真实附件ID及可选alt。
- `replyTo`：只能引用同一主会话真实消息ID。它是引用关系，当前没有线程化UI。
- `question`：工作绑定Interaction的普通问题；可带1..6个真实选项及allowCustom。重复call仍返回原问题；值或唯一标签映射由Interaction校验。
- `secret-request`、`authorization-request`、`handoff`：复用原分型等待，封套只有问题/种类/provider/期限/revision；凭据仍走原安全输入到Vault，不进入消息、普通回复或Pi checkpoint。

主模型不能用send伪造问题或安全请求卡。主助理普通clarify目前仍是文字；可选择的卡片来自工作绑定的Interaction，没有增加“不绑定工作”的另一套提问状态。

模型可先查`attachments.list`，再提交：

```json
{
  "kind": "send",
  "message": {
    "type": "text",
    "content": "这是报告",
    "attachments": [{ "attachmentId": "真实目录返回的64位ID", "alt": "报告" }]
  }
}
```

Send必须是单个接待决策。系统结果要用`deliver.message`并继续通过原报告身份、work revision和Completion检查。模型无法通过message指定任意路径、URL、actor或未配置渠道。附件目录是当前单助理profile的主助理消息能力，worker没有目录读接口；首版没有多用户附件ACL，平台接入必须映射真实账号与资源授权。

## 问题与用户回应

真实Pi的ask_user可带choices/allowCustom。宿主先提交原Interaction、waiting_input和可见问题消息，然后原生挂起释放执行槽。选择卡引用interactionId/revision，消息查询展示原Interaction实时state。

message.respond引用messageId和expectedRevision，只接受所提供选项或allowCustom允许的自由文本；拒绝沿原Interaction.reject。处理成功在同一UoW记录真实用户回应、答案和输入去重，再恢复原工作。秘密/认证问题拒绝普通value回答，仍走authorize/provide-secret专用通路。过期、拒绝、取消或修改的旧卡不能恢复工作。

尚未投递的失效问题会withdrawn；已接受卡片通过原Interaction状态显示失效。卡片已被用户回答不代表工作完成。

## 附件边界

附件以内容/名称/声明MIME/大小生成ID，单文件上限8MiB，存到当前profile/attachments；导入和物化使用稳定身份核对字节。CLI显式文件读取拒绝符号链接、非普通文件、变化尺寸和超限。导入时先写blob再发布manifest，发送时重读并核对SHA256/大小，实际复制到outgoing/assets。

声明MIME按文件名扩展名推导，是元信息，不是内容安全检测。当前实现负责交付字节，没有文档预览/格式转换、ZIP/IPYNB预览或WorkBuddy SDK。原文件导入成功也不等于已经发给用户；只有消息渠道回执才记录接受。

新真实publish_note在原产物发布后同时注册附件，工具结果返回attachmentId，主助理可查询并交付。旧产物/历史消息不自动回填，也不因新版本重发。

## 持久化、顺序与失败

schema17新增user_message，主键引用真实canonical消息；body_json不可变，保存pending/accepted/failed/withdrawn、attempts/next_at/error、receipt_json/accepted_at。原文与outbox同UoW，失败回滚；相同ID不同body拒绝。delivery和notification增加user_message_json，让附件通过原结果和通知选择链路。

每会话一次只处理最早pending，单次调用15秒截止。重试始终用相同ID和payload，250ms指数退避到30秒；累计5次失败保存failed并允许后续消息前进，用户可message-retry重置该消息。重试不运行模型、不重做工作。已失效的revision绑定消息在开始投递前撤回；已发生的渠道效果不回滚。

接受回执必须匹配messageId/channel/level/remoteId。timeout/abort表示接受可能未知；未来外部adapter必须以稳定ID幂等或先对账，不能盲目制造第二条远端消息。本地adapter逐字节核对已写JSON和附件，真实进程在写文件后、回执前退出可恢复，不产生重复历史/文件。关闭停止新发送并取消等待，未确认义务保留。

Notification合并超过每消息8个附件时拆成多个封套，保留所有文件；changed比较纳入附件payload，quiet选择仍由原通知owner决定。

## 接受等级与兼容

当前唯一目的地为`local:main`，文件在profile/outgoing，adapter返回`level=accepted`。这是本地落盘，`readStatus=unknown`；本轮没有用户已读事件、Slack/飞书实际连接或前端控件。

Work.completed仍按旧Completion/Result/local-mailbox契约结算，新增用户消息通知的回执独立展示。旧执行和完成条件没有暗改；不能以completed推断新通知已被用户看到，也不能用发送一条进度完成工作。将来真实渠道需要把目标交付等级显式建入新契约，并保持旧快照兼容。

## 独立运行与后续OpenCraft接入

```bash
node bin/assistant.mjs attachment-import --profile ./profiles/local --file ./report.pdf
node bin/assistant.mjs attachments --profile ./profiles/local
node bin/assistant.mjs message-send --profile ./profiles/local --message '{"type":"text","content":"你好"}'
node bin/assistant.mjs messages --profile ./profiles/local
node bin/assistant.mjs message-get --profile ./profiles/local --message-id MESSAGE_ID
node bin/assistant.mjs message-respond --profile ./profiles/local --message-id MESSAGE_ID --revision 1 --value week
node bin/assistant.mjs message-retry --profile ./profiles/local --message-id MESSAGE_ID
```

CLI保留{inputId,result}；附件导入返回{result}。本地owner标签不是平台身份认证。

OpenCraft内置时，原生消息接口实现transport，将稳定messageId映射原生消息身份；渲染body的文字、附件和Interaction卡片，回调原Interaction安全接口。须同时明确Actor/Thread/目标账户绑定、幂等与未知效果对账、原文/消息权威归属，采用Worker/独立进程异步存储端口；不能直接把本lab同步SQLite和文件I/O放进Join网络主线程。

外部IM同样要新增真实目的地授权绑定及transport，不是让模型随便填channel。本轮没有安装外部SDK、借用共享凭据或发送真实外部消息。

## 参考与验证

参考固定的非官方Grokbot0.18恢复源码`a9f633e09d49a85829b8236331b9e21f7e612634`中的`source/host/runner/tools/send-message-tool.ts`及send-message-schema.ts：显式可见消息、附件/引用/问题/安全请求，以及ack不等于delivery。这里只说明本机可检查机制，不宣称官方线上行为完整复现。

实际验证及保留失败见[0020记录](iterations/0020-user-messages.md)。新专项含原文/outbox原子性、选择/安全输入、真实Pi同submission、真实CLI、最终附件不绕Completion、通知不丢文件、慢transport时控制连接可用、有限重试不饿死、旧revision撤回、schema16不重发历史和真实进程写文件/回执窗口。真实模型表达/选项选择质量、平台UI和外部渠道未验收。
