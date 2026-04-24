---
change: real-name-verification-and-cdn-cleanup
---

# 设计文档：实名认证入口 + 静态资源 CDN 清理

## 设计目标

1. **可下线优先**：实名认证的后端接口（腾讯云 shadow 核验）存在无法按期上线的风险，因此前端必须提供「一行切换」的总开关，以便上线当天即使接口没 Ready 也能整体下线，不造成用户迷惑。
2. **去环境变量化**：`VITE_ASSET_CDN_ENABLED` 这类"真正意义上只有一个值"的开关，徒增 `.env` 噪音和部署心智负担，改为源码常量，部署链路更干净。
3. **桌面端零视觉回归**：订阅页 / OpenClaw 设置页的走查修改只影响对应局部区域（文案、loading 尺寸、边框），不影响其它布局。

## 核心改动

### 1. 实名认证功能总开关（Feature Flag as Constant）

在 `account-page.tsx` 文件顶部添加一个**源码常量**：

```ts
/**
 * 实名认证功能总开关
 *   - false：整行不渲染，Modal 也不挂载
 *   - true ：恢复完整流程
 */
const REALNAME_ENABLED = false;
```

所有「实名认证」相关 JSX 均包在 `{REALNAME_ENABLED && (...)}` 里：

- 账号信息区实名条目（行容器）
- 实名认证 Modal（`showVerifyModal`）
- 徽标与「去认证」CTA

同时保留 `verified` / `verifiedName` / `showVerifyModal` 等 state 声明，只是外层 JSX 不渲染，**避免下线时改动面过大**。

#### 为什么是源码常量而不是环境变量？

| 方案 | 优点 | 缺点 | 本次选择 |
|------|------|------|---------|
| 源码常量 | 改一行、走 CR、随代码发布；diff 明确 | 需要发版 | ✅ |
| 环境变量 | 不发版即可关；灵活 | `.env` 噪音、跨环境易漂移、dev/prod 不一致难排错 | ❌ |
| 远程 feature flag 服务 | 动态开关、分人群灰度 | 基础设施成本高 | ❌（过度工程） |

本次是临时兜底，两三周后若接口就绪就直接改回 `true` 并发版；不值得引入 FF 服务。

### 2. 静态资源 URL 工厂去环境变量化

**改前**：
```ts
const CDN_ENABLED = import.meta.env.VITE_ASSET_CDN_ENABLED === "true";
const CDN_BASE = import.meta.env.VITE_ASSET_CDN_BASE || "https://...";
export const assetUrl = (path) => CDN_ENABLED ? `${CDN_BASE}${path}` : path;
```

**改后**：
```ts
// ⚠️ CDN 基址：如需更换，改这一行即可（不带尾斜杠）
const CDN_BASE = "https://lightvelacdn-1388575217.cos.ap-shanghai.myqcloud.com";

export const assetUrl = (path: string): string => {
  if (!path) return path;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith("data:")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CDN_BASE}${normalized}`;
};

export const isUsingCdn = true; // 保留导出，向后兼容调用方
export const cdnBase = CDN_BASE;
```

#### 关键点

- `isUsingCdn` 保留为 `true` 的常量导出，**不破坏既有调用方**（如 openclaw-settings-page.tsx 的 loading 尺寸分支逻辑已清理，但其它模块可能仍在 import）。
- 绝对 URL / `data:` 直接 passthrough，避免被拼成 `CDN_BASE/https://...` 错误路径。
- 路径归一化兼容无 `/` 前缀写法。

### 3. 订阅页文案回归

从 git 历史（`git log -S`）中检索出被误删的原始文案，并恢复到 `subscribe-page.tsx` 中「选择适合你的套餐」标题下方：

```
"根据你的使用场景，选一个套餐开始 AI Agent 之旅。"
```

同时走查修正：favicon type、缩进不一致、冗余的条件判断。

## 关键决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 实名认证开关位置 | A. 环境变量 B. 源码常量 C. 远程 FF 服务 | **B** | 临时兜底，不值得搞基础设施；改一行走发版即可 |
| 下线时组件代码处理 | A. 物理删除相关代码 B. 条件不渲染+保留 state | **B** | 后续要回开；保留大部分代码面，下线只动一行 |
| CDN 开关去留 | A. 保留环境变量 B. 硬编码 C. 走 vite config | **B** | 线上长期只有一个值，多层开关只增加排错成本 |
| `isUsingCdn` 导出 | A. 删除 B. 保留为 true | **B** | 避免 break 其它文件；可随后续清理再删 |
| 实名认证组件抽取 | A. 独立组件 B. 内联在 account-page | **B** | 目前仅一处使用且可能下线；复用需求出现再抽 |

## 已知权衡与后续优化

- **`REALNAME_ENABLED=false` 时，实名相关 state 依然声明**：会触发极少量 dead code warning。权衡之下保留，避免下线后再开时改动量过大。后续上线稳定后可删除该常量并清理所有 `&&` 判定。
- **`isUsingCdn` 恒为 `true` 的导出**：向后兼容形态，属于"可删未删"的小技术债。后续批量 grep 清理即可。
- **身份证号输入校验**：Modal 里目前仅做长度 / 格式粗校验（18 位 / 15 位正则），真正的合法性校验交给后端接口。上线前需要加前端 `utils.isValidIdCardNo()`。
- **CDN 基址切换**：改源码常量意味着切换 CDN 要走发版；如果未来需要快速切回源站，可回退这一行（记录为 TODO）。

## 风险

- **低风险**：实名认证默认下线（`REALNAME_ENABLED=false`），即使弹窗逻辑有 bug 也不会触达用户
- **低风险**：CDN 硬编码后，若 CDN 故障需要走发版回退源站；但 CDN 可用性目前稳定
- **已验证**：本地 + 预发环境下 `/` `/subscribe` `/account` 视觉走查通过
