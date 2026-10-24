# 实施日志

- 2026-09-17：开始阶段 A。保留既有冷恢复修复与其他 dirty 文件；无生产/账号操作。
- 已完成 DSH/Hermes 入口对照；正在构建真实 Engine 负例。
- 真实 DSH 负例已失败：本机安装完成后旧 Session 的模型请求没有新 Skill 目录。
- 修复中：引擎私有装配模块与 Host 待刷新协调已写；typecheck 通过。首次 agent/created 装配导致 thread/start 的私有桥 400，正在读取合成测试的具体错误，不修改用户实例。
- 注入错误已定位为 Agent core ctx 未声明 skills；改用继承插件依赖的原生 scope。第二个 rank 负例证实子作用域覆盖错误，改用 standing preset 同层并引用计数，已通过。
- 真实 smoke 已验证安装、原生 Skill 工具读取、卸载、外部目录新建、同 Turn 下一步骤、rank/cwd、fork、冷恢复及显式打包模块闭包。
- `test:dsh-bridge` 224/224；Hermes/Workbench/刷新聚焦回归 23/23；Local Host typecheck 与 check:boundaries 通过。只有 loopback 合成模型，无真实凭据、云资源或付费推理。
- 最终 smoke（按 Electron extraResources 复制模块）：双客户端收到 mutation 后的 skills/changed；同 Turn 自动继续、rank/cwd、fork 和冷重启全部通过。
- 文档校验通过；11 个局部文档链接有效；git diff --check 通过。影响检查按显式本轮源码路径通过，要求后续 Owner review；--staged 暂存集为空，不作为源码验收替代。
- 未完成：签名/运行中的桌面窗口验收，扫描故障、压缩、漏通知/乱序及大目录专项；Hermes 原生热更新、正文更新和 Connector 下一阶段。未提交。
- Daemon bundle 构建与 typecheck 通过；没有启动或替换用户正在运行的 Daemon/桌面应用。

## 范围收敛与收尾（后续决定覆盖上面的历史计划）

- 用户已取消正文版本更新、Hermes 自动热刷新；不再等待可写 Hermes 仓库，不修改 Hermes 引擎。
- 新增外部 DSH 安装→继续聊天负例，修复前失败于 refresh bridge unavailable，修复后通过。unsupported 不进入 pending；真正的暂时失败继续重试。
- 为桌面 QA 接通 `OPENCRAFT_SKILLS_DIRECTORY` → Daemon 参数 → Local Host，默认用户路径不变。
- 实际 Electron 暴露 pre-start Skills 订阅异常。新增同序列负例并修复为 Runtime-owned listeners；21 项 Workbench 回归通过。
- 首次隔离路径超过 macOS Unix socket 长度上限，fixture 改用短 /tmp 根；不是通过删除用户 socket 或凭据恢复。
- agent-browser 全局命令不可用，通过 npm exec 获取工具；多个同名 Electron 源码实例下输入未可靠触发模型请求。没有把“目录可见”误报为“模型已读正文”，改用独立身份的打包预览验收。
- 225 项 DSH 回归通过；源码 Electron 构建通过，仍有既有 chunk-size/dynamic-import 构建警告。打包预览输出新目录，保留旧包与正式安装。
- arm64 `OpenCraft Preview.app` 已构建；buildId `20260917143650-561e4640adaf`，ad-hoc hardened runtime，deep/strict 签名验证通过。未公证、未安装、未发布。
- 打包桌面验收通过：初始会话 → 真实 AppHost `skills/install` → 界面原会话发送 → 原生 `skill` 返回正文。模型证据 `catalogSeen=true / bodySeen=true`，会话比较 `sameThread=true / threadCount=1`，可见正文标记与截图一致。
- 自动化环境：后台 Electron 的 document.hidden 使输入不可靠；保留真实 Main/Preload/Daemon/DSH，使用 CDP focus emulation 后正常发送。未模拟产品 RPC 结果、未复制用户凭据；市场下载和人工键盘不在此项验收范围。
- 文档校验命令首次使用不支持的 markdown 格式，改为 text 后通过；无源码副作用。
- 最终 225 项 DSH、21 项 Workbench、4 项 Electron 启动回归通过；四个受影响 workspace 的类型检查、边界检查、文档与显式变更影响检查通过。
- 验收结束已关闭本次创建的预览/合成模型服务；精确进程检查未发现这些隔离根的残留进程。保留预览包和验收截图，没有覆盖 /Applications、旧包或用户数据，未提交/推送。
