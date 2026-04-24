# 语义缓存设计文档

## 背景

AI Gateway 每次代理请求都转发到上游 LLM 提供商，产生 token 费用。在生产环境中，个性化对话为主的流量特征下，相同语义的请求（如"翻译这段话"、"解释这个概念"）会被重复调用不同提供商，浪费大量 token。

**目标**：通过语义缓存，将语义相似的请求映射到已有响应，命中时直接返回且不计费，显著降低 token 成本。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 缓存匹配 | 语义匹配（余弦相似度） | 个性化对话精确匹配命中率极低 |
| 向量存储 | PostgreSQL pgvector | 已有 PG 实例，无需新组件 |
| Embedding 模型 | text-embedding-3-small（1536 维） | 复用现有提供商，$0.02/1M tokens 成本极低 |
| 缓存隔离 | 默认按 user_id 隔离，可配置为 system_prompt_hash 或 global | 安全优先，管理员可按需放宽 |
| 计费策略 | 缓存命中不计费，但记录 usage_log（source=cache） | 用户省钱 + 保留审计能力 |
| 缓存文本 | system prompt + 最后一条 user message | 兼顾场景上下文和命中率 |
| 相似度阈值 | 0.95（运行时可调） | 高精度优先，避免语义偏差 |
| 默认 TTL | 1 小时（运行时可调） | 平衡新鲜度和命中率 |
| 流式写入 | 流式和非流式响应均写入缓存 | 避免只缓存非流式导致填充率过低 |
| 流式返回 | 缓存命中时模拟 SSE 流式返回 | 对客户端透明 |
| 缓存端点 | 仅 `/v1/chat/completions` | `/v1/completions`（legacy）和 `/v1/embeddings` 不缓存 |

## 架构

### 请求流

```
请求 → Auth → RateLimit → BillingCheck → ModelAuth
     → CacheMiddleware（仅 /v1/chat/completions）
       ├─ 提取 system + 最后一条 user message
       ├─ 调用 Embedding API（直连提供商，不经 Portkey）
       ├─ pgvector 余弦相似度搜索（阈值 0.95，按 model + scope_key 过滤）
       ├─ 命中 → 返回缓存响应 + X-Cache: HIT，跳过计费（记录 cache usage log）
       └─ 未命中 → X-Cache: MISS，传递 embedding 到 context，继续
     → ProxyHandler → Portkey Gateway → 上游 LLM
     → 成功响应后异步写入缓存（流式/非流式均写入）
```

### 缓存隔离策略

```go
type CacheScopeMode string
const (
    CacheScopeUser         CacheScopeMode = "user"           // 默认：按 user_id 隔离
    CacheScopeSystemPrompt CacheScopeMode = "system_prompt"  // 按 system_prompt_hash 隔离
    CacheScopeGlobal       CacheScopeMode = "global"         // 全局共享
)
```

- **user（默认）**：`scope_key = user_id`，每个用户独立缓存池，最安全
- **system_prompt**：`scope_key = SHA256(system_prompt)`，相同 system prompt = 同一应用场景，可共享
- **global**：`scope_key = "global"`，所有请求共享，命中率最高但需管理员明确开启

### 关键点

- Embedding API **直连提供商**（不走 Portkey 转发），避免循环依赖
- Embedding 调用失败时**降级跳过缓存**，不影响正常请求
- **流式和非流式响应均写入缓存**（流式在 handleStreaming 中收集完整响应后异步写入）
- 缓存命中时记录 `usage_log`（`source=cache`），保留审计能力，但不扣 token
- BillingCheck 在 CacheMiddleware 之前，**余额为零的用户无法使用缓存**（与正常请求行为一致）

## 数据库设计

### 前置条件

确认云端 PostgreSQL 支持 pgvector 扩展。如不支持，需联系云服务商开启或考虑自建 PG 实例。**这是实现的前提条件**。

### 迁移文件 `000010_response_cache.up.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE response_cache (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model             VARCHAR(64) NOT NULL,
    scope_key         VARCHAR(128) NOT NULL,       -- 隔离键（user_id / system_prompt_hash / "global"）
    content_hash      VARCHAR(64) NOT NULL,        -- SHA-256 去重
    embedding         vector(1536) NOT NULL,        -- embedding 向量
    response          BYTEA NOT NULL,               -- 完整响应体（gzip 压缩）
    prompt_tokens     INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    total_tokens      INT DEFAULT 0,
    hit_count         INT DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL,

    CONSTRAINT idx_cache_unique UNIQUE(model, scope_key, content_hash)
);

-- HNSW 向量索引（余弦相似度）
CREATE INDEX idx_cache_embedding ON response_cache
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_cache_expires ON response_cache(expires_at);
CREATE INDEX idx_cache_scope ON response_cache(model, scope_key);
```

### 向量搜索查询

先用 HNSW 索引取 Top-K 候选，再在应用层过滤阈值（HNSW 索引加速 ORDER BY，WHERE 条件的相似度过滤在应用层更高效）：

```sql
SELECT id, response, prompt_tokens, completion_tokens, total_tokens,
       1 - (embedding <=> $1) AS similarity
