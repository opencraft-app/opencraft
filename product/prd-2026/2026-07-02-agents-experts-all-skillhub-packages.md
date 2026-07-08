# /agents/experts 展示 SkillHub 全量技能包

## 需求澄清摘要

- 已确认：
  - SkillHub API 已经能返回更多 skill 技能包。
  - LightVela 当前 `/agents/experts` 页面没有把这些新增技能包都展示出来。
  - 本次目标是让 `/agents/experts` 支持展示 SkillHub 新增的全部技能包。
  - 拉取数据优先直接使用 SkillHub 现有接口，不新增后端聚合接口。
- 默认假设：
  - SkillHub 的 `/api/v1/skillsets` 是本需求的技能包列表事实源。
  - 已有 11 个专家分类的视觉、文案和安装链路继续保留。
  - 新增 scene 或暂未配置前端展示元信息的技能包，不能再被前端过滤掉，应使用兜底分类和兜底展示样式。
- 待确认：
  - 新增 scene 是按接口动态展示成筛选项，还是统一收敛到“更多/其他”筛选项。
  - 是否需要在本次同步补齐 `content-creation`、`lifestyle`、`mysticism` 的正式中文分类名和图标。
  - 是否需要补充运营侧排序规则，还是继续使用 SkillHub 接口返回顺序。
- 本轮先按什么范围出稿：
  - 先按“前端读取 SkillHub 全量 skillsets，取消旧 scene 白名单过滤，并为未知 scene 提供兜底展示”的标准需求出稿；不创建 TAPD。

## 来源

- 需求来源：用户反馈 `/agents/experts` 没展示 SkillHub 新增技能包。
- 相关链接：
  - TAPD 需求单：https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091135733988
  - 页面入口：`/agents/experts`
  - SkillHub API：`https://api.skillhub.cn/api/v1/skillsets`
  - 当前实现：`frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`
  - API 客户端：`frontend/src/lib/skillhub-api.ts`
- 提出人/干系人：LightVela 产品与 SkillHub 技能包维护方。

## 背景与问题

- 当前用户怎么做：
  - 用户进入 `/agents/experts` 浏览专家技能包，按分类筛选、搜索、查看详情，并安装技能包内的 skills。
- 现在卡在哪里：
  - SkillHub 已经返回更多技能包，但 LightVela 页面只展示前端硬编码支持的 scene。
  - 当前 `EXPERT_SCENES` 只包含 `finance`、`tech`、`design`、`marketing`、`legal`、`academic`、`education`、`hr`、`ecommerce`、`media`、`healthcare`。
  - 当前 `isSupportedExpertPackage` 会过滤掉不在 `EXPERT_SCENE_MAP` 里的技能包，导致新增 scene 的技能包无法出现在页面。
  - 当前 `SkillHubSkillSetScene` 类型也被收窄到旧 scene 集合，不利于承接 SkillHub 后续新增分类。
  - 当前“全部”列表的 total 使用当前页过滤后的数量，未知 scene 被过滤后会进一步影响继续加载判断。
- 为什么现在要做：
  - SkillHub 已经扩充技能包供给，LightVela 展示层不应成为新增内容上线的阻塞点。
  - 技能包增加后，如果每新增一个 scene 都要改 LightVela 前端配置，会拖慢 SkillHub 内容发布效率。
  - 用户在 LightVela 里看不到 SkillHub 已上线内容，会误以为技能包缺失或安装能力不可用。

## 当前调研结论

- 2026-07-02 直接请求 `https://api.skillhub.cn/api/v1/skillsets?page=1&pageSize=100`：
  - 返回 `total = 71`，本页 `skillSets = 71`。
  - 返回 scene 包含 `academic`、`content-creation`、`design`、`ecommerce`、`education`、`finance`、`healthcare`、`hr`、`legal`、`lifestyle`、`marketing`、`media`、`mysticism`、`tech`。
  - 样例新增技能包包括 `mysticism-ziwei-doushu`、`mysticism-yijing-divination`、`mysticism-lunar-almanac`。
- LightVela 当前代码会把 `content-creation`、`lifestyle`、`mysticism` 这类前端未知 scene 过滤掉。

## 目标用户与场景

- 目标用户：
  - 在 LightVela 中为 Agent 查找、理解和安装技能包的用户。
  - 负责在 SkillHub 上架技能包的内容运营或技能包维护者。
- 典型场景：
  - 用户进入 `/agents/experts` 的“全部”页，希望看到 SkillHub 已上线的全部专家技能包。
  - 用户搜索某个新技能包，例如紫微斗数、易经起卦、生活方式、内容创作相关技能包，希望能直接找到并安装。
  - SkillHub 新增一个 scene 后，LightVela 无需发版配置白名单，也能先以兜底样式展示。
- 频率和重要性：
  - 浏览和安装技能包是 `/agents/experts` 的主路径。
  - 该需求影响 SkillHub 新内容在 LightVela 的可见性和上架效率。

## 目标

