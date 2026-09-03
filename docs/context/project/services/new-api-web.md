---
id: new-api-web-service-detail
type: service
scope: new-api web 下 React 和 TypeScript 控制台的延后实现与验证指引。
triggers: ["new-api web", "react console", "new-api frontend"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - new-api/docs/README.md
  - new-api/catalog-info.yaml
  - new-api/web/package.json
  - new-api/web/src
  - new-api/web/AGENTS.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: service
derived: true
---

# NewAPI Web 服务详情

> 本页是 `new-api` 服务 Context 的 Web 子组件派生摘要，不是独立 Service Catalog 记录。

## 技术栈与归属

此 package 是用 Rsbuild 和 Bun 构建的 React 19、TypeScript 控制台。TanStack Router 负责 route 定义，TanStack Query 负责服务端状态，Zustand 负责有意维护的客户端状态，React Hook Form 加 Zod 负责表单验证，i18next 负责用户可见文案。选择 API 前，在 `package.json` 确认已安装依赖和准确脚本。

## 具体实现规则

- React 组件中的用户可见字符串走 `useTranslation()`。只有响应式语言变化无关时，非 React helper 才可使用 i18next singleton。新的动态 key 必须能被既有 i18n 提取/static-key 机制发现。
- 避免 `any`、嵌套三元表达式、不透明的位置字面量和宽泛 store 订阅。优先使用显式类型、早返回、可复用时的具名 helper，以及只选择组件消费状态的 Zustand selector。
- 使用共享 Axios instance 和已有错误处理器。Query 读取使用稳定数组 query key；mutation 必须 invalidate 或更新确切受影响 query。不得为了一个功能增加第二套请求 abstraction。
- Route search 参数必须按 package 的 Zod/TanStack Router 模式验证。认证重定向归已有 route boundary，不能在叶子组件重复。
- 表单使用 Zod schema 和 `z.infer`；将服务端验证错误映射到字段，保持加载、成功和错误状态可观测。
- Tailwind 与既有 component primitive 是默认样式面。保留键盘操作、焦点可见性、label 关联、对比度、空态、加载态和移动端溢出处理。
- 没有仓库 sanitizer 时绝不渲染不可信 HTML。不得记录 token、cookie、凭据或原始 provider payload。
- 保持一个功能的 component、schema、hook 和测试相邻；仅当无关行为开始共享状态时拆分文件，而非机械按行数拆分。

## 验证矩阵

只运行与变更相关的门禁，但不得以一个门禁替代另一个：

```bash
cd new-api/web
bun run typecheck
bun run lint
bun run format:check
bun run build:check
```

触及模块有测试时运行聚焦测试。用户可见行为需按状态检查：适用时覆盖成功、加载、空态、权限/错误和窄视口。依赖变更需使用仓库 package manager 更新 lockfile。

## 上游边界

`new-api/` 是 squash 风格上游 subtree。导入上游或变更 subtree metadata 前读取 `new-api/MONO2_SUBTREE.md`。源码导入不会部署 NewAPI 或更新 GitOps；发布是单独审阅的任务。
