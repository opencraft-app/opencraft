## goal
把 Agent 创建流程中的玩偶形象换为与首页七个 3D 玩偶一致的柔和立体质感。

## non_goals
- 不改创建弹窗布局、步骤顺序、名字与用途字段、持久化接口或部署。

## requirement_ids / requirement_refs / requirement_excerpt
- 本聊天 2026-10-08 用户要求：试玩页创建完成的形象参照七个玩偶图；保留现有格式；复用仓库模板；参考图无人戴皇冠。

## interface_refs / data_structure_refs
- `HermesAppearance` v1 及 `HermesAppearanceAvatar`；已有保存记录必须仍可解析。

## history_context
- `current_design_refs`: `frontend/DESIGN.md` 与 `docs/context/tasks/2026-10-02-agent-dressup-preview.md`。
- `relevant_evolution`: 当前 2D doodle 形象已经贯通创建、侧栏与本地保存；首页有七个 3D 单体图和原始无配饰七角色源图。

## acceptance
- 试玩页的创建、完成、侧栏头像显示同一套 3D 形象；形状/颜色/配饰选择能即时反映；默认无皇冠。
- `pnpm check`、聚焦测试及前端构建通过；桌面和手机浏览器核对。

## affected_paths
- `frontend/src/components/site/hermes-doodle-avatar.tsx`
- `frontend/src/pages/marketing/agent-dressup-studio.tsx`
- `frontend/src/lib/hermes-appearance.ts`
- `frontend/public/assets/mascot-dressup/plush/`
- 相邻测试。

## required_context
- 路由 `frontend dressup preview created mascot result visual assets` 无匹配 Pack。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端边界 | 资产格式与验收命令 |
| `frontend/DESIGN.md` | 设计规范 | 保留原弹窗与交互 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 核查相邻测试与语言 |
| `docs/context/tasks/2026-10-02-agent-dressup-preview.md` | 历史实现 | 保留外观数据链路 |
| `frontend/public/lightvela-intl-home/assets/peek-friends/manifest.json` | 素材来源 | 复用七个角色家族 |

## evidence
- 2026-10-08 当前手机预览截图：创建完成是平面浅紫云朵，与用户七角色图的材质差异明显。

## risks
- 自动配色影响天线球；头像 32px 下配件会简化；浏览器视觉复核。

## validation
- 待执行。

## decisions
- 优先复用现有角色与真实配饰；不采用新生成的红黄皇冠。

## scan_scope
- `frontend/src/pages/marketing/agent-dressup-*`、`frontend/src/components/site/hermes-*`、`frontend/public/lightvela-intl-home/assets/peek-friends/`、`frontend/public/assets/mascot-dressup/`。

## scan_output
- 精确搜索找到上述代码与 3D 图，扩展搜索定位原始无配饰七角色源图。

## handoff
- 实现中；未提交、推送或发布。

## checkpoint_2026_10_08_front_bases
- 用户确认粉色正脸无配饰图作为形状/颜色选择后的底模，并要求其余形状一致。
- 新增 `plush/front-{round,bean,square,drop,cloud}.webp`，512px 透明 WebP；源图为本聊天生成图，粉色基准 `exec-bff1002b-021a-4c2d-8a9d-763ac99c4bcc.png`，其余形状仅调整轮廓及原生色。
- 去除整套角色图自动替换逻辑，始终使用底模加独立配饰；默认配饰为空；切换形状保留颜色和已选配饰；画板同步使用正脸渲染器。
- 浏览器确认 localhost:5175/dressup-preview 选圆形/蜜桃后空底模正常。已有本地保存的配饰不会被静默清除，可点击全部取下。
- 测试：更新旧皇冠/平面配饰预期后 2 文件 71 项通过；新增空底模/跨形状保留专项测试复跑中。
- 构建：pnpm build 成功，107 静态页。pnpm check 首次仅新增 unused import 错误，已修复并重跑。
- 仍未提交/推送/部署。配饰与所有形状的精细贴合不作为本次无配饰底模视觉验收结论。
- 最终聚焦测试：2 文件 72 项全部通过（含新空底模测试）。浏览器截图 `/tmp/lightvela-front-bare-proof.jpg`。
- 完整测试误触发全仓后发现无关 diagnostics/settings 等失败，停止该次全仓执行；未声称全仓通过。
- check 第二次受 `.source/server.ts` 文档生成竞争影响，串行重新执行检查。
- 串行 `pnpm check` 最终通过：166 current / 171 baseline / 0 new / 5 resolved。本轮正脸底模接入完成；配饰进一步精修单独评估。

## checkpoint_2026_10_08_curated_assets
- 按用户要求建立独立素材目录 `docs/context/tasks/assets/hermes-dressup-curated/`，收录 14 张：用户目标图 1、既有七角色 7、正脸无配饰底模 5、目标配饰源图 1。
- 明确排除被否定的皇冠、旧 2D 与旧裸身造型、被否定的整套换装结果、未校准的单件配饰切图。
- `README.md` 注明各组用途和确认状态；`manifest.json` 记录原始路径、尺寸、透明度、SHA-256。核对 14/14 校验值，13 张有 alpha；目标参考截图为普通不透明图。
- 只复制/转档归档，运行时引用和页面行为未变更；无需追加前端 lint/type/test/build。