- 用户结果：
  - 用户可以在 `/agents/experts` 看到 SkillHub 已返回的全部有效技能包，包括新 scene 下的技能包。
  - 用户可以搜索、查看详情并安装新增技能包，体验与已有技能包一致。
- 产品结果：
  - LightVela 对 SkillHub 新增技能包具备前向兼容能力。
  - SkillHub 增加普通 skillset 内容时，不需要 LightVela 每次同步改白名单才可展示。
- 不做会怎样：
  - 新技能包持续被隐藏，LightVela 展示内容和 SkillHub 实际内容不一致。
  - 内容运营新增技能包后仍需要前端改动，发布链路变重。

## 范围

- 本次包含：
  - `/agents/experts` 列表直接拉取 SkillHub skillsets，并展示接口返回的全部有效技能包。
  - 移除或放宽只允许旧 scene 的过滤逻辑。
  - 将 skillset 的 `scene` 数据模型调整为可承接任意字符串，并保留已知 scene 的强类型展示配置。
  - 为未知 scene 或未配置 scene 展示元信息的技能包提供兜底分类、图标、角色文案和卡片样式。
  - 修正“全部”列表分页和 total 判断，避免因为前端过滤导致无法继续加载。
  - 搜索时覆盖所有 SkillHub 返回的技能包，不因 scene 未配置而丢失结果。
  - 详情抽屉、skill 列表解析、安装流程沿用现有能力。
  - 增加前端测试或 mock case，覆盖未知 scene 技能包展示。
- 本次不包含：
  - 不改 SkillHub API 契约。
  - 不新增 LightVela 后端代理或缓存层，除非后续发现 CORS、鉴权或性能问题。
  - 不重做 `/agents/experts` 的整体信息架构和视觉风格。
  - 不新增技能包审核、排序配置、推荐算法、运营后台。
  - 不改变 `acli skills install` 和 Hermes 已安装状态判断逻辑。
- 已知依赖：
  - SkillHub `/api/v1/skillsets` 返回稳定的 `slug`、`displayName`、`summary`、`scene`、`subScene`、`skillSlugs` 或详情数据。
  - SkillHub 接口继续允许 LightVela 域名访问。

## LightVela 影响面

- 前端页面/路由：
  - 影响 `/agents/experts` 页面。
  - 重点文件包括 `frontend/src/pages/marketing/hermes-agent-experts-panel.tsx`、`frontend/src/lib/skillhub-api.ts`。
- Hermes Agent/运行时：
  - 不改变 Hermes Agent 运行时能力。
  - 安装仍通过现有 debug command 和 `acli skills install` 执行。
- SkillHub 底层 API/MCP/工具：
  - 继续读取 SkillHub 公共 `skillsets` 接口。
  - 不要求 SkillHub 为本次新增接口。
- SDK/文档/运营：
  - 运营侧需要知道：新增普通技能包后，只要 SkillHub 接口返回，LightVela 应能兜底展示。
  - 若需要正式分类名、图标或排序，仍可后续补前端展示配置。
- 权限/安全/数据：
  - 本需求只读取公共 SkillHub 数据，不新增用户私有数据读取。
  - 不改变安装命令的执行权限边界。

## 方案

- 交互或流程：
  - 用户进入 `/agents/experts` 后，“全部”列表展示 SkillHub 返回的全部有效技能包。
  - 已知 scene 继续显示现有中文分类、图标和角色文案。
  - 未知 scene 的技能包在卡片、列表和详情中使用兜底文案，例如“技能包”或由 scene/subScene 派生的可读分类名。
  - 筛选区域保留“全部”和现有已知分类；新增 scene 的筛选呈现方式有两种待定：
    - 方案 A：根据接口返回 scene 动态补充筛选项，未知 scene 使用格式化名称。
    - 方案 B：未知 scene 统一进入“更多/其他”筛选项，降低导航复杂度。
- 状态变化：
  - 加载中、错误、空态保持现有交互。
  - 当 SkillHub 返回未知 scene 时不进入错误态，也不隐藏该技能包。
  - 当某个技能包缺少 summary 时，继续使用现有兜底摘要。
- 数据或接口：
  - `fetchSkillSets({ page, pageSize, keyword })` 的“全部”请求不传 scene。
  - scene 类型从固定 union 调整为字符串兼容模型，例如保留已知 scene union 用于展示配置，但接口响应的 `scene` 不应只允许这些值。
  - 列表 total 优先使用 SkillHub 返回的 `total`；如果前端仍有过滤逻辑，只允许过滤无效数据，不允许过滤未知 scene。
  - 详情继续使用 `fetchSkillSetDetail(slug)` 获取 skill slugs 和 content。
- 异常和空态：
  - SkillHub 接口失败：沿用“无法连接 SkillHub，请稍后重试”。
  - SkillHub 返回空列表：展示现有空态。
  - 单个技能包 scene 未知或为空：展示兜底图标和“技能包”角色，不阻断列表展示。
  - 单个技能包详情缺失 skill slugs：沿用现有安装失败或不可安装提示，不在本需求扩大处理。

