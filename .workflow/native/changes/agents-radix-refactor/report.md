# Agents Radix 重构验证报告

状态：本轮约定范围的实现、本地验证与独立审查通过，等待用户验收。未提交、推送、创建MR、归档或发布。

分支：`frontsandbox/agents-radix-refactor`；基线：`08b9cf56804cc4f4080284bc3680322094c4f54c`。

## 实施范围

- 完成 Agents 控制台、模型、通道、诊断、高级设置、Skills/Experts/Packages、人设、记忆、定时任务、文件、网站、DSH 与 Chat 外围展示迁移。
- 用户明确排除成就，暂缓浏览器、终端、Workbench 及 session 别名；没有修改这些页面的生产或测试文件。
- 保留 Next.js / React 框架；用 Radix/shadcn 控件处理弹层、选择、开关、菜单和焦点。展示层消费 typed props/actions，原宿主/controller 继续拥有 Repository、身份、请求、草稿、取消与资源生命周期。
- SDK 内部、共享 core、账户/传输实现保持原状。OpenCraft 仅补本次共享组件的标准生成、依赖、宿主主题/Portal，以及诊断现有 stream 转发。
- 具体公开接口、请求所有权及窄兼容修复见[模块边界](../../../../frontend/openspec/changes/2026-09-16-agents-radix-boundaries.md)，逐批证据见[Task Pack](../../../../docs/context/tasks/2026-09-16-agents-radix-refactor.md)。

## 最终工程证据

| 检查 | 实际命令/范围 | 结果 |
| --- | --- | --- |
| 国内站合并定向测试 | CN 环境，当前修改/新增测试与 core、路由、SDK、模型/文件工具、公开账户菜单相邻测试；`pnpm exec vitest run <60 files> --maxWorkers=2 --reporter=dot` | exit0；60文件992项，168.89s |
| 国际站合并定向测试 | global 环境同范围，排除旧定时任务主测试文件 | exit0；59文件781项，142.48s |
| 国际站定时任务新增交互 | `pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts -t 'automation Radix interaction boundaries\|keeps the create button in the header when there is no task' --maxWorkers=1 --reporter=dot` | exit0；15通过、196未选中，10.54s |
| 前端质量检查 | `cd frontend && pnpm check` | exit0；170 current / 276 baseline / 0 new / 106 resolved；翻译0错误、47既有警告 |
| 国内站构建 | `cd frontend && pnpm build:cn` | exit0；103静态页、188格式化HTML、8公开SEO路由检查 |
| 国际站构建 | 清理本任务`.next`后 `pnpm build:global` | exit0；649静态页、1276格式化HTML、42公开SEO路由检查 |
| 下游干净安装 | `cd opencraft && npm ci --ignore-scripts --no-audit --no-fund --cache <独立临时cache>` | exit0；1298包，锁文件未被安装改写 |
| 下游定向回归 | `node --import tsx --test --test-concurrency=1` 执行 `lightvela-account-service`、`lightvela-hermes-plugin`、`lightvela-management-policy`、`lightvela-radix-adapter`、`lightvela-radix-dependencies`、`lightvela-diagnostics-stream-adapter`、`lightvela-generated-controls` 七个`.test.ts`文件 | exit0；104/104，5.38s |
| 生成一致性 | `cd opencraft && node scripts/sync-mono2-agent-console.mjs --check` | exit0；154文件；独立审查另核对纯生成输出、manifest与资产逐字一致且可重复 |
| 完整跨包检查 | `cd opencraft && npm run gate` | 最终exit0；平台边界、全workspace类型、各测试组累计1273/1273（0跳过），Web/Expo Web/iOS JS构建通过 |
| 依赖与边界 | 有界AST图 + Node实际包解析 | 275源码/952边/30新增展示文件；指定循环、反向依赖、未解析本地路径为空；两workspace分别保持相同scope/layer实际路径 |
| 文档与差异 | 文档验证、实际变更影响检查、`git diff --check` | 当前均通过；正式设计命中Agent runtime，最终仍需maintainers/用户验收 |

完整测试命令清单与终端日志在本机 `.workflow/runtime/agents-final-*`；文件名为本次恢复入口，日志不进入正式源码。测试使用明确外部边界替身，没有用无断言用例或跳过本次新增交互达成通过。

### 安装环境失败与恢复

首次完整 gate 在 AppServer 组出现150通过/1失败，失败用例为 `local-agent-host.test.ts` 的进程 RPC 重连，错误为 `posix_spawnp failed`。原生依赖独立 `/bin/sh` + `printf` 最小复现同样失败；实际加载的本任务 `node-pty/prebuilds/darwin-arm64/spawn-helper` 模式为644。

只对这一可重装的本地依赖文件执行 `chmod u+x` 后，最小spawn退出0、原RPC单例1/1通过。业务源码、测试断言、依赖版本、锁与用户缓存权限均未修改。Native如实记录 verify3 → fail/build4 → verify5，随后重跑完整gate；没有跳过该测试。

第二次gate的AppServer151/151通过，随后DSH组193通过/3个文件加载失败，均为独立 `runtime/dsh/node_modules/@deepseek-ai/dsh-session` 不存在。该运行时有自己的锁文件，不由根workspace安装覆盖。Native记录 verify5 → fail/build6；按已读 `opencraft/docs/fresh-machine-builds.md` 执行 `npm_config_cache=<独立临时cache> npm run prepare:dsh-runtime`，455包安装成功并验证0.1.1-rc.2，exit0。三个原失败文件7/7通过（308.62ms）后回verify7重跑完整gate。只安装并应用仓库既有的本地artifact适配，不改源码/锁/断言或启动真实账户/模型请求。

