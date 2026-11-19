# 第十一轮：问答、认证、安全输入与人工接管

沿原Interaction/InteractionLedger/InteractionService增加kind、期限和provider元信息，不另建等待任务系统。问答仍用ask_user；request_intervention支持authorization、secret和handoff。Pi工具先提交业务请求，再原生挂起释放worker；恢复后读取原请求结果，沿同一原生submission继续。取消/修改退役旧请求，过期阻塞原工作，不能用过期答案继续。

- question：普通answer，不能借此完成其他类型请求。
- secret：专用通路接收用户文件内容，向核心只提交凭据引用。
- authorization：用户为命名provider提供凭据，核心检查引用类型、provider、当前profile绑定和期限。回执明确owner-provided，不宣称已向远端认证。
- handoff：用户报告自己已做某项外部操作，回执明确owner-reported，不能代替真实工具结果验证。

LocalCredentialVault为本地独立适配器，以AES-256-GCM保存用户提供的值，密钥0600、profile目录0700，AAD绑定assistant/owner/reference，引用30分钟有效。模型/核心只拿describe窄接口，不拿put/read或秘密。秘密值不会写入InputInbox、业务事件、聊天或Picheckpoint；用户自己提供的原文件由用户管理，CLI不删除它。不可恢复丢失的密钥，不把同目录加密视为抵抗已控制本机账号的攻击者。

接待查询包含等待类型和期限；聊天不能将安全输入误路由为普通answer。主历史由host加专用通路提示。CLI从文件读取值后仅发送引用；敏感操作不能用--text，错误回执不回显秘密。

```sh
node bin/assistant.mjs interaction-list --profile DIR
node bin/assistant.mjs provide-secret --profile DIR --interaction ID --revision N --secret-file FILE
node bin/assistant.mjs authorize --profile DIR --interaction ID --revision N --secret-file FILE
node bin/assistant.mjs handoff --profile DIR --interaction ID --revision N --text '已完成所需操作'
node bin/assistant.mjs reject --profile DIR --interaction ID --revision N
```

默认typed等待30分钟，可设1秒..24小时；旧question保持无期限与原回放语义。schema9→10为旧Interaction增字段，不重写旧原生checkpoint。授权和安全输入回执不增加原工具/文件授权；具体OAuth浏览器登录、远程token验证、消费凭据的服务工具尚未接入，不能声称外部认证成功。

interventions.test.mjs覆盖三类Pi真实工具挂起/恢复、请求提交后进程退出与CLI安全输入、类型/provider/owner/期限检查、拒绝普通answer旁路、工作取消/修改/过期、主接待提示，以及业务库/原生记录不含合成秘密值。初轮CLI import放在shebang前导致子进程语法失败、普通answer分型检查漏加，已修复并保留失败日志。
