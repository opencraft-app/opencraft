# Sandbox Envd Side Effect Follow-up

本文档记录 `envd` 在镜像验证阶段出现的独立问题，供后续单独排查。它不是当前 `gateway` 冷启动问题的一部分。

相关文档：

- 镜像主说明： [docs/agent-guides/sandbox-image-agent-guide.md](../agent-guides/sandbox-image-agent-guide.md)
- 镜像发布与 rollout： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)
- 当前镜像实现： [images/README.md](../../images/README.md)

## 1. 问题摘要

- 发现时间：`2026-03-26`
- 触发位置：`images/tests/test-envd-agent.sh`
- 失败项：`remote process side effect missing`
- 当前结论：
  - 这是一个独立于 `gateway` 的问题
  - 它不阻塞当前镜像中 `openclaw-gateway` 冷启动修复的上线
  - 但它需要后续单独修复，因为它影响我们对 `envd` 执行语义的信心

## 2. 现场现象

测试脚本期望通过 `envd` 的 `process.Process/Start` 在宿主机写出一个 marker 文件：

- 目标路径：`/var/lib/lightclaw-envd-test/marker.txt`
- 目标内容：`envd-smoke-ok`

这次验证里出现的现象是：

- `process.Process/Start` 返回 `200`
- `envd` 日志记录命令已启动
- `envd` 日志记录命令以 `exit status 0` 结束
- 但宿主机上没有观察到预期 marker 文件

对应日志证据：

```text
command="/bin/bash -lc printf envd-smoke-ok > /var/lib/lightclaw-envd-test/marker.txt"
event_type=process_start
process_result={"exited":true,"status":"exit status 0"}
```

## 3. 为什么它和 gateway 问题无关

本轮镜像的主问题是：

- `openclaw-gateway.service` 在制镜后冷启动实例里变成 0 字节空文件
- 进而导致 `systemctl --user` 看到 `masked + inactive`

这个问题已经通过新的制镜前预检和刷盘修复，并已用新镜像冷启动实证验证通过。

`envd` 这里的异常则是：

- 服务本身是 `active`
- `/health` 返回成功
- RPC 调用返回 `200`
- 只是预期 side effect 没落到测试脚本假设的位置

所以它属于另一条问题线。

## 4. 当前证据

在 `2026-03-26` 的验证现场，已确认：

- `envd.service` 为 `active`
- `curl http://127.0.0.1:49983/health` 返回成功
- `process.Process/Start` 返回 `200`
- 日志中确实出现 process start / process end
- process end 状态为 `exit status 0`
- 宿主机检查 `/var/lib/lightclaw-envd-test` 时，目录和 marker 文件都不存在

## 5. 初步判断

当前最可能的方向有 3 个：

1. 测试假设有偏差

- `envd` 实际执行命令的文件系统视图，不等于测试脚本随后通过 SSH 检查的宿主机视图
- 如果 `envd` 有单独 namespace / mount 语义，那么“写文件成功”不一定能直接在宿主机路径看到

2. `envd` 的执行语义有问题

- RPC 层把命令标记为成功退出
- 但命令副作用并没有真正落到预期环境
- 这属于运行时语义缺口，不只是测试误报

3. 测试脚本的 side effect 选择不稳

- 当前测试依赖绝对路径文件写入
- 如果 `envd` 对工作目录、权限、rootfs、namespace 有特殊处理，这个断言可能过强或过窄

## 6. 建议排查顺序

先确认 `envd` 的真实执行环境，再决定修测试还是修运行时。

建议按这个顺序查：

1. 确认 `process.Process/Start` 启动进程的真实 mount / rootfs / cwd 语义

- 重点看它写 `/var/lib/...` 时，是宿主机路径还是隔离环境路径

2. 把 side effect 改成多种观测方式交叉验证

- 文件写入
- `pwd`
- `mount`
- `stat /`
- `cat /proc/self/mountinfo`

3. 对比 SSH 宿主机视角与 `envd` 进程内视角

- 如果两边 rootfs 不同，当前测试脚本应调整
- 如果两边理论上应相同，但仍看不到副作用，则更像 `envd` 运行时 bug

4. 再决定门禁策略

- 如果是测试误报，修 `images/tests/test-envd-agent.sh`
- 如果是运行时真实问题，修 `images/envd` 或相关启动参数

## 7. 推荐最小复现实验

下个会话可先做这个最小实验：

```bash
ssh root@<host> 'mkdir -p /var/lib/lightclaw-envd-test'

ssh root@<host> 'python3 - <<\"PY\"
import struct, subprocess
payload = b"""{\"process\":{\"cmd\":\"/bin/bash\",\"args\":[\"-lc\",\"id; pwd; ls -ld /var/lib/lightclaw-envd-test; printf envd-smoke-ok > /var/lib/lightclaw-envd-test/marker.txt; ls -l /var/lib/lightclaw-envd-test/marker.txt\"]}}""".strip()
envelope = struct.pack(\">BI\", 0, len(payload)) + payload
subprocess.run([
    \"curl\", \"-sS\",
    \"-X\", \"POST\", \"http://127.0.0.1:49983/process.Process/Start\",
    \"-H\", \"Content-Type: application/connect+json\",
    \"-H\", \"Connect-Protocol-Version: 1\",
    \"-H\", \"Authorization: Basic cm9vdDo=\",
    \"--data-binary\", \"@-\",
], input=envelope, check=True)
PY'

ssh root@<host> 'ls -la /var/lib/lightclaw-envd-test && cat /var/lib/lightclaw-envd-test/marker.txt'
ssh root@<host> 'journalctl -u envd -n 200 --no-pager'
```

## 8. 当前处理建议

- 当前镜像 rollout 可以继续基于新镜像推进
- `envd` 问题应单独开会话排查
- 后续会话优先阅读本文档，再决定是修测试还是修 `envd` 本体