FROM response_cache
WHERE model = $2
  AND scope_key = $3
  AND expires_at > NOW()
ORDER BY embedding <=> $1
LIMIT 5;
```

应用层过滤：`similarity >= threshold`，取第一条。

## 后端组件

### 1. EmbeddingService (`internal/service/embedding_service.go`)

职责：调用提供商 Embedding API，将文本转为向量。

```go
type EmbeddingService struct {
    providerSvc *ProviderService
    httpClient  *http.Client
    // embedding 专用配置：独立于主提供商
    embeddingBaseURL string  // 如 "https://api.openai.com"
    embeddingAPIKey  string  // 独立的 API key
}

func (s *EmbeddingService) Embed(ctx context.Context, text string, model string) ([]float32, error)
```

- **独立配置** embedding 提供商的 base URL 和 API key（在 CacheConfig 中），不依赖主 ProviderService
- 这样 embedding 提供商挂了不影响主提供商，也避免了 embedding 调用消耗主提供商配额
- 失败返回 error，调用方降级处理

### 2. CacheService (`internal/service/cache_service.go`)

职责：缓存核心逻辑——搜索、存储、统计、配置。

```go
type CacheService struct {
    db          *gorm.DB
    redis       *redisclient.Client
    configStore *CacheConfigStore  // 独立的缓存配置存储
}

// 核心方法
func (s *CacheService) SearchSimilar(ctx, model, scopeKey, embedding, threshold) (*CachedResponse, float64, error)
func (s *CacheService) Store(ctx, params StoreParams) error
func (s *CacheService) IsEnabled() bool
func (s *CacheService) GetConfig() CacheConfig
func (s *CacheService) Stats(ctx) (*CacheStats, error)
func (s *CacheService) ClearAll(ctx) error
func (s *CacheService) ClearByScope(ctx, scopeKey) error
func (s *CacheService) RecordHit(tokensSaved int)
func (s *CacheService) RecordMiss()
func (s *CacheService) GetScopeKey(c *gin.Context) string  // 根据隔离模式计算 scope_key
```

### 3. CacheConfigStore (`internal/service/cache_config_store.go`)

独立的缓存配置存储（不复用 RuntimeConfigStore，因为现有 RuntimeConfigStore 是单 key 强类型设计）：

```go
const cacheConfigKey = "cache"

type CacheConfig struct {
    Enabled             bool           `json:"enabled"`               // 默认 true
    TTLSeconds          int            `json:"ttl_seconds"`           // 默认 3600
    SimilarityThreshold float64        `json:"similarity_threshold"`  // 默认 0.95
    MaxResponseBytes    int            `json:"max_response_bytes"`    // 默认 524288 (512KB)
    ScopeMode           CacheScopeMode `json:"scope_mode"`            // 默认 "user"
    MaxCacheEntries     int            `json:"max_cache_entries"`     // 默认 100000
    // Embedding 提供商独立配置
    EmbeddingModel      string `json:"embedding_model"`       // 默认 "text-embedding-3-small"
    EmbeddingBaseURL    string `json:"embedding_base_url"`    // 如 "https://api.openai.com"
    EmbeddingAPIKey     string `json:"embedding_api_key"`     // 独立 API key（加密存储）
}

type CacheConfigStore struct {
    mu     sync.RWMutex
    config CacheConfig
    repo   repository.RuntimeConfigRepo  // 复用 runtime_configs 表
}
```

### 4. CacheMiddleware (`internal/middleware/response_cache.go`)

职责：拦截 `/v1/chat/completions` 请求，查缓存，命中则直接返回。

逻辑流程：
1. 检查缓存开关（`IsEnabled()`）
2. 从 context 获取 `request_body` 和 `request_model`
3. 提取 system + 最后一条 user message
4. 计算 scope_key（根据隔离模式：user_id / system_prompt_hash / "global"）
5. 生成 content_hash = SHA-256(model + scope_key + cache_text)
6. 调用 EmbeddingService 获取向量（失败则降级跳过）
7. CacheService.SearchSimilar 查询
8. **命中**：返回缓存 + `X-Cache: HIT` + `X-Cache-Similarity`，记录 cache usage log，Abort
9. **未命中**：设置 `X-Cache: MISS`，将 embedding/content_hash/scope_key 存入 context，Next

### 5. CacheHandler (`internal/handler/cache_handler.go`)

Admin API：

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/admin/cache/config` | 获取缓存配置 |
| PUT | `/api/admin/cache/config` | 更新缓存配置（热更新） |
| GET | `/api/admin/cache/stats` | 缓存统计 |
| DELETE | `/api/admin/cache` | 清除全部缓存 |

### 6. ProxyHandler 修改 (`internal/handler/proxy.go`)

**handleNonStreaming**：成功返回后，检查 context 中的 `cache_embedding`，如果有则异步写入缓存。

