## stage
页面拆分及双站文档文字、截图完成本地验证；用户已授权提交 MR，进入交付阶段，不合并或发布。

## verified
- 基线 origin/master 4debe57e1，独立 worktree lightvela-account-plans-billing。
- /agents 账号入口沿用 variant=sidebar，底部向上弹出两个页面链接。
- check、双站 build、聚焦测试与文档/change-impact 检查通过。
- 本地端口 5176 已从旧工作区切换至新 worktree，NEXT_PUBLIC_AUTH_API_BASE_URL=mock。

## unverified
- 真实登录与支付服务端流程、线上发布时间，不由本次 mock 预览证明。
- 现网 lightvela.com/account 仍为合并布局；本次截图经用户确认使用本地新版演示状态，不代表生产版本或真实订阅状态。

## discard
- c42acf642 旧分支布局及旧工作区预览，不再作为本任务基线。

## restore
- 新工作区 /Users/pablozhong/codex/lightvela-account-plans-billing；原工作区所有未提交内容保留。
- CN dev server 5176、global dev server 5177；routes /agents/、/account/、/account/billing/、/docs/account/（国内）、/docs/plans/。
- 临时构建缓存使用被忽略的 .next/docs-cn 与 .next/docs-global，避免 Tailwind 扫描独立未忽略目录。

## next_action
- 提交、推送并创建指向 master 的 MR，回查远端 SHA、合并性与 CI；合并或发布仍需另行明确授权。

## docs_verified
- 10 篇 Markdown 已更新，国内 4 篇、国际套餐 6 种源语言；slug 与注册表未改。
- docs:sync 同步 534 篇产物；docs-last-updated 与 international-docs-parity 两文件共 64 项测试通过。
- 截图之前逐条检查 76 处本地引用，0 死链（未去重）；新增图片均已生成，docs:sync 成功解析并复制。
- pnpm check 通过，0 new TypeScript diagnostics；同时修正本任务测试中不受 Testing Library 支持的 exact 参数，账号页 32 项测试通过。
- 用户已回复“可以”批准本地演示数据截图；替换国内账号/实名 4 张旧图，新增国内套餐、国际账号与套餐中英文 5 张图。截图没有真实身份、支付信息、浏览器外框或调试面板。
- 浏览器已确认国内 /docs/account/ 显示新版账号图及演示说明，/docs/plans/ 引用新套餐图；国际 /docs/plans/ 正常显示 Account 与 Plans & billing 英文配图。
- 生成物核对：en-us/id-id/es/ja-jp/ko-kr 使用 -en 图片，zh-sg/zh-hant 使用中文图片。实际截图为未订阅/未绑卡状态，文案已说明。
- 截图更新后重跑 docs:sync（534 篇）、64 项文档测试与 pnpm check 全部通过；172 current / 276 baseline / 0 new TypeScript diagnostics。未重跑全量双站构建，前述 build 证据属于产品拆分阶段。
- A 档工具文档保留摘要，新增入口前置、步骤、结果确认与失败提示；仅国内文档包含实名认证，支付卡说明仅写国际站。
- 价格、套餐规则和无关文档历史差异保持原样，不宣称已发布。
- MR 交付前刷新 origin/master，无基线漂移；工蜂鉴权成功，同源分支无 opened MR；重跑账号/菜单/文档 6 个测试文件共 128 项通过。
