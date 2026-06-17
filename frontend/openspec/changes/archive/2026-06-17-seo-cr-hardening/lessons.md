---
title: SEO CR 边界加固经验沉淀
status: done
date: 2026-06-17
---

# Lessons

## 关键实现决策

- 决策 1：继续使用轻量正则 upsert，而不是引入 HTML parser。原因是本次注入范围只涉及 head 内固定 tag，增强 matcher + 测试即可覆盖评审指出的风险；引入 parser 会扩大依赖和构建影响面。
- 决策 2：非法 URI 编码 fallback 到原始 segment，再自然回退默认 Agent title。这样既不吞掉合法 section，又避免为异常路径引入新的错误页分支。
- 决策 3：mirror 测试直接 import `generate-static-site.mjs` 的公开 `resolveStaticRoutes()`，而不是继续用源码正则解析 route。这样 route 对账更贴近真实构建行为。

## 踩坑记录

- 坑 1：只修 `<meta name="...">` 反序还不够，HTML 属性写法允许 `name = "description"` 这样的空格形式。解决方式是 matcher 中使用 `\s*=\s*` 并补测试。
- 坑 2：独立 worktree 初始没有 `node_modules`，`pnpm vitest` 会报 `Command "vitest" not found`。解决方式是先在 `frontend/` 运行 `pnpm install --frozen-lockfile`，区分依赖未安装和代码问题。
- 坑 3：当前 `frontend/openspec/plan.md` 是旧需求遗留，不能机械地按 plan 归档本次 SEO CR。解决方式是新建本次 CR 的归档条目，并在归档后重置状态文件。

## 技术选型理由

- 未新增依赖；沿用 Vitest + TypeScript + 现有 `seo-html.ts` / `seo-data.ts` 分层。
- 使用 `pathToFileURL()` 动态 import `.mjs` 脚本，适合在 Vitest/node 环境下稳定加载 `generate-static-site.mjs`。
- 使用函数式 replacement 继续规避 `$` 替换元字符问题，避免将修复退回字符串 replacement 的旧风险。

## 可复用经验

- 对 head tag 做 upsert 时，matcher 必须按“tag 起点 + 任意属性顺序 + 属性空格”处理，不能假设属性顺序。
- SEO 的 dev、SPA runtime、prerender 三条链路只要无法共享同一个模块，就必须有 mirror 测试守护数据一致性。
- route segment decode 必须是安全函数，尤其是 dev server / SSR / middleware 链路，不能让用户输入路径导致 500。

## 未实现 / 后续优化

- P1：后续可考虑把 `generate-static-site.mjs` 改为可消费 `seo-data.ts` 的构建脚本，从机制上消除双源数据。
- P2：如果 head 注入字段继续增加，再评估是否引入 `parse5` / `htmlparser2` 取代正则。
- P2：auth 辅助页当前仍会重定向到登录页；如未来解除重定向，需要补页面级 description。
