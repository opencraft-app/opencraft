# DeepSeek Harness 真实接入 Proposal

**状态：** npm-only 六插件方案已通过本地验证与用户授权 Ubuntu 24.04 主机的首次安装、同快照重装和服务健康复验；前端已切换 COS 全球加速安装地址，但该对象当前仍是旧 GitHub 四插件脚本，需覆盖最新版后再做北京 Hermes Sandbox 与 TAT 复验。

## 背景与目标

在现有“管理 > 实验室 > DeepSeek Harness”三态演示基础上，接入真实实例状态、幂等安装、重启、实例专属 WebUI 访问和页面内模型供应商配置。配置卡片采用“已配置列表 + 单项展开编辑 + 完整白名单配置区”，支持 API Key 新增、覆盖修改和删除。保存期间锁定配置交互并等待 `debug/exec` 返回，结果通过顶部居中 Toast 即时反馈。DSH 与 Hermes 运行在同一台实例、同一 `agentuser` 环境中，但使用独立版本目录、`DSH_HOME` 和系统级 `deepseek-harness.service`；DSH 依赖不写入 Hermes runtime 包树，安装任务使用固定 pnpm 版本且不修改实例全局 pnpm。

## 范围

- frontend 复用 `BotRepository.execDebugCommand`，经现有 `/v1/instances/:id/debug/exec` 完成状态、安装、任务查询、重启和模型配置。
- 用户点击安装后，前端经 `debug/exec` 下发固定的 `systemd-run` 命令，由实例从 `https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh` 下载完整单文件安装器并执行；依赖快照由脚本在实例内从 npm 解析，不依赖镜像预置安装器或前端安装 payload。
- 实时脚本在任务开始时从 npm 解析 DSH、SkillHub、QQBot、微信、企业微信、Lark 和钉钉的 `latest` 元数据，将精确版本与 integrity 固化为本次安装快照；SkillHub 与五个渠道插件全部验证成功后才允许任务完成。
- 模型供应商 helper 同样以内联脚本经 `debug/exec` 实时执行，不依赖实例预置文件。
- Provider helper 在实例回环访问 DSH 固定 RPC；WebUI 按当前 `botId` 跳转实例专属域名，国内站使用 `https://${botId}.dsh.lightvela.tech`，国际站使用 `https://${botId}.dsh.lightvela.site`。
- 国内站和国际站使用已确认的不同 Provider 白名单；DeepSeek 产品标识映射到 `deepseek-official`。
- 配置下拉始终展示当前站点完整 Provider 白名单；重复保存已配置 Provider 等价于覆盖更新。
- 首批真实安装只进入北京 Sandbox；本需求不新增 service-gateway 路由。

## 非目标

- 不提供具体 model ID 选择、自定义 Provider、Base URL、协议或模型参数。
- 不公开实例 3080，不复用参考机的公网 IP/路径配置。
- 不把 API Key 明文写入 shell、URL、日志、埋点、localStorage 或后端业务数据库；实例通过首个 `debug/exec` 命令生成一次性 RSA 密钥，浏览器使用 RSA-OAEP 加密后，第二个命令只携带密文并在实例内经 stdin 解密。
- 不新增 DeepSeek Harness 专用 ctl、transport、errcode 或 service-gateway 接口。
- 不安装 `dsh-auth`、实例内 Caddy 或另一套 SkillHub CLI；WebUI 域名的代理与鉴权由独立基础设施承接，Hermes 已有工具和渠道插件保持不变。
- 本轮不改为镜像内离线预置，也不新增离线 runtime bundle；COS 只托管可独立运行的最新单文件安装器。

## 关键决策

