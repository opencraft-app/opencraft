# TODO: LibreChat + gateway 联调闭环

## 背景

当前仓库已经把 Hermes sidecar 这条主链路闭环到了可用状态：

- 本地服务在 `gateway/`
- Hermes Rust sidecar 源码在 `research/hermes-rs/`
- 已支持真实流式 `/v1/responses`
- 已支持 `/v1/files` 上传和 artifact 下载
- `make publish-hermes-sidecar`
- `make start-agent-sidecar-server`
- `make e2e-agent-sidecar`

都已经打通过。

当前运行形态不是“模型直接在 wrapper 进程里工作”，而是：

1. Go wrapper 接 OpenAI 风格请求。
2. wrapper 创建外层 AGS sandbox。
3. 外层 sandbox 从 COS 下载并启动 Hermes Rust sidecar。
4. Hermes sidecar 在首次工具调用时，懒创建一个会话级 inner sandbox。
5. Hermes 整个会话都把这个 inner sandbox 当作工作区。
6. 长期记忆仍留在外层运行环境，不把 `MEMORY.md` / `USER.md` 同步到 inner sandbox。
7. sidecar 把 Hermes 内容流转成事件，wrapper 再转成 OpenAI SSE：`response.created` -> `response.output_text.delta` -> `response.output_text.done` -> `response.completed`。

这部分已经有真实 E2E 验证，不是纸面设计。

## 当前已知事实

### wrapper 当前实际暴露的接口

`gateway/internal/wrapper/server.go` 当前只注册了这些路由：

- `POST /v1/files`
- `GET /v1/files/:id/content`
- `POST /v1/responses`
- `GET /v1/responses/:id`

没有：

- `GET /v1/models`
- `GET /v1/files/:id`
- `GET /v1/files`
- `DELETE /v1/files/:id`
- `DELETE /v1/responses/:id`
- 其他 OpenAI 平台兼容接口

### wrapper 当前的身份模型

`gateway/internal/wrapper/identity.go` 现在要求：

- `X-Tenant-ID`
- `X-Project-ID`

否则直接 401。

也就是说，当前不是标准 OpenAI 风格的：

- `Authorization: Bearer <api_key>`

这对 CLI/curl 没问题，因为我们自己知道要加哪些 header；但对通用前端会是第一兼容点。

### wrapper 当前不支持会话续接

`gateway/internal/wrapper/server.go` 里明确写死：

- 如果请求里带 `previous_response_id`
- 直接报 `unsupported_field`

而 LibreChat 对 Responses API 的一个核心价值，就是它本身理解 `previous_response_id` 和基于 Responses 的多轮对话。

### wrapper 当前已有的能力

虽然平台面不完整，但核心能力已经存在：

- 流式聊天
- 工具调用
- 上传文件给模型使用
- 产物 artifact 回传并下载
- Hermes sidecar 全链路 timing / timeline 打点
- `make e2e-agent-sidecar` 全量回归

### 当前性能基线

见 `gateway/README.md`：

- 非流式总耗时基线：纯聊约 `3.83s`
- terminal 工具约 `7.43s`
- 上传文件 + 读取 + artifact 下载约 `7.32s`
- 流式首个 `response.output_text.delta`：短纯聊约 `5.73s`
- terminal 工具首个可见 delta 约 `6.06s`

这些值要继续保留，后续接 LibreChat 不能把链路能力破坏掉。

## 为什么现在要做 LibreChat

目标不是再写一个前端，而是找一个现成的 Web 客户端，尽量不改它的源码，直接和我们本地 OpenAI 兼容服务一起运行。

之前已经看过几类项目：

- NextChat：主路径更偏 `chat/completions`，不适合原生 `/v1/responses`
- Open WebUI：可以接 OpenAI-compatible upstream，但产品路径更偏它自己的后端和 `/api/chat/completions`
- LibreChat：在现成开源前端里，对 OpenAI Responses API 的原生支持最强，最值得优先尝试

所以当前方向是：

- 不改 LibreChat 源码
- 评估并尽量实现“LibreChat + 本地 gateway”一起跑
- 如果有必要，只改我们自己的 wrapper/部署方式，不碰 LibreChat 源代码

## 核心判断

