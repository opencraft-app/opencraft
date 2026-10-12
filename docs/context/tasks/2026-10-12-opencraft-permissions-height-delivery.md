# OpenCraft 权限中文化、宽屏输入框与中文 Markdown

## goal
对话框权限配置在中文界面显示中文；宽屏编辑区默认加高。

## non_goals
不修改权限策略、引擎 profile ID、发送链路、用户身份投影或生产环境。

## requirements
用户请求：权限配置改成中文；宽屏默认高度调高；随后授权提交、推送、合入 master。

## implementation
权限入口、标准模式名称/中文说明、引擎分组与加载/错误/待生效提示使用现有 FormatJS 语言包；自定义引擎配置保留原名和说明。输入框容器 >=768px 时默认编辑区从26px变为52px，窄容器保留原尺寸。

## context_receipt
根/OpenCraft AGENTS、维护 Skill、自托管预览 Skill、agent-gateway-runtime、site-environment-routing、upstream-subtrees、service-opencraft、chat-ui-architecture、design README/invariants、i18n 邻接与检查脚本/测试。

## history_context
交付分支从缓存 master 1a75b3205 建立；仅应用本轮 UI 差异，排除为预览保留的 sender 改动。

## validation
i18n、受影响 workspace typecheck、权限/i18n 聚焦测试、Web 构建、文档影响与 whitespace 门禁。预览 buildId 20261012-composer-height-preview，页面资源已替换并保留回退；实际菜单显示未验证。

## risks / handoff
初次网络与默认 SSH 身份失败；已恢复网络并使用现有工蜂专用 SSH 身份完成 fetch。

## markdown_followup
截图的 **Capacitor…框架。**官网 与 是***“下载…原生能力”*** 在 Marked 16.4.1（ref/codex package pin）和18.0.11均解析为text。参考链路：shared/shared-bindings-02209.ts、editor/initialize-markdown-parser-02234.ts、features/editor/extract-assistant-markdown-citations.ts；无中文 emphasis override。参考目录只读：mono2-source-main-20261009/ref/codex。
修复保留标准 emStrong 的匹配、嵌套解析与代码mask，仅在原解析失败且出现Han/标点边界时，以同长度mask重试。源文和raw不变；英语、空白边界、转义和代码继续遵循原规则。未扩展处理未闭合 triple delimiter 的现有流式修补。

## verified
38 项权限、i18n 和 ChatDocument 回归通过；i18n 门禁通过；Composer、ChatDocument、Workbench Web typecheck 通过；平台边界/typography 门禁通过；Web production build 通过；文档影响与diff check通过。
真实 Chromium：截图原句两个strong和一个嵌套em、链接目标、中文权限菜单四档、900px容器52px/500px容器26px验证通过；无页面异常。

## checkpoint
stage：交付分支已基于远程 master 核对，提交与MR合并进行中。
verified：上述源码、构建和真实浏览器证据。
unverified：Master 合并尚待远程确认；预览近期有IOA头像更新，后续叠加Markdown修复须保留它。
next_action：提交本轮明确文件、推送并通过工蜂合并后核对master。