- DSH、SkillHub 与五个渠道插件均请求 npm `@latest`；每次任务先解析并校验 `version`、`dist.integrity` 和 HTTPS tarball，再以本次解析出的精确版本生成 package/lockfile，安装过程中不再次跟随 `latest`。
- DSH runtime 与 `web` profile 分别先生成 lockfile、再执行 `--frozen-lockfile` 安装；固定 `pnpm@10.33.0` 在候选阶段引导并于校验后持久化到 root-owned tooling，不替换实例全局 pnpm。LightVela 管理的六个 profile 插件均来自 npm registry，基础安装不依赖 GitHub；每个托管包的 registry integrity 均必须出现在对应 lockfile 中。
- 安装在 root-owned 任务目录完成下载、依赖安装和配置组合检查后再原子切换；已有 profile 的可变内容仅以 `agentuser` 身份复制，控制文件使用 no-follow 读取和原子重建；任一插件失败即恢复旧 runtime、完整旧 `web` profile 和旧 service unit。
- 已安装 profile 中由 SkillHub 管理的额外 DSH 插件，在依赖、bundle patch、workspace build policy 和编译产物通过校验后随 profile 保留。安装器迁移删除旧 Web profile 的 `pnpm.onlyBuiltDependencies`，避免与 SkillHub 在 pnpm 10.33 写入的 build policy 冲突；完整 profile 在停服后再次校验指纹，并发变化时不切换。
- 包名、版本、目录、用户、端口和 Provider 白名单由实例侧 helper 固定；前端只选择固定动作与白名单 Provider ID。
- API Key 使用实例一次性 RSA-4096 公钥与 RSA-OAEP/SHA-256 加密，密文经 `debug/exec` 传输，在实例内解密到 helper stdin 后由 DSH `credentials.set` 单向写入；一次性私钥在命令退出时删除，设置写入携带 `expectedRevision`。
- 删除经同一 `debug/exec` 通道调用固定 `remove-provider` 动作；只清理可确认由 LightVela 创建且当前可写的凭据，环境变量密钥和自定义引用保持不变。
- WebUI 链接直接由现有 `botId` 生成，不新增 URL 查询接口：国内站 `https://${botId}.dsh.lightvela.tech`，国际站 `https://${botId}.dsh.lightvela.site`。

---

# Agent 人设 Markdown 上传 Proposal

**状态：** 产品范围与交互已由用户确认，待按实施计划开发与验收。

## 背景

当前 Agent 人设页只能从平台推荐的人设中抽取、预览并注入。已有自己人设文档的用户无法直接复用，需要把内容手动改写成平台预设，路径长且容易丢失原始表达。

本需求在国内站现有 Agent 的人设页增加“上传人设文件”入口。用户选择本地 Markdown 文件后，先在浏览器中完成技术校验、预览和编辑，再通过现有 Hermes 调试执行通道安全写入该 Agent 的 `SOUL.md`。

## 目标

1. 支持已有 Agent 上传、预览、编辑并注入不超过 20 KB 的 UTF-8 `.md` 人设。
2. 对会导致写入失败或内容不可用的问题做硬拦截，对结构不完整只提示、不阻止。
3. 覆盖已有 `SOUL.md` 前明确确认并自动备份，写入过程采用临时文件加原子替换。
4. 注入后展示“已注入：自定义人设 · <名称>”，刷新页面后仍可从真实 `SOUL.md` 恢复状态。
5. 仅在国内站开放，不改变国际站和现有推荐人设流程。

## 范围

### 本次包含

- 国内站 `/agents/persona/` 的“上传人设文件”入口。
- 本地 `.md` 文件选择、严格 UTF-8 解码、20 KB 字节限制、空内容和二进制控制字符检查。
- 可编辑预览、实时字节计数、硬错误和软结构提示。
- 从 `Name:` 读取展示名；缺失时使用文件名，并在写入内容中补齐标准元数据。
- 已有人设时的覆盖确认、旧文件备份、原子写入。
- 写入成功后的自定义人设状态、刷新恢复及 `/new` 提示。
- 单元、组件、区域隔离、i18n 和浏览器冒烟验证。

### 本次不包含

- 新建 Agent 流程中的上传入口。
- `.txt`、`.docx`、PDF、压缩包或多文件上传。
- 原始上传文件的独立存储、版本管理、云端素材库或跨 Agent 复用。
- 用固定字段模板强制拦截任意合法 Markdown。
- 为自定义人设生成抽卡卡片。
- 国际站开放或后端新增上传 API。

## 方案比较

### 方案 A：新增后端上传与存储接口

