# 已确认的边界

- DSH 管理 discovery scope 注册了本机与工作区 Provider，未证明实际 Agent scope 可见。
- DSH 原生 collect 按 scope 层合并，再在同层按 rank 选择；global-only 注册可能被 Agent 层覆盖。
- 原生 pre-step 已发布替代目录，filesystem Provider 支持 watcher、invalidate、缺失目录监听；应复用。
- Local DSH install/uninstall 尚未调用失效桥或发出 skills/changed。
- Hermes bridge 的 skills/list 当前返回空 data；Profile Skills mutation 通过独立 handler/action 回执。不能声称 Hermes 具有 DSH 的步骤级刷新。
- 公共接口本轮不变，先在 DSH adapter 内实现并保留第二引擎差异。
- 实测 `agent.ctx` 不带本插件的 skills 注入权限；使用继承插件依赖的 createScope，保留已有 scope identity/parent。
- 原生 filesystem 实际在 standing preset 层，Agent 子层追加 user Provider 会错误覆盖 project。新增负例证实后改为 standingMountFor 的同层、引用计数挂载；复用既有 rank。
- 打包 extraResources 是显式模块列表，新模块必须登记；smoke 按该列表复制模块到隔离目录再启动真实 DSH，避免仅源码路径成功。
- 续接核验：Hermes `tui_gateway/methods_tools.py:1172` 的 `skills.reload` 没有应用 Profile 运行时作用域或更新目标 Session；`agent/skill_commands.py:454` 的 reload 只返回名称增删，名称相同的正文变化仍归 unchanged。CLI 的下一消息提示不等同 Gateway RPC。需要原生运行时可写真源，ref 不修改。
