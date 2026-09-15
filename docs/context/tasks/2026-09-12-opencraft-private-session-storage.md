---
id: opencraft-private-session-storage-2026-09-12
type: task
scope: 移除桌面登录对 macOS Keychain 的依赖，使用应用自有会话存储。
triggers: ["private session storage", "不用钥匙串", "登录状态存储"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-electron/src/private-storage.ts
  - opencraft/apps/workbench-electron/src/lightvela-session-store.ts
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
应用自己持久化会话 token 与站点，不调用 OS Keychain，不出现 Safe Storage 授权弹窗。

## non_goals
- 不存账号密码，不实现密码管理器，不操作系统钥匙串中的条目。
- 不复制/解密旧凭据，不提交、推送或部署，不代用户真实登录。

## requirement_ids / requirement_refs / requirement_excerpt
- STORAGE-01：用户明确不要 mac 钥匙串，要求自己抽象存储；已告知降低本地隔离能力、需要重新登录，用户答复“没关系”。
- STORAGE-02：仅需持久化恢复登录状态所需会话凭据与区域。

## interface_refs / data_structure_refs
- PrivateStorage read/write/remove 是主进程内部接口，不暴露任意文件访问给 renderer。
- 文件内容 version=1 与 session(region, token)；支持未来替换存储后端。
- DesktopSessionStore 保留异步 read/save 与同步 clear、generation/abort 防护。

## history_context
- current_design_refs：platform-architecture 桌面账户恢复边界。
- relevant_evolution：旧 safeStorage decrypt/encrypt 会触发 macOS Safe Storage 授权；登录入口也预检 OS 加密可用性。
- superseded_refs：EncryptionPort 与 lightvela-account.encrypted 自动读取。

## acceptance
- 登录入口和恢复路径没有 safeStorage/keytar 调用。
- 私有目录0700/文件0600、原子替换、受限键名、禁止符号链接读取。
- 新进程存储实例可恢复 region/token；注销、取消、坏文件测试通过。
- 有旧 encrypted 文件的启动不会读取或解密它；用户重新登录。

## affected_paths
- workbench-electron 私有存储、会话适配、main 登录入口与相关测试。

## required_context
- router 无匹配，采用目标目录 bounded exact search。

## context_receipt
- docs/context/domains/identity-access.md：继续核对时 router 命中；保留服务端会话验证权，不以本地存储内容代替授权。
- opencraft/AGENTS.md：workspace 与发布边界。
- lightvela-session-store.ts / main.ts：Keychain 的两个实际入口。
- desktop-lightvela-login.test.ts：取消/退出/权限兼容契约。

## decisions
- 采用权限保护的明文 JSON，明确不声称加密或抵御同账户进程。
- 旧密文启动时忽略，显式退出时删除旧本地文件，不访问系统钥匙串。

## risks
- 同账户恶意进程或获得文件副本的人可读取会话；这是已告知并接受的权衡。
- macOS/Linux 的0700/0600约束不等同于 Windows ACL。

## validation
- 桌面登录测试、类型检查、完整应用 gate、独立预览启动。

## evidence
- 29 项桌面登录相关测试通过，包括私有文件读写/区域恢复、清除、取消、损坏与 legacy 兼容及无 OS 凭据 API 依赖。
- 后续串联验证增加双区域原生回调→私有文件→新存储实例恢复→认证请求→退出清理及存储失败场景；当前31项通过。失败通知只含通用错误，不带出会话内容。
- 双区域各启动一个独立 Node 进程读取持久化文件，确认不是同进程缓存命中；只输出恢复成功与区域，不输出 token。继续核对后的应用 gate 退出0。
- 完整应用 gate、Electron 类型检查、独立 macOS 构建与签名检查通过。
- 新包使用含旧 encrypted 测试文件的隔离配置启动；readSession 返回 null，测得0ms，显示 Sign in；旧文件保留、新存储没有凭空创建会话。真实用户未代登录。
- 后续重新打开无钥匙串预览并停在站点选择/登录窗口；当前没有真实会话，等待用户主动登录后再做真实账号恢复验收。

## scan_scope
- apps/workbench-electron/src 与 desktop-lightvela-login.test.ts。

## scan_output
- 两处 safeStorage 使用均已移除；旧密文不读取、不迁移。

## handoff
- 已完成；无钥匙串独立预览位于 release/storage-preview 并已打开，需用户重新登录一次。未提交、推送或发布。

## stage
完成。

## verified
- 模拟会话存取、权限、清除与取消测试通过；没有保存真实用户凭据作为测试数据。

## unverified
- 真实系统浏览器登录仍由用户主动执行；没有代用户输入凭据或操作钥匙串提示。

## discard
- 不引入密码保管服务或应用自制密钥系统。

## restore
- 所有新会话数据只在 userData/private-storage；代码不输出值。

## next_action
- 用户使用新预览重新登录；旧窗口中已经出现的提示可拒绝后退出旧版本。
