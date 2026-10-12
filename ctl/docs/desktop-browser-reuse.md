# 镜像浏览器复用与存量配置

## 问题与职责

基础镜像的 `/opt/ms-playwright/chromium-*/chrome-linux*/chrome` 是浏览器引擎缓存，不代表 XFCE 的 WebBrowser helper 或 HTTP/HTTPS MIME 默认关联已注册。Hermes ACLI 升级的 `npm install -g agent-browser` 也不是图形桌面默认浏览器的安装/注册过程。

LightVela 在机器创建成功后，通过 `ensureDesktopBrowserOnCreate` best-effort 调用同一个离线能力 `pkg/instance/scripts/ensure-desktop-browser.sh`。失败、缺失或不支持不回滚机器创建，不安装系统包，不启动桌面。源码变更需要另外提交、发布后才能作用于新建机器。

## 隔离与兼容性

- root 所有、不可被普通用户改写的镜像缓存是唯一复用来源；检查运行库依赖。
- `/usr/local/lib/vela-desktop-browser-v2/chrome` 是原文件的硬链接，共享 inode/磁盘块；同目录资源用软链接。跨文件系统直接跳过，不复制或下载。
- Ubuntu userns 限制启用时，仅为上述专用启动路径加载一个精确 AppArmor profile。**不改变原 `/opt/.../chrome` 路径的 profile、不改全局 sysctl、不放开用户可写缓存、不使用 no-sandbox。**
- 桌面使用独立 user-data-dir，不配置 CDP/9222，不修改 Hermes/OpenClaw 配置，不重启已有进程。
- 发现系统浏览器、自定义 XFCE helper 或自定义 MIME 关联，保守跳过，保留用户原选择；这不代表既有浏览器的 GUI 已验收。
- 配置文件以 agentuser 身份操作，拒绝符号链接配置及父目录。root 管理路径校验所有权与写权限；不覆盖未归本能力管理的路径。
- 重复执行校验 manifest；配置漂移、缓存更换、冲突或缺依赖进入处理队列，不盲目重写。
- 若尚未安装 XFCE/exo-open，先登记能力；后续桌面安装具备这些组件后才可验证默认菜单入口。不会为了本能力额外安装桌面。

## TAT

命令正文直接使用同一个脚本，在开头加入 `set -- --check agentuser` 或 `set -- --apply agentuser`。命令身份 root。单台回退使用 `set -- --rollback agentuser`，以 manifest 校验漂移后才恢复原用户关联并卸载本能力的策略/入口。

每批保留目标业务实例/sandbox/CVM/地域、意图、命令哈希、InvocationId、各任务状态及业务 JSON。提交超时不得盲目重投。仅查询该 invocation、匹配实际目标；TAT SUCCESS 只证明命令执行，业务状态必须单独统计。

`CONFIGURED`/`ALREADY_CONFIGURED` 是配置状态，`gui_verified=false`。真实验收另检实际启动路径、Namespace/Seccomp、DOM、默认启动器与外网页面。离线缺失、已有系统浏览器、自定义选择、漂移等全部显式跳过，不自动联网降级。

## 验收记录（2026-10-12）

上海未额外安装 Chrome 的 canary `ins-j73jtnf1`：原镜像 Chrome 145 与专用入口 same inode；GUI Namespace/Seccomp 正常；本地 DOM、lightvela.com 完整渲染通过；原路径仍 unconfined，原路径独立 headless DOM 通过；回退、重应用和幂等通过。该机器缺少 exo-open；另在授权参考用户 `usr_143e96b636afd48b3addc752` 的 `ins-6lco8oj3` 上临时验证 v2：真实 `exo-open --launch WebBrowser` 默认启动、同 inode、Namespace/Seccomp、本地 DOM、完整外网页面均通过，验证后回退 v2 到此前参考机配置，不重启原桌面或 Agent。

批次进度与详细证据在本机 `.codex-tmp/desktop-browser-reuse-20261012/fleet/`；不将用户清单或运行凭据提交仓库。镜像 Chromium 版本维护由镜像责任方负责，本能力只复用，不承担安全更新。
