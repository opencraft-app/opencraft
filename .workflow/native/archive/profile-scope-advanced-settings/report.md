# 验证报告：高级设置按 Hermes Profile 隔离

## 结论

本次变更的聚焦回归、前端检查、类型检查、生产构建和 Context 门禁均通过。高级设置的读取、保存、恢复默认和保存后回读都使用同一 `profileId`；`main` 继续映射 Hermes 原生 `default` 根 Profile。

## 已执行验证

1. 聚焦测试

   ```bash
   cd frontend
   pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 \
     src/lib/__tests__/hermes-agent-command.test.ts \
     src/pages/marketing/__tests__/agent-common-settings.test.ts \
     src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
     src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
     src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
     src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts
   ```

   结果：6 个测试文件通过，94 个测试通过。

2. 类型检查

   ```bash
   cd frontend && pnpm typecheck
   ```

   结果：通过；175 个当前诊断、276 个基线诊断，0 个新增诊断，101 个已解决诊断。

3. 前端综合检查

   ```bash
   cd frontend && pnpm check
   ```

   结果：通过；i18n extract/validate、繁体转换、文档日期、Fumadocs 生成和类型基线检查均通过。输出包含 51 个既有翻译告警，没有错误。

4. 生产构建

   ```bash
   cd frontend && pnpm build
   ```

   结果：通过；Next.js 编译、TypeScript、96 个静态页面生成和 SEO/静态资源检查均完成。构建生成的 `next-env.d.ts` 路径变化已恢复，未纳入需求变更。

5. Context 与变更集检查

   ```bash
   python3 .agents/context/scripts/validate_documentation.py --repo . --format json
   python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file <本次 12 个源文件、测试和 Task Pack>
   git diff --check
   ```

   结果：文档校验无错误/告警；change impact 通过；diff whitespace 检查通过。

## 全量测试基线

- `pnpm test` 在当前环境首先因 `localhost` DNS 解析失败退出；改用 `--api.host 127.0.0.1` 后可以启动全量测试。
- 全量测试暴露目标分支既有失败并在拖尾时手动终止，不能声明全量测试通过。抽样单独复跑确认的既有失败包括：
  - `agent-memory-save.test.ts` 仍期待无 Profile 的旧命令，但当前分支原有 Memory 实现已经生成 `hermes -p 'default'`。
  - 多个 settings 页面测试的 `runtime-config-context` mock 缺少当前分支已使用的 `useMultiBotEnabled`。
  - Slack 通道测试期待的文案与当前分支源码不一致。
- 另有模型配置、定价、文档资源和搜索路由等不在本次变更范围内的失败。本次聚焦测试未出现失败。
- `frontend/AGENTS.md` 列出 `pnpm lint`，但当前 `frontend/package.json` 没有 `lint` script；实际使用仓库现有的 `pnpm check`，该命令通过。

## 遗留风险

- 未连接真实 Hermes 实例执行端到端写入；Profile 路径、命令参数和 shell quoting 由现有 helper 及单元测试覆盖。
- 未提交、推送、创建 MR、发布或修改线上配置。