## 产品原型说明

- 目标页面/入口：`/agents/experts`
- 用户主路径：
  - 进入页面 -> 查看“全部”技能包 -> 搜索或筛选 -> 打开技能包详情 -> 安装技能包。
- 页面结构：
  - 保持当前顶部搜索、分类筛选、视图切换、列表/卡片、详情抽屉结构。
- 关键组件：
  - 分类筛选栏：需要决定未知 scene 动态展示还是归入“更多/其他”。
  - 技能包卡片/列表项：需要未知 scene 的兜底图标和角色文案。
  - 详情抽屉：需要未知 scene 的兜底角色文案。
- 状态：加载 / 空态 / 错误 / 禁用 / 权限不足
  - 加载、空态、错误沿用现有状态。
  - 未知 scene 不是异常状态。
  - 安装按钮禁用、安装中、已安装状态沿用现有状态。
- 主要操作：
  - 搜索、筛选、切换列表/卡片、打开详情、安装技能包。
- 需要设计确认：
  - 未知 scene 是动态展示为新筛选项，还是归为“更多/其他”。
  - `content-creation`、`lifestyle`、`mysticism` 是否需要正式中文名和专属图标。
- 需要前端确认：
  - 动态筛选项是否只基于当前页数据，还是需要全量 scene 元信息。
  - 搜索和分页在 scene 动态增加后的状态重置规则。

## 验收标准

- 验收 1：
  - 当 SkillHub `/api/v1/skillsets` 返回 `mysticism-ziwei-doushu`、`mysticism-yijing-divination` 等未知 scene 技能包时，它们能出现在 `/agents/experts` 的“全部”列表中。
- 验收 2：
  - 未知 scene 技能包不会被 `isSupportedExpertPackage` 或等价逻辑过滤掉；页面不会因为未知 scene 报错。
- 验收 3：
  - 搜索未知 scene 技能包名称或 slug 相关关键词时，页面能展示匹配结果。
- 验收 4：
  - 已有 11 个已知 scene 的中文分类、图标、角色文案和安装链路不回退。
- 验收 5：
  - “全部”列表的继续加载判断基于 SkillHub total 或等价可靠数据，不再使用当前页过滤后数量作为全部 total。
- 验收 6：
  - 打开未知 scene 技能包详情后，可以看到标题、摘要、技能列表或详情内容，并能沿用现有安装流程。
- 验收 7：
  - 前端测试或 mock 数据覆盖至少一个未知 scene，例如 `mysticism`，证明该技能包能展示、打开详情，并不影响已知 scene。

## 发布与观测

- 灰度/开关：
  - 建议作为前端普通功能发布；如担心未知内容质量，可增加轻量开关控制是否展示未知 scene。
- 日志/埋点/指标：
  - 建议观察 `/agents/experts` 列表加载成功率、SkillHub 请求失败率、技能包详情打开量、安装点击量和安装成功率。
  - 可增加按 scene 维度的曝光和安装统计，帮助判断新增 scene 的使用情况。
- 回滚：
  - 如果未知 scene 展示造成内容质量或合规问题，可临时关闭未知 scene 展示开关，或回滚前端改动。
  - 已知 scene 展示和安装链路应保持可独立回归。

## 研发交接建议

- 前端关注点：
  - 放宽 `SkillHubSkillSet.scene` 类型，拆分“接口 scene 字符串”和“已知展示配置 scene”。
  - 删除或调整未知 scene 过滤逻辑。
  - 修正 total 和 hasMore 计算。
  - 增加未知 scene 的卡片、列表、详情兜底展示。
  - 增加 mock 测试覆盖 SkillHub 新 scene。
- 后端/运行时关注点：
  - 本轮暂无后端或 Hermes 运行时改动。
- Skill/内容/文档关注点：
  - SkillHub 内容侧可继续新增技能包；若需要更好展示效果，补充 scene 展示名、图标和排序规则。
- QA/发布/运营关注点：
  - 用真实接口或 mock 数据验证 `content-creation`、`lifestyle`、`mysticism` 等新 scene。
  - 验证已知 scene、搜索、详情、安装、分页加载均无回退。
- 建议研发自行创建的独立技术需求单：
  - 标题：`[前端] /agents/experts 展示 SkillHub 全量技能包`
  - 范围：前端类型、列表拉取、筛选展示、兜底样式、分页和测试。
  - 依赖：SkillHub `skillsets` 公共接口稳定返回。
  - 验收：以本 PRD 验收标准为准。

## 待确认问题

- 问题 1：未知 scene 的筛选入口采用动态补充，还是统一放入“更多/其他”？
- 问题 2：是否本次就补齐 `content-creation`、`lifestyle`、`mysticism` 的中文名、图标和角色文案？
- 问题 3：SkillHub 是否会提供 scene 元信息接口，例如 scene 展示名、排序、图标 key？如果没有，LightVela 先用前端兜底。
- 问题 4：是否需要对未知 scene 做内容安全或运营审核开关？
