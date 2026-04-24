---
spec: marketing
change: real-name-verification-and-cdn-cleanup
delta_type: additive + modified
---

# Delta Spec：Marketing 实名认证入口（可下线）+ CDN 清理

## ADDED（新增能力）

### 账号页 · 实名认证入口（受总开关控制）

- `account-page.tsx` 顶部定义源码常量 `REALNAME_ENABLED`（默认 `false`）。
- 当 `REALNAME_ENABLED === true` 时，「账号信息」模块新增一整行「实名认证」：
  - 未认证：行右侧显示「去认证」CTA，点击打开 `VerifyModal`
  - 已认证：显示 `ShieldCheck` 徽标 + 姓名（脱敏展示）
- `VerifyModal` 包含：真实姓名输入、身份证号输入、提交按钮、错误提示区。
  提交逻辑目前为占位（后端 shadow 接口未就绪）。
- 当 `REALNAME_ENABLED === false` 时，该行与 Modal 均**不渲染**，用户完全看不到任何实名相关 UI。

### 前端 Feature Flag 规范（源码常量模式）

在 `specs/marketing.md` 的"业务规则"中增加：

> **前端临时 Feature Flag**：当某个功能依赖不稳定的后端 / 外部依赖（如腾讯云 shadow 核验），
> 前端需提供「一行切换」的总开关，位于**模块顶部源码常量**。命名风格为全大写 `XXX_ENABLED`，
> 并附带详细注释说明：下线策略、关闭时 state 保留原因、上线时回切方式。
> 不使用环境变量或远程 FF 服务，避免跨环境漂移与基础设施成本。

## MODIFIED（修改能力）

### 静态资源 URL 工厂（`src/lib/asset-url.ts`）

- 去除环境变量 `VITE_ASSET_CDN_ENABLED` / `VITE_ASSET_CDN_BASE` 分支
- `CDN_BASE` 常量硬编码为：`https://lightvelacdn-1388575217.cos.ap-shanghai.myqcloud.com`
- 所有环境（dev / prod）**统一走 CDN**；如需更换基址，直接修改源码常量
- `assetUrl(path)` 行为：
  - `path` 为空 → 原样返回
  - 绝对 URL（`http(s)://` / `//`）或 `data:` URI → 原样返回（避免二次拼接）
  - 相对路径 → 归一化后拼接为 `${CDN_BASE}${normalized}`
- 保留 `isUsingCdn = true` 与 `cdnBase = CDN_BASE` 两个只读导出，兼容既有调用方

### 订阅页（`subscribe-page.tsx`）

- 「选择适合你的套餐」标题下方小字恢复：
  「根据你的使用场景，选一个套餐开始 AI Agent 之旅。」
- 走查修正：缩进一致性、冗余条件判断精简

### OpenClaw 设置页（`openclaw-settings-page.tsx`）

- 移除依赖 `VITE_ASSET_CDN_ENABLED` 的 loading 尺寸分支逻辑
- loading 状态咖啡图标尺寸统一为 `78px`（此前在 CDN 开关不同分支下为 132px / 78px 两套）

### 账号信息折叠态边框

- 修复「账号信息」卡片折叠时出现的双边框线问题（容器 border 与内部 item border 重叠）

### 环境变量清单

- 从 `.env.example` / `.env.production` 中移除：
  - `VITE_ASSET_CDN_ENABLED`
  - `VITE_ENABLE_REAL_NAME_VERIFICATION`
- 从 `src/vite-env.d.ts` 中移除上述变量的类型声明
- `.env.example` 补充注释：静态资源 CDN 基址已硬编码，不再通过环境变量配置

## NOTE（已记录的技术债 / TODO）

1. **`REALNAME_ENABLED=false` 时**，相关 state（`verified` / `verifiedName` / `showVerifyModal`）
   仍然声明但未使用。权衡保留以最小化下线改动；待后端接口稳定上线后，统一清理常量与相关判定。
2. **`isUsingCdn` 恒为 `true` 的导出**属于向后兼容形态，可后续批量 grep 清理 import。
3. **身份证号合法性校验**：当前 Modal 仅做粗校验，真正合法性校验交给后端；
   上线前需要补前端 `utils.isValidIdCardNo()`（含位数、校验位、地区码）。
4. **CDN 切换须发版**：如未来需要快速切回源站，需回退 `CDN_BASE` 常量并重新发版。