最终完整gate退出0。12组测试运行累计1273通过：extensions131+56、AppServer151、DSH200、Lab40、Chat366、workbench231、shell16、workspace6、environments24、desktop-login43、web-release9；部分文件被不同脚本重复执行，因此该合计不代表1273个互不重复用例。Web与Expo Web导出完成，iOS3582模块完成JS bundle和22个资产复制。成功日志为 `.workflow/runtime/agents-final-opencraft-gate-complete.log`，前两次失败日志保留。

### 生成资产与锁文件

- OpenCraft新增7项直接依赖和Checkbox/Switch/Tooltip三个包记录；HEAD原有包记录0删除/0修改，唯一既有记录变化为插件自身importer。没有alias/override或把前端旧版本直接复制到OpenCraft。
- 生成原语集中携带Portal作用域，锚点缺失/重复失败关闭；原SkillsDataLayer、地区和Repository接缝成功输出不变。生成目录实际29文件修改/27新增，其余来自原有闭包；不手改UPSTREAM或副本。
- 标准前端构建按更新后的字典重建字体子集：222116→222048字节。HEAD输入内存重建匹配HEAD资产；当前输入重复重建匹配当前资产，仅移除字典已不含的“车/車”，不修改字体脚本或源TTF。
- 前端143个变更/新增源码及package/lock内容指纹在测试与构建后保持 `f26300a006024239e5cd84cecc8969d790191aa80c6c07fbf4c7e4ab530ed878`，字体作为独立生成资产记录。
- OpenCraft共享控件/CSS17文件按upstream目录相对路径计算的指纹仍为 `ee96f30fd8b50797b4ed5ed054400d6636d4634bee399aacaebdd3c09dbd662d`；标准生成check154再次通过。暂缓页面、shared core、frontend Context/Repository与客户端生产文件的最终差异为空；原工作区脏状态保持。

## 实际界面验证

使用已有本地mock Repository或实际生产view加合成数据，样例禁止应用网络请求；已实际截图和测量390、1024、1440宽度。未停留登录页就判为功能通过。

| 范围 | 已验证 |
| --- | --- |
| 控制台与配置 | 移动Sheet单份导航/关闭回焦、侧栏无重叠；模型长名限宽、通道方式/凭据Dialog、诊断Select键盘、设置数值编辑取消；QR加载/失败重试/合成二维码及焦点 |
| Skills/人设/记忆 | 长详情可见初始焦点，Checkbox键盘多选；人设问卷前后切换保留答案，删除/复制SOUL显示回归修复；记忆字段即时聚焦、Esc回编辑、手机无横溢出 |
| 定时任务/文件/网站 | 命名Dialog、Tab圈定、菜单→详情焦点交接、Skill/Upstream嵌套Portal、时间草稿取消；文件行内编辑回焦/隐藏Switch/单选；网站复制fallback两次完整DOM选区、清理与单次reset |
| DSH/Chat | DSH长选择值390无横溢出，修复/删除初始Cancel与Esc返回；Chat1440/1024文档高度等于视口、无Footer，手机长错误可见，合成SDK更新保持同mount/首次API引用 |
| OpenCraft共享控件 | 真实ModalSurface+宿主SCSS/CSS+生成原语；1280深浅色，Dialog240/241、Alert245/246、浮层250；逐级Esc回焦、Tab圈定、菜单单glyph、Switch16px位移、Tabs状态；390确认框358×210、文档390/390 |

网站复制fallback临时textarea必须位于显式Dialog DOM范围内；DSH长值必须让SelectValue真实flex子项承担min-width和ellipsis；这些由真实浏览器对照发现的回归均已窄修并独立复审关闭。没有通过关闭焦点限制、隐藏整个页面溢出或重挂SDK掩盖问题。

## 独立审查

B1至B5各片均已独立审查放行。B6独立27/27通过，核对154文件生成、公开接缝、锁/解析、CSS角色与诊断stream，无P1/P2阻断。审查者未修改实现、生成物、文档或Git状态。

## 交付预览

[国内站本地mock预览](http://127.0.0.1:5188/agents/automations/)已恢复并保留；启动参数限定127.0.0.1，使用既有local-preview-auth和mock Repository，不访问真实账户。清理的只有本任务可重建`.next`缓存。

恢复后实际页面展示定时任务及模板；打开新建Dialog初始焦点在标题，Esc关闭后返回新建按钮，未提交表单。新标签首次导航等待Next冷编译超时，编译完成后直接检查同一标签成功，没有绕过错误/安全页面。临时尺寸覆盖已reset。

## 验证限制与保留事项

- 国际站旧定时任务主集存在75个与HEAD同名失败；对照仅将四份HEAD源以内存形式代入，其他共享依赖仍当前，不是完整clean-HEAD测试。保留旧fixture，不改变产品locale来通过测试；本轮新增14项交互与旧header单例已真实global通过。
- `pnpm check`按项目类型基线检查，没有声称原始TypeScript零诊断。模拟测试含翻译字典/未初始化i18next告警，构建含既有MDX弃用提示，Node测试含SQLite/MockTimers实验性提示。
- OpenCraft构建保留大chunk、静态/动态混合import及NO_COLOR/FORCE_COLOR提示；未通过修改检查器、关闭检查或扩大打包重构来消除告警。
- 本地模拟和SDK替身不能证明真实登录账户、模型调用、WebSocket消息发送、安装/重启/删除、文件上传下载、发布网站或系统剪贴板写入成功。本轮没有执行这些真实写操作。
- Web/Expo构建不等于原生Electron/iOS实机验收；未打包、签名、发布或运行真实云端操作。
- 排除/暂缓页面不计未完成实施项。正式设计Owner批准、用户验收及任何commit/push/MR/归档均留在确认点。