### 判断 1：LibreChat 是当前最值得优先验证的前端

原因：

- 它明确支持 OpenAI Responses API
- 它理解 `previous_response_id`
- 它有 streaming delta 相关处理
- 它也覆盖文件/附件能力
- 它支持 custom endpoint，而不是一定要走它自家代理模型体系

### 判断 2：现在不是“零改动就一定能联通”

当前 wrapper 还不是一个足够完整的 OpenAI 平台兼容层。最大概率的阻塞点有 4 个：

1. 缺 `GET /v1/models`
2. 鉴权模型不是 `Authorization: Bearer`
3. 不支持 `previous_response_id`
4. 文件接口可能还不够全

### 判断 3：最优策略不是改 LibreChat，而是补 wrapper 的 OpenAI 兼容面

因为：

- wrapper 本来就定位成 OpenAI-compatible
- 给 wrapper 补 OpenAI 兼容，比定制 LibreChat 更长期、更干净
- 后面不止 LibreChat，别的前端/SDK/工具也会因此直接受益

## 大方向思路

目标分两层：

### 第一层：先做到“能接起来”

最小目标：

- LibreChat 能列出模型
- 能选择我们的模型
- 能发起 Responses 对话
- 能看到流式返回
- 能继续多轮对话

这要求至少补齐：

- `GET /v1/models`
- 标准 Bearer 鉴权兼容，或者一个不侵入 LibreChat 的 header 注入方案
- `previous_response_id`

### 第二层：再做到“完整闭环”

完整目标：

- 文件上传可用
- artifact 下载可用或至少可被用户访问
- 流式聊天可稳定
- 工具调用可用
- 时间线打点仍可观测
- README / TODO / 启动脚本完整

## 推荐实施顺序

### 第 0 步：不要急着写代码，先把 LibreChat 的真实请求面跑清楚

建议先 clone LibreChat 到 `research/LibreChat`，但不要改源码。

先确认这些事：

- 它在 custom endpoint + OpenAI Responses 模式下，启动时会请求哪些接口
- 是否强依赖 `GET /v1/models`
- 创建消息时到底打的是 `/v1/responses` 还是它自己 server 代理路径
- 文件上传是否打 `POST /v1/files`
- 下载文件时是否要求 `GET /v1/files/:id`
- 鉴权 header 是否只能是 `Authorization: Bearer`，还是能自定义额外 header
- 它是否会强依赖 `previous_response_id`

这里的关键不是读 README 猜，而是把真实 HTTP 请求抓出来。

建议：

- 先让 LibreChat 指向一个可观测代理或者本地 mock
- 把它启动后的所有上游请求路径、header、body 记下来

如果这一步不做，后面很容易瞎补接口。

## 明确的 TODO 清单

### A. 先做 LibreChat 侧兼容性摸底

- [ ] 在 `research/` 下 clone LibreChat，保持源码只读，不改业务代码。
- [ ] 跑起 LibreChat 的最小本地环境，确认它支持自定义 OpenAI endpoint 的配置入口。
- [ ] 抓取它面对上游 OpenAI-compatible 服务时的真实请求。
- [ ] 记录最小必需接口集合。
- [ ] 输出一份“LibreChat 真实依赖的 API contract”。

交付物建议：

- `research/librechat-notes.md` 或类似文档
- 列清楚请求顺序、header、字段、是否要求 SSE、是否要求 `previous_response_id`

### B. 给 wrapper 补最小 OpenAI 平台兼容面

#### B1. `GET /v1/models`

大概率这是第一个阻塞点。

当前没有模型列表接口，前端通常在初始化模型选择器时就会失败。

建议做法：

- [ ] 在 wrapper 增加 `GET /v1/models`
- [ ] 先返回静态模型列表，不要一开始搞成复杂的动态注册系统
- [ ] 至少包含我们现在真实可用的模型 id

建议先暴露这些 model id：

- `agent-sidecar-chat`
- `agent-sidecar-tool`
- `agent-sidecar-e2e`
- `agent-sidecar-e2e-file`

也可以收敛成更产品化的一组，比如：

- `agent-sidecar-chat`
- `agent-sidecar-tool`

但要注意和现有 README / e2e / curl 示例一致，避免前端能选的模型和服务真实识别的模型不一致。

