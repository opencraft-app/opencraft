# `/feai-terminal-output` — 终端输出 token 治理

> 检查和启用 tokenjuice 终端输出压缩。该命令不改变项目代码，只给出安装、hook、手动 wrap 和 raw 旁路建议。

---

## 命令格式

```bash
/feai-terminal-output [check | install | wrap]
```

| 参数 | 说明 |
|---|---|
| `check` | 检查 `tokenjuice` 是否安装，以及规则文件是否存在 |
| `install` | 输出推荐安装命令，不自动联网安装 |
| `wrap` | 给出长输出命令的手动包装示例 |

---

## Check

```bash
command -v tokenjuice >/dev/null 2>&1 && tokenjuice --version || echo "tokenjuice not installed"
{ test -f .codebuddy/skills/feai-native/references/team-conventions.md \
  || test -f .agents/skills/feai-native/references/team-conventions.md; } \
  && echo "team-conventions ok"
```

如未安装，只 WARN，不阻塞 workflow。

---

## Install

```bash
npm install -g tokenjuice
tokenjuice install codebuddy
tokenjuice install claude-code
tokenjuice install codex
```

只安装实际使用的 host。安装需要网络和用户权限时，由用户在本机执行。

---

## Wrap

```bash
tokenjuice wrap -- pnpm type-check
tokenjuice wrap -- pnpm test
tokenjuice wrap --raw -- pnpm test
tokenjuice wrap --store -- pnpm build
```

适合：测试、构建、lint、type-check、仓库清单和 diff stat。

不适合：`cat` / `sed` / `nl` / `jq` 精确读文件、高风险写操作、部署、删除、生产数据命令。

详细规则见 feai-native skill `references/team-conventions.md` 的「终端输出与上下文预算」一节（安装后位于 `.codebuddy/skills/feai-native/references/team-conventions.md`，codex profile 为 `.agents/skills/feai-native/references/team-conventions.md`）。
