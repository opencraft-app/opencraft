## stage
源提交 6ede0c1d5 和集成提交 5cf62fac9/00f653aa8 已推送；正在提交平台入口隔离和测试断言修复，随后最终合入 master。

## verified
- source worktree /data/mono2-mobilefirst-20260930 保留当前 systemd Expo 预览；生成 next-env.d.ts 不提交。
- integration worktree /data/mono2-mobilefirst-integration-20261006，branch integrate/opencraft-mobilefirst-20261006。
- 20 处冲突按源码责任解决；保留 master 的侧栏折叠/Chat 跳转/媒体焦点/消息身份逻辑及手机端 DOM 容器能力。
- 集成依赖独立 npm ci 安装，不借其他 worktree 的 node_modules。
- 原分支 frontend check/Auth Go 测试通过；原分支 full gate 和 frontend 全量测试未通过。

## unverified
- 最终平台入口 iOS bundle；Expo Web 导出已通过。
- 最终集成分支与 master 写入和远端读取核验。
- iPad 横竖屏、分屏、浮动键盘及外接键盘实机矩阵；仅设置退出已被用户确认。

## discard
- 原分支及集成 broad gate/test 的失败运行已停止；已保存失败日志和 baseline 对照，不能作为通过证据。
- 生成副本已在 00f653aa8 按集成真源同步；后续 frontend 测试源码提交须再次同步 sourceRevision。

## restore
- SSH git@git.woa.com:wisp/mono2.git 已验证；HTTPS 未配置凭证，不新增/输出 token。
- 验证日志 /tmp/mobilefirst-integration-*-20261006.log。
- 用户已授权提交、推送与合入 master；无 App/主站/GitOps/GitHub 发布授权。

## next_action
完成集成源码提交，机械同步 Agent Console 并独立提交，复验后推送并核对远端 master。
