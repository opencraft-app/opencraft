# 本地开发与快速发布

本环境按“本次改动提交或合入本部署约定的发布源码分支 → 固定 commit SHA → 从该提交构建候选 → 发布 → 验证”的顺序更新。仓库不规定该分支的名称或远端：`publish.mjs` 只要求 `sourceRevision` 是完整 SHA 且在 `sourceRepository` 中存在（`git cat-file -e`），不检查所在分支；分支由各部署自行选定并记录。这些脚本不 push，提交本身也不会自动触发部署。每次候选和计划的 `sourceRevision` 绑定该分支中的明确 commit；保留其他任务的未提交改动，不从未提交补丁直接发布。已获授权更新本环境时，合入后继续完成发布与验证。变更依赖、协议或数据库时回到正式交付流程。

`publish.sh PLAN.json DEPLOYMENT_LOCK` 在宿主机运行；需要 Bash、flock、Docker Compose、Git 和 Node。通过 `OPENCRAFT_NODE` 指定 Node。所有入口必须使用同一部署锁；锁覆盖基线核验、配置切换、健康/行为验证与回滚，并发调用立即以 75 退出。候选构建可并行，基线变化的候选不能发布。

计划是受信任的本地文件，验证命令是 argv 数组，不经过 shell。字段如下：

```json
{
  "schemaVersion": 1,
  "releaseId": "unique-local-release",
  "projectDirectory": "/absolute/deployment/docker",
  "composeFiles": ["/absolute/deployment/docker/compose.yaml", "/absolute/deployment/docker/compose.override.yaml"],
  "overrideFile": "/absolute/deployment/docker/compose.override.yaml",
  "candidateOverride": "/absolute/candidate/compose.override.yaml",
  "stateDirectory": "/absolute/deployment/releases-state",
  "sourceRepository": "/absolute/source",
  "sourceRevision": "FULL_LOCAL_COMMIT_SHA",
  "service": "gateway",
  "candidateImageId": "sha256:FULL_IMAGE_DIGEST",
  "expectedImages": {"gateway": "sha256:CURRENT_GATEWAY_DIGEST", "brain": "sha256:CURRENT_BRAIN_DIGEST", "hands": "sha256:CURRENT_HANDS_DIGEST"},
  "verify": [["/absolute/node", "/absolute/candidate/verify.mjs"]]
}
```

`candidateOverride` 是完整候选 override：合并后仅允许目标服务的 image 改变。先核实所有服务的运行镜像与持久配置一致。用镜像 ID 而非可变标签固定候选；提交包含全部源码输入，构建 manifest 记录实际产物摘要与组件来源，不能用一个 commit 冒充未重建组件。

代理由待切换服务承载时，通过独立 `systemd-run --no-block` 服务执行该入口，并设置日志及足够的超时；工具连接断开后读取持久回执，不重复启动发布。`stateDirectory/releaseId` 独占创建，保存原配置、候选配置、计划、验证输出和阶段，目录/文件仅部署用户可读。操作记录不能包含凭据。

验证失败自动恢复原 override 与原镜像并检查健康。宿主中断或之后需要明确回滚时，用原计划调用 `publish.sh PLAN.json DEPLOYMENT_LOCK --rollback`；恢复也加同一把锁，拒绝覆盖后续版本或已被别人修改的配置。`rollback_failed` 需要依据记录处理，不盲目重发。

容器健康不等于功能可用。`verify` 必须验证本次行为和受影响交付单元已有的关键能力；UI 检查候选生产资源和实际路由。发布成功后对照镜像 ID、manifest、启动服务目录和浏览器资源版本。此脚本管理 Compose 配置，不修改 systemd 或其他发布入口；在计划前确认 systemd 会加载同一配置。

验证脚本：`node --test scripts/fast-release/publish.test.mjs`。测试使用模拟 Docker，覆盖占锁、基线变化、越界配置和失败回滚；真实容器验收另行完成。发布授权沿用当前任务，脚本与 Skill 不自行授予发布权限。