- 优点：可集中存档、审计并扩展素材库。
- 缺点：超出“不单独保存原文件”的范围，涉及存储生命周期和新 API，成本与风险均偏高。

### 方案 B：浏览器读取后复用现有 Hermes 注入链路（采用）

- 优点：与现有推荐人设写入路径一致，不新增服务依赖；文件内容只在当前浏览器和目标 Agent 间流转。
- 代价：需要在前端实现严格文件校验，并增强现有 Shell 写入的原子性与状态读取。

### 方案 C：只提供文本框粘贴

- 优点：实现最轻。
- 缺点：不符合用户“上传人设文件”的入口心智，也无法对文件类型、编码和原始文件名做准确校验。

## 主要技术方案

1. 新增纯函数模块，集中处理字节限制、严格 UTF-8 解码、控制字符检查、名称解析、结构提示和标准化输出。
2. 新增独立上传弹窗组件，复用项目 Radix Dialog；文件内容留在组件内存，失败时保留编辑内容。
3. 写入前将最终 Markdown 编码为 base64，复用 `BotRepository.execDebugCommand`；不新增接口。
4. 写命令先备份现有 `SOUL.md`，解码到同目录临时文件，校验非空后使用 `mv` 原子替换，并用 `trap` 清理残留。
5. 读取命令只返回 `Exists`、`Slug`、`Name` 三项身份信息，不回传完整人设内容；固定内部 slug 标识自定义上传。
6. `BuddyPanel` 分别维护推荐人设 slug 与自定义名称；自定义状态不占用抽卡卡片，切换 Agent 时丢弃过期异步结果。

## 依赖与边界

- 复用现有 `Dialog`、`BotRepository`、Hermes 人设命令与 i18n 体系。
- 不新增 npm 依赖，不依赖未实现的后端能力或设计稿。
- 20 KB 按 UTF-8 实际字节计算；浏览器在选择文件、编辑后以及补入固定 Soul 元数据后三个时点都校验，确保最终写入文件仍不超限。
- `SOUL.md` 可以是任意有效 Markdown。缺少 `Name`、身份、语气或边界章节只给出软提示。

## 影响文件

| 路径 | 影响 |
| --- | --- |
| `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md` | 用户已确认的完整 PRD。 |
| `frontend/src/pages/marketing/agent-persona-upload.ts` | 文件校验、名称解析、结构提示和 Markdown 标准化。 |
| `frontend/src/pages/marketing/agent-persona-upload-modal.tsx` | 上传入口、预览编辑、提示、覆盖确认和注入状态。 |
| `frontend/src/pages/marketing/agent-buddy-command.ts` | 原子写入、身份读取及解析。 |
| `frontend/src/pages/marketing/agent-buddy-panel.tsx` | 国内站入口与自定义已注入状态接入。 |
| `frontend/src/pages/marketing/__tests__/*persona* / agent-buddy-*.test.*` | 校验、命令和交互回归。 |
| `frontend/src/i18n/generated/*` | 新增界面文案翻译。 |
| `frontend/openspec/*` | 本次提案、规格与实施计划。 |

## 用户验收标准

1. 国内站已有 Agent 的人设页显示“上传人设文件”，国际站不显示。
2. 文件选择器只声明接受 `.md`；伪装扩展名、超过 20 KB、无效 UTF-8、空内容或包含禁止控制字符时不可注入，并显示明确原因。
3. 合法 Markdown 可进入预览编辑；编辑后字节数实时更新，超限或清空后不可注入。
4. 缺少标准结构时显示可理解的改进提示，但用户仍可继续注入。
5. 已有 `SOUL.md` 时先出现覆盖确认，确认后旧内容进入备份目录。
6. 写入采用临时文件加原子替换；失败不破坏原文件，界面保留编辑内容并允许重试。
7. 成功后页面显示“已注入：自定义人设 · <Name 或文件名>”，刷新后仍能恢复。
8. 自定义人设不生成抽卡卡片；现有抽取、测试、推荐人设注入和删除行为保持不变。
9. 注入成功后继续提示用户在聊天中发送 `/new`。
10. 定向测试、`pnpm check`、i18n 检查、国内站构建和浏览器冒烟通过。