注意：

- 这个接口不应该触发 AGS / Hermes，只是静态元数据返回
- 应补测试

#### B2. 标准鉴权兼容

这是第二个高风险点。

当前 wrapper 必须要：

- `X-Tenant-ID`
- `X-Project-ID`

而通用 OpenAI 前端一般只会发：

- `Authorization: Bearer ...`

可选策略有三种：

方案 A，推荐：wrapper 同时兼容 Bearer 和当前租户头。

思路：

- 若请求里已有 `X-Tenant-ID` + `X-Project-ID`，继续按现有逻辑
- 若只有 `Authorization: Bearer <token>`，则从 env 做默认租户映射

例如新增配置：

- `GATEWAY_DEFAULT_TENANT_ID`
- `GATEWAY_DEFAULT_PROJECT_ID`

这样前端只带 Bearer 也能过，服务端把它落到默认租户/项目。

方案 B：用一个反向代理把 Bearer 改写成 `X-Tenant-ID/X-Project-ID`。

问题：

- 多一层部署复杂度
- 不是产品内建能力
- 对另一个 Agent 来说不是最优长期方案

方案 C：要求 LibreChat 自定义 header。

问题：

- 不确定能否无代码改动做到
- 即便可以，也比服务端兼容 Bearer 差

结论：

- 优先做方案 A

注意点：

- Bearer token 在这里不一定要做强安全校验，当前可以先作为“存在即允许”的接入 token，占位即可
- 但至少要定义清楚策略，不要混成一堆 if/else
- 如果后面要严格鉴权，再把 Bearer token 绑定到 tenant/project 映射表

#### B3. 支持 `previous_response_id`

这是第三个关键点。

LibreChat 如果真的走原生 Responses 多轮，很可能会发 `previous_response_id`。

当前 wrapper 直接拒绝这个字段，这会导致：

- 首轮也许能聊
- 第二轮大概率直接挂

推荐实现思路：

- [ ] 接受 `previous_response_id`
- [ ] 根据之前的 response record，取出其 scope 和历史输出
- [ ] 把“上一轮输出”或“历史链”拼回本轮 instruction/input

但这里有一个要先想清楚的问题：

OpenAI Responses API 的 `previous_response_id` 是服务端状态续接语义，不等于简单把上一轮文本拼进去。

我们的实现可以先做一个务实版：

1. 找到上一轮 response
2. 校验 scope 一致
3. 取上一轮及必要历史的 `output_text`
4. 按固定模板拼接进当前 instruction

比如：

- system/instructions 保持原样
- 把 history 作为 wrapper 注入的上下文块，明确分隔

但别一上来就无限递归追整个链；建议先做一个有边界的实现：

- 最多回溯 N 轮
- 或者只支持最近一轮

第一阶段建议：

- 只支持单链、最近若干轮文本回放
- 不追求 100% 复刻 OpenAI 的服务端会话语义
- 目标是让 LibreChat 多轮能正常用起来

同时需要明确：

- response record 里可能需要存 `PreviousResponseID`
- 可能需要额外存序列化过的“输入文本快照”，否则后续回放信息不够

当前 `ResponseRecord` 只存：

- `model`
- `output_text`
- `output`
- `artifact_file_ids`
- `status`

这可能不足以优雅支持续接，因此大概率需要扩展 store 模型。

#### B4. 文件接口补齐

目前已有：

- `POST /v1/files`
- `GET /v1/files/:id/content`

但前端经常还会要求：

- `GET /v1/files/:id`
- 甚至 `GET /v1/files`

建议在实际抓包后决定。

优先级判断：

- 如果 LibreChat 上传后只把 `file_id` 回塞到 `/v1/responses`，那现在接口可能已够
- 如果它要回查文件元数据，那就必须补 `GET /v1/files/:id`
- 如果它要列文件，再补 `GET /v1/files`

建议顺序：

1. 先补 `GET /v1/files/:id`
2. 看抓包结果再决定是否需要 `GET /v1/files`

### C. 验证 Responses streaming 真实兼容性

虽然 wrapper 自己已经流式可用，但还要验证 LibreChat 是否接受我们当前的 SSE 事件形式。

要核对：

