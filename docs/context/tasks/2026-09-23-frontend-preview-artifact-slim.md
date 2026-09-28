# Task Pack: 前端预览构建产物体积优化（P0+P1）

## goal
将前端预览构建产物压缩体积从 ~71.6MB（排除 .edgeone 后）降至 ≤50MB：P0 打包排除 `.edgeone` 部署目录，P1 将 docs/changelog 被引用 png 全部切换为 webp。

## non_goals
- P2（api/search 预览环境排除搜索索引）与 P3（chunks 动态 import 拆分）不在本批次。
- 不删除 `src/content/docs/images/*.png` 源文件（回滚只需改回引用；不影响产物体积，仅被 import 的资源进入 media）。
- 不处理 `public/assets/blog`（49MB，死页面不进产物）、landing/skills 小体积图片。

## requirement_ids / requirement_refs / requirement_excerpt
- TAPD: https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137858177 （【技术需求】【LightVela】前端预览构建产物超 60MB 网关限制优化）
- 方案设计见该需求「方案设计」字段（P0：打包排除 .edgeone；P1：图片格式治理）。

## interface_refs / data_structure_refs
- `.ci/runtime/support/staticpages_pack.py` `iter_files()`：packs/archive/multipart 三种上传模式的共同文件收集入口；pathlib `rglob("*")` 会匹配点开头目录。
- `.ci/runtime/commands/publish_frontend_preview.sh` `build_next_preview_variant()`：产物冻结入口；CI 预览发布器固定取自 `origin/master`，frontend 源码取自触发分支（老分支构建脚本可能写出 `out/.edgeone`）。
- `frontend/scripts/fix-next-static-html-lang.mjs`：`NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0` 时删除 `.edgeone`（当前 master 生效，runtime 侧删除是兜底）。
- MDX 图片以 Markdown image 语法（`![alt]` + 圆括号相对路径）引用 `src/content/docs/images/` 下的相对路径 png，经 fumadocs-mdx 编译为静态资源 import 进入 `_next/static/media`（带内容 hash）。
- `public/assets/changelog/*.png` 经 public 全量复制进入 `out/assets/changelog`，必须删源才能减体积。

## history_context
- current_design_refs: `docs/engineering/journeys/source-to-production.md`、`docs/context/domains/release-gitops.md`
- relevant_evolution: 预览上传已从单次 POST tar.gz 演进为 `--upload-mode packs`（32/48MB 分卷直传对象存储），60MB 网关阻塞已解除；剩余动机为上传耗时、对象存储成本与预览站加载体验。
- superseded_refs: 无。

## acceptance
- `python3 .ci/runtime/tests/command_tests/test_upload_staticpages_preview.py` 与 `test_publish_frontend_preview.py` 全绿。
- `bash .ci/runtime/check_ci_runtime.sh` 通过。
- frontend 构建后产物无 `out/.edgeone`；`out/_next/static/media` 与 `out/assets/changelog` 不再含被引用 png。
- `tar -czf - --exclude='./.edgeone' -C frontend/out . | wc -c` ≤ 50MB。
- `node scripts/typecheck-baseline.mjs`、`i18n:check`、`check-next-seo.mjs`、`check-versioned-next-static-assets.mjs` 全绿。

## affected_paths
- `.ci/runtime/support/staticpages_pack.py`
- `.ci/runtime/commands/publish_frontend_preview.sh`
- `.ci/runtime/tests/command_tests/test_upload_staticpages_preview.py`
- `.ci/runtime/tests/command_tests/test_publish_frontend_preview.py`
- `frontend/src/content/docs/**/*.md|mdx`（png→webp 引用）
- `frontend/src/content/docs/images/*.webp`（新增）
- `frontend/public/assets/changelog/*`（png 删除、webp 新增）
- `frontend/src/pages/marketing/changelog-page.tsx`、`frontend/src/app/(site)/changelog/**`（引用切换）

## required_context
- release-gitops、service-ci

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/ci.md` | 路由 must_read | CI 边界：凭据不入文档、验证命令 |
| `docs/context/domains/release-gitops.md` | 路由 must_read | 发布链路权威 |
| `.ci/AGENTS.md` | 服务级入口 | CI 硬规则（check_ci_runtime.sh 验证） |
| `.agents/context/change-impact.json` | 变更影响映射 | `.ci/runtime/**` 命中 release-gitops，需同步设计文档 |

## evidence
- 实测 `frontend/out/.edgeone` = 155MB（产物 309MB 的一半）；`rglob('*')` 含 1550 个 `.edgeone` 条目（修复前）。
- 被引用 docs png 127 个（50MB 源，全部无 webp 同伴），MDX png 引用 532 处；changelog 被引用 png 37 个（8.5MB）+ 未引用 1 个，均无 webp 同伴。
- 其余证据见 validation 段（完成后回填）。

## risks
- webp 有损转换画质风险 → quality 82 与既有 `optimize-static-assets.mjs` 参数一致；docs png 源保留可即时回滚；changelog png 可从 git 历史恢复。
- 老分支触发预览时 runtime 删除 `.edgeone` 与构建端 `NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0` 双保险，无单点。
- 批量文本替换误伤 → 仅替换以 `.png` 结尾的 MDX image 引用且要求同名 webp 存在。

## validation
- 单测：`test_upload_staticpages_preview.py` 21 通过（含新增 2 个 .edgeone 排除测试）；`test_publish_frontend_preview.py` 2 通过；blog/changelog/intl-home 相关 vitest 通过；master 存量失败（与本次无关，stash 验证过）：`home-localized-copy` 4 个（supportedLocales 沙箱）、`home-play-badges` 1 个（韩语文案漂移）、i18n-extract 6 语种各 8 条未翻译。
- 构建：`NEXT_PUBLIC_REGION=cn NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0 pnpm run build:next` 全链成功（含 check-next-seo）。
- 体积（TAPD 验收口径 `tar -czf - --exclude='./.edgeone' -C frontend/out . | wc -c`）：
  - 治理前 master 实际基线（含 9-21 后新合入的 blog 62MB、intl-home 62MB 未压缩资产）：压缩后 ~152MB 量级。
  - 治理后：未压缩 309MB→147MB；**压缩后 50.7MB**（-67%）。
  - 分项：media 43→18MB（127 png→webp 5.3MB，media png 清零）；changelog 9.1→3.1MB；blog 49→5.8MB；intl-home 62→7.5MB（83 png→webp，残留 png 0）。
  - 剩余残留 png 47 个共 1.7MB（social-preview/icon/二维码等语义图片，不宜转换）。
- 后续达标路径：P2（api/search 52MB 未压缩≈8MB 压缩体积，预览环境排除索引）后预计 ~43MB，低于 50MB 目标。

## follow_ups
- P2 api/search 与 P3 chunks 拆分（TAPD 既定后续批次）。
- `import-international-homepage.mjs` 重跑（设计稿重导入）会重新引入设计稿 png 资产并可能回退片段引用；设计稿资产 webp 化需上游配合。
- master 存量门禁红：i18n-extract 6 语种各 8 条未翻译文案；home-localized-copy / home-play-badges 测试失败；typecheck baseline 漂移 2 条（datong-page-map cloud-desktop、fflate 模块解析）。
