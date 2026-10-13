# mono2 Stream 的触发与记录

Stream 是独立的事件入口。蓝盾通用 build_start 返回的 buildId 与 GIT 渠道变量，
不能单独证明 Stream 已登记这个构建。不要将这个接口用于 mono2 Stream 的新建构建。

## 已定位的前端接口（2026-10-13）

从 https://stream.woa.com 当前公开的前端 twice/pipelines JavaScript 定位到：

- GET `/stream/api/user/trigger/build/{projectId}/{pipelineId}/manual`：手动启动参数。
- POST `/stream/api/user/trigger/build/{pipelineId}/startup`：Stream 手动触发。
- POST `/stream/api/user/history/build/list/{projectId}`：Stream 构建历史；请求体包含 pipelineId、page、pageSize 等筛选项。
- GET `/stream/api/user/current/build/detail/{projectId}`：详情；查询参数为 pipelineId、buildId。

前端 projectId 是工蜂数字 ID `1731878`，不是蓝盾 projectId `git_1731878`。
启动请求由当前前端的 formData 与 projectId 组成，可选 commitId；不可直接照搬蓝盾 --params。
先读取 Stream 手动参数和正常身份认证，再依据实际表单契约构造请求，不猜测结构。
前端客户端使用 withCredentials 和 CSRF cookie/header；现有蓝盾 API token 对 Stream 详情
返回 401。这个结果只说明该调用没有正常 Stream 认证，不代表所有身份都不能手动触发。
不抓取或复制 Cookie，不伪造用户头，不通过未鉴权端点绕过认证。

## 通过 Git 事件触发

用户已授权 Git 触发时，读取目标 YAML 的 on.push.branches、paths 和 paths-ignore。
为本次修复准备最小相关提交，按仓库正常提交/合入流程产生匹配的 push 事件。
CTL 监听 master 上的 ctl/**，ctl/README.md 既有 Trigger note 是已用过的重建方式；
只修改技能或 .ci/runtime 配置不匹配 CTL 的业务路径，空提交也不能假定匹配。
不得为强行触发改变现有路径政策、伪造 webhook 或绕过 MR 检查。

启动后优先通过 Stream 列表/详情匹配 Git 事件与 buildId，并核对分支、源提交与状态。
若只能通过蓝盾辅助查询，则记录 codeGitWebHookTrigger/GIT 和 checkout material，
同时明确 Stream 页面/API可见性尚未直接验收，不以拼出的 URL 代替真实记录。
重复触发前先查已有任务；历史 BS/API-GIT 任务的取消需要单独明确授权。