**handleStreaming**：在流式传输过程中收集完整响应体（已有 usage 提取逻辑），完成后检查 context 中的 `cache_embedding`，异步写入缓存。缓存存储的是重组后的**非流式格式响应**（包含完整 choices + usage），命中时根据客户端请求的 stream 参数决定返回流式或非流式格式。

### 7. 路由注册 (`internal/router/router.go`)

- 创建 CacheConfigStore、EmbeddingService、CacheService
- **仅在 `/v1/chat/completions` 路由上** 添加 CacheMiddleware（不影响 completions 和 embeddings）
- admin 路由添加 CacheHandler

## 缓存统计

Redis 原子计数器：

| Key | 用途 |
|-----|------|
| `cache:stats:hits` | 总命中次数 |
| `cache:stats:misses` | 总未命中次数 |
| `cache:stats:tokens_saved` | 节省的总 token 数 |
| `cache:stats:hits:YYYY-MM-DD` | 按天命中（趋势图） |
| `cache:stats:misses:YYYY-MM-DD` | 按天未命中 |

Stats API 响应：

```json
{
    "total_hits": 12580,
    "total_misses": 45320,
    "hit_rate": 21.7,
    "tokens_saved": 8923400,
    "cache_entries": 3240,
    "today_hits": 580,
    "today_misses": 1920
}
```

## 缓存容量管理

- **max_cache_entries**：默认 100,000 条，超出时按 LRU（hit_count 最低 + created_at 最早）淘汰
- **max_response_bytes**：单条响应超过 512KB 不写入缓存
- **过期清理**：后台调度器（复用 `scheduler/` 模式）每小时执行 `DELETE FROM response_cache WHERE expires_at < NOW()`
- **容量淘汰**：当条目数超过 max_cache_entries 时，删除 hit_count 最低的 10% 条目

## Dashboard 前端

### 新增页面：`/cache`

文件：`gateway-dashboard/src/app/(dashboard)/cache/page.tsx`

页面结构：
1. **统计卡片区**：命中率、节省 Token、缓存条目数、今日命中
2. **配置管理区**：Card + Form
   - 开关、TTL、相似度阈值
   - 隔离模式选择（user / system_prompt / global）
   - 最大缓存条目数、最大响应大小
   - Embedding 配置（模型、Base URL、API Key）
3. **操作区**：清除全部缓存按钮（带确认对话框）

### 数据获取

文件：`gateway-dashboard/src/lib/queries/use-cache.ts`

```typescript
useCacheConfig()        // GET /api/admin/cache/config
useUpdateCacheConfig()  // PUT /api/admin/cache/config
useCacheStats()         // GET /api/admin/cache/stats（30s 自动刷新）
useClearCache()         // DELETE /api/admin/cache
```

### 导航

侧边栏添加"缓存管理"菜单项。

## 错误处理与降级

| 场景 | 处理方式 |
|------|----------|
| Embedding API 调用失败 | 跳过缓存，正常走 ProxyHandler，记录 warn 日志 |
| pgvector 查询失败 | 跳过缓存，正常走 ProxyHandler |
| 缓存写入失败 | 异步执行，不影响响应，记录 error 日志 |
| 响应体超过 max_response_bytes | 不写入缓存 |
| 缓存配置更新失败 | 返回错误，保持旧配置 |
| pgvector 扩展不可用 | 缓存功能自动禁用，记录 error 日志 |

## 成本分析

以 GPT-4o 为例：
- LLM 调用成本：$2.50/1M input tokens + $10.00/1M output tokens
- Embedding 成本：$0.02/1M tokens（**125 倍**便宜）
- 假设日均 10,000 请求，平均 500 tokens/请求
- 20% 命中率 → 省 2,000 次 LLM 调用
- 额外 embedding 成本：10,000 × 500 × $0.02/1M ≈ **$0.10/天**
- 节省 LLM 成本：2,000 × 500 × $2.50/1M ≈ **$2.50/天**（仅 input）
- **ROI ≈ 25 倍**

## 验证计划

1. **前置确认**：确认云端 PostgreSQL 支持 pgvector 扩展（阻塞项）
2. **单元测试**：embedding_service、cache_service、cache_config_store 核心逻辑
3. **集成测试**：发送语义相似请求，验证第二次返回 `X-Cache: HIT`
4. **计费验证**：缓存命中时 subscription token_balance 不变，usage_log 中有 source=cache 记录
5. **隔离验证**：user 模式下不同用户不会命中彼此的缓存
6. **降级测试**：模拟 embedding 失败，确认正常走 ProxyHandler
7. **流式缓存**：stream=true 的请求成功后写入缓存，后续相似请求能命中并以 SSE 格式返回
8. **Dashboard**：访问 `/cache` 页面，配置修改实时生效
9. **性能测试**：embedding API 调用 + pgvector 搜索总延迟（目标 < 200ms，含网络 RTT）
10. **容量测试**：缓存条目超过 max_cache_entries 时触发淘汰
