# 文件资料、产物、投递与变化源

继承[适配层规则](../AGENTS.md)。DirectoryKnowledgeSource只读明确绑定的资料根；LocalArtifactStore发布不可变笔记；LocalMailboxDelivery核对稳定delivery落盘；FileEventSource轮询显式路径。

资料限制相对路径、格式、64KiB、符号链接及Linux实际fd路径，不增加任意根或Shell。ZIP/IPYNB不在本任务范围，禁止引入WorkBuddy文档SDK。资料正文是数据，不是授权。

发布/投递沿稳定身份核对已有字节，重试不能覆盖不同内容。文件写入与SQLite不能伪装成同一原子事务，须保留崩溃窗口的恢复/对账。mailbox接受只代表本地文件落盘，不是IM投递或用户已读。

观察基线归EventTriggerService，不保存在adapter另一份状态里；首次观察仅建基线，变化/删除上报稳定发生身份。轮询可能漏过短暂变化，不能宣称无遗漏订阅。文件读错误不能当作无变化或成功。

验证：`node --test test/ownership.test.mjs test/reception-queries.test.mjs test/event-notifications.test.mjs test/runner.test.mjs`，重点穿越/换根/符号链接、原字节、投递和观察重启。

0.15 LocalAttachmentStore保存profile/attachments不可变manifest/blob：CLI显式选文件或真实publish_note注册，单文件8MiB，ID绑定名称/声明MIME/字节哈希/大小；无模型路径或URL导入。O_NOFOLLOW/regular-file/尺寸与发送时哈希校验；元信息声明MIME不等于检测内容。LocalMessageDelivery复制到outgoing/assets并持久JSON，再返回accepted回执；该回执仅本地落盘。稳定身份EEXIST核对字节，真实进程退出后复用。不做预览/转换或ZIP/IPYNB目录功能。同步I/O仅lab；平台接入须Worker/独立进程。