- `response.created`
- `response.output_text.delta`
- `response.output_text.done`
- `response.completed`
- `error`

是否和 LibreChat 预期一致。

这里不要只看“前端页面有没有字”，要抓网络确认：

- SSE 事件名是否一致
- 字段名是否一致
- `response_id` / `text` / `artifact_file_ids` 是否在正确事件里

如果有不兼容：

- 优先调整 wrapper 输出形状
- 不改 LibreChat

### D. 文件上传、工具、artifact 全链路实测

在“能聊天”之后，必须继续验证这 3 条：

- [ ] 纯聊天
- [ ] 需要 terminal 工具的请求
- [ ] 文件上传 + 模型读取 + artifact 下载

原因很简单：

- 聊天通了不代表工具链通了
- Responses 通了不代表文件通了
- 文件上传通了不代表 artifact 在前端里能正确使用

建议把验证拆成 4 级：

1. curl 级别验证
2. LibreChat UI 级别验证
3. 日志 / timeline 级别验证
4. 失败场景验证

失败场景至少要看：

- 错误是否能在前端可见
- wrapper 是否返回合理 error payload
- sidecar / inner sandbox 是否正确清理

## 对另一个 Agent 的明确实现建议

### 建议优先改的文件

在 wrapper 侧，高概率要改：

- `gateway/internal/wrapper/server.go`
- `gateway/internal/wrapper/identity.go`
- `gateway/internal/wrapper/models.go`
- `gateway/internal/wrapper/store.go`
- `gateway/internal/wrapper/server_test.go`
- `gateway/README.md`
- 根目录 `README.md`

如果要加配置，可能还要看：

- `gateway/cmd/server/main.go`
- `gateway/scripts/start_agent_sidecar_server.sh`
- `gateway/scripts/e2e_agent_sidecar.sh`

### 一个务实的实现切法

#### 切片 1：补 `/v1/models`

目标：

- 让前端至少能列模型

交付标准：

- curl `GET /v1/models` 返回 OpenAI 风格 JSON
- 有单测
- 不影响现有 e2e

#### 切片 2：兼容 Bearer 鉴权 + 默认租户

目标：

- LibreChat 不用发 `X-Tenant-ID` / `X-Project-ID` 也能打进来

交付标准：

- 仍兼容旧 header 模式
- Bearer-only 模式可用
- 有单测覆盖 header 优先级

推荐优先级逻辑：

1. 若有 `X-Tenant-ID` / `X-Project-ID`，用它们
2. 否则若有 `Authorization: Bearer ...`，用默认 tenant/project
3. 否则报错

#### 切片 3：最小支持 `previous_response_id`

目标：

- 至少支持多轮

交付标准：

- 第二轮请求不再因 `unsupported_field` 失败
- 能正确续接最近一轮上下文
- 有单测

这里需要非常注意 scope 校验：

- 不允许跨租户/跨项目引用旧 response

#### 切片 4：按抓包结果补文件元数据接口

目标：

- 让文件/附件在 LibreChat 里能正常走通

可能需要：

- `GET /v1/files/:id`
- `GET /v1/files`

#### 切片 5：实跑 LibreChat 联调

目标：

- 不改 LibreChat 源码的前提下，完整验证一遍

交付标准：

- 模型列表正常
- 对话正常
- 流式正常
- 多轮正常
- 文件上传正常
- 至少一个工具请求正常

## OpenAI 兼容层的设计建议

### `/v1/models` 返回形状

建议尽量贴 OpenAI 常见格式，例如：

```json
{
  "object": "list",
  "data": [
    {
      "id": "agent-sidecar-chat",
      "object": "model",
      "created": 0,
      "owned_by": "gateway"
    }
  ]
}
```

不要在这个阶段加太多私货字段。

### Bearer 兼容策略

建议设计成“兼容层”而不是“替换层”：

- 老的租户头继续可用
- 新的 Bearer 接入也可用

这样不会破坏现有 curl、e2e 和脚本。

### `previous_response_id` 的实现边界

建议先明确这是“务实兼容版”，不是完整 OpenAI 状态机复刻。

阶段 1 目标：

- 让前端多轮能工作
- 保持 scope 安全
- 不让 store 结构失控