## 独占原生资源的冷切换

持有原生进程、SQLite writer 或文件租约的服务必须在计划中声明冷切换：

```json
{
  "lifecycle": {
    "mode": "cold",
    "afterStop": [["/absolute/node", "/absolute/candidate/assert-native-quiescent.mjs"]]
  }
}
```

发布、自动回滚和显式回滚共用同一条路径：停止目标服务 → 执行所有
`afterStop` 检查 → 原子替换配置 → 启动并等待健康。检查脚本由资源 owner
提供，必须有界地确认原生进程退出及其租约可接管，不能仅靠固定 sleep，
也不能强删仍有效的锁。检查失败时不启动候选；回滚同样不能绕过检查。
默认未声明 lifecycle 的服务仍使用原来的 Compose 替换流程。

切换与检查的输出保存在阶段日志中；失败的验证也保存 stdout/stderr，
回执指向相应日志。每个日志最多保留末尾 128 KiB，权限 0600。验证脚本
必须自行避免输出凭据。日志存在不代表验证通过，以回执阶段为准。
这些测试验证发布器的排序和失败契约；实际原生 owner 检查与容器切换仍需
在对应发布候选上验证。

## 准备与切换的所有权

一条发布只有两个阶段：准备拥有候选文件，切换拥有部署租约。推荐统一入口：

```sh
OPENCRAFT_DEPLOY_WAIT_SECONDS=600 ./scripts/fast-release/release.sh \
  /absolute/candidate/plan.json /absolute/deployment/deploy.lock -- \
  /absolute/node /absolute/candidate/build-and-verify.mjs
```

`BUILD_COMMAND` 是受信任 argv，只执行一次；负责从已提交版本构建、候选验证和
生成完整计划。此阶段可以读取现网作为预期基线，可以与其他候选构建并行；
不能写生产配置、停止服务、持有部署锁或等待 `ready` 文件。
入口会检查继承的锁描述符（包含 fd 8 等别名），拒绝带着部署租约构建。

准备完成后，入口在候选目录创建私有 `.prepared-*`，复制计划与 candidate
配置并设为只读，再调用 `publish.sh`。使用日志打印的 **Prepared release plan**
路径进行回滚。原始计划/配置后续变化不会改变已排队的候选；验证脚本及其
输入也必须放在本次独占候选目录，不能复用另一次发布的可写产物。

`OPENCRAFT_DEPLOY_WAIT_SECONDS` 为 0..1800 秒，默认 0（忙时以 75 退出）。
等待 flock 不持有锁，不阻塞当前发布；超时没有服务变更。锁只覆盖 publisher
的现网基线复核、持久回执、冷切换、验证及失败回滚。基线过期直接拒绝，
由调用方释放锁后重新准备，不能在锁内重建、盲目改写 expectedImages 或
自动接管后续版本。已经准备好的计划仍可直接调用 `publish.sh`。

独立监督器应运行整个 `release.sh`，无需外层再 `exec 9`/flock，也不增加
排队服务或 ready 文件协议。已有外层持锁入口应迁移到这个流程。
测试：`node --test scripts/fast-release/release-flow.test.mjs scripts/fast-release/publish.test.mjs`。

## 追加迁移后的兼容回退

如果旧 Worker 拒绝新的 SQLite 迁移版本，计划可声明 `rollback: {override: "/absolute/compatible.yaml", imageId: "sha256:..."}`。
这必须是预先构建、独立验证的兼容镜像，例如保留旧网关业务代码并仅保留已升级的存储 Worker。
发布器封存回退配置，验证它只改变目标服务镜像，并在自动和显式回退时使用同一冷切换契约。
回执分别记录原镜像与实际回退镜像；该回退保留用户写入，不降级数据库、不恢复旧数据快照。
不声明该字段时，仍恢复原配置和原镜像。