阶段 2 如果有需要，再进一步：

- 完整链式回溯
- 更精细的 input/output 存档
- 更接近 OpenAI Responses 的服务端状态语义

## 不要做的事

- [ ] 不要改 LibreChat 业务源码
- [ ] 不要为了前端兼容去破坏现有 Hermes sidecar e2e
- [ ] 不要把长期记忆文件硬塞进 inner sandbox
- [ ] 不要为了偷懒把所有请求都降级成 chat completions
- [ ] 不要假装支持 `previous_response_id`，但实际上完全忽略它

## 验证清单

### 基础 API 级

- [ ] `GET /v1/models` 正常
- [ ] `POST /v1/responses` 非流式正常
- [ ] `POST /v1/responses` 流式正常
- [ ] `GET /v1/responses/:id` 正常
- [ ] `POST /v1/files` 正常
- [ ] `GET /v1/files/:id/content` 正常
- [ ] 如有新增：`GET /v1/files/:id` 正常

### 行为级

- [ ] 纯聊天不创建 inner sandbox
- [ ] 工具请求会创建 inner sandbox
- [ ] 文件请求能让 Agent 读到上传内容
- [ ] artifact 能下载

### 前端集成级

- [ ] LibreChat 能配置到本地 wrapper
- [ ] 模型下拉正常显示
- [ ] 首轮对话正常
- [ ] 第二轮对话正常
- [ ] 流式展示正常
- [ ] 文件上传正常
- [ ] 错误能在 UI 中正确显示

### 回归级

- [ ] `make e2e-agent-sidecar` 仍然全绿
- [ ] 现有 curl 示例仍然可用
- [ ] README 没有失真

## 建议新增的文档

完成实现后，至少要补这些文档：

- 根目录 `README.md` 增加“可接入 LibreChat”入口说明
- `gateway/README.md` 增加：
  - LibreChat 接入前提
  - 鉴权方式
  - 必需环境变量
  - 手动联调步骤
  - 已知限制
- 如有必要，单独加 `gateway/docs/librechat.md`

## 可能的技术风险

### 风险 1：LibreChat 其实并不直接打外部 `/v1/responses`

如果它虽然支持 Responses，但实际产品路径还是通过它自己的 server 做中转，那就要区分：

- 是让 LibreChat server 当代理去连 wrapper
- 还是让浏览器直接打 wrapper

这两种部署方式对鉴权和 CORS 要求不同。

### 风险 2：它要求的文件接口比预期更多

这不难修，但要真实抓包后再补。

### 风险 3：`previous_response_id` 兼容实现太弱，导致多轮体验怪

如果只拼上一轮文本，有可能够用，也有可能在复杂工具对话里不够。

所以第一版上线后要立刻做多轮压力验证，不要只测两句闲聊。

### 风险 4：前端把 Bearer 当作真正 API key 管理，而我们这里只是默认租户映射

这会影响后续多租户产品化设计。

第一版可以接受，但文档里要写清楚当前语义，避免误会成真正按 token 隔离。

## 推荐的第一阶段交付目标

另一个 Agent 如果只做第一阶段，我建议把目标压缩成：

1. clone 并跑起 LibreChat，不改源码
2. 抓清它对上游的真实请求面
3. 在 wrapper 增加 `/v1/models`
4. 在 wrapper 增加 Bearer + 默认 tenant/project 兼容
5. 在 wrapper 最小支持 `previous_response_id`
6. 用 LibreChat 实测首轮、多轮、流式
7. 保证 `make e2e-agent-sidecar` 不回归

做到这一步，就已经足够判断“LibreChat 能否和当前本地 OpenAI 兼容服务一起运行”。

## 如果时间够，再做第二阶段

- [ ] 补文件元数据接口
- [ ] 完整验证文件上传
- [ ] 验证 artifact 在前端里的使用方式
- [ ] 增加更细 timeline 打点，区分前端多轮续接请求
- [ ] 把 LibreChat 接入方式写进 README

## 最后一句话的方向判断

这件事不该通过修改 LibreChat 来完成，而应该通过把 `gateway` 补成一个更完整的 OpenAI Responses 兼容层来完成。这样做，既能接 LibreChat，也能顺手提升整个服务的通用性。
