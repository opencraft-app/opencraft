# Middleware Context Helpers 重构计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `ratelimit.go` 中的 context helper 函数/常量（`ContextKey*`、`SetUserContext`、`GetUserFromContext`、`GetSubscriptionFromContext`、`GetPlanFromContext`）迁移到新文件 `context.go`，职责更清晰，代码更易维护。

**Architecture:** 将 context 相关的常量与 getter/setter 从限流逻辑中分离到独立文件。`ratelimit.go` 只保留 `RateLimiter` 函数。新增 `context_test.go` 对所有 context helper 进行直接单元测试（TDD 红色验证）。

**Tech Stack:** Go, `github.com/gin-gonic/gin`, `github.com/google/uuid`, `github.com/alicebob/miniredis/v2`（测试）

---

## Chunk 1: 准备阶段 — 确认无跨包直接引用

- [ ] **Step 1: 确认无跨包直接引用**

  用 Grep 确认所有调用方都在 `middleware` 包内（无需修改 import）：

  ```
  路径：ai-gateway/internal/middleware/
  搜索：middleware\.GetUserFromContext|middleware\.GetSubscriptionFromContext|middleware\.GetPlanFromContext|middleware\.SetUserContext|middleware\.ContextKey
  ```

  预期结果：只在 `handler/` 子目录（`user_self.go`、`proxy.go`）中有 `middleware.xxx` 前缀调用，这些调用在移动后**仍然指向 middleware 包，无需改动**。

- [ ] **Step 2: 确认编译基线**

  ```
  cd ai-gateway && go build ./...
  ```
  预期：exit 0

- [ ] **Step 3: 运行现有 middleware 测试**

  ```
  cd ai-gateway && go test ./internal/middleware/... -v -count=1
  ```
  预期：所有测试 PASS

---

## Chunk 2: TDD 阶段 — 写 context helper 测试

- [ ] **Step 1: 创建 `context_test.go`，写红色测试**

  文件：`ai-gateway/internal/middleware/context_test.go`

  ```go
  package middleware

  import (
    "net/http"
    "net/http/httptest"
    "testing"

    "git.woa.com/wisp/mono/ai-gateway/internal/model"
    "github.com/gin-gonic/gin"
    "github.com/google/uuid"
  )

  func setupContextTest() (*gin.Context, *httptest.ResponseRecorder) {
    gin.SetMode(gin.TestMode)
    w := httptest.NewRecorder()
    c, _ := gin.CreateTestContext(w)
    return c, w
  }

  func TestGetUserFromContext_ReturnsUser(t *testing.T) {
    c, _ := setupContextTest()
    user := &model.User{ID: uuid.New(), Status: "active"}
    SetUserContext(c, user, &model.Subscription{ID: uuid.New()}, &model.Plan{ID: uuid.New()})

    got := GetUserFromContext(c)
    if got == nil {
      t.Fatal("expected user, got nil")
    }
    if got.ID != user.ID {
      t.Errorf("expected user ID %s, got %s", user.ID, got.ID)
    }
  }

  func TestGetUserFromContext_ReturnsNilWhenNotSet(t *testing.T) {
    c, _ := setupContextTest()
    got := GetUserFromContext(c)
    if got != nil {
      t.Errorf("expected nil, got %v", got)
    }
  }

  func TestGetSubscriptionFromContext_ReturnsSub(t *testing.T) {
    c, _ := setupContextTest()
    sub := &model.Subscription{ID: uuid.New()}
    SetUserContext(c, &model.User{ID: uuid.New()}, sub, &model.Plan{ID: uuid.New()})

    got := GetSubscriptionFromContext(c)
    if got == nil {
      t.Fatal("expected sub, got nil")
    }
    if got.ID != sub.ID {
      t.Errorf("expected sub ID %s, got %s", sub.ID, got.ID)
    }
  }

  func TestGetSubscriptionFromContext_ReturnsNilWhenNotSet(t *testing.T) {
    c, _ := setupContextTest()
    got := GetSubscriptionFromContext(c)
    if got != nil {
      t.Errorf("expected nil, got %v", got)
    }
  }

  func TestGetPlanFromContext_ReturnsPlan(t *testing.T) {
    c, _ := setupContextTest()
    plan := &model.Plan{ID: uuid.New(), Name: "pro"}
    SetUserContext(c, &model.User{ID: uuid.New()}, &model.Subscription{ID: uuid.New()}, plan)

    got := GetPlanFromContext(c)
    if got == nil {
      t.Fatal("expected plan, got nil")
    }
    if got.Name != "pro" {
      t.Errorf("expected plan name 'pro', got %s", got.Name)
    }
  }

  func TestGetPlanFromContext_ReturnsNilWhenNotSet(t *testing.T) {
    c, _ := setupContextTest()
    got := GetPlanFromContext(c)
    if got != nil {
      t.Errorf("expected nil, got %v", got)
    }
  }

  func TestSetUserContext_SetsAllKeys(t *testing.T) {
    c, _ := setupContextTest()
    user := &model.User{ID: uuid.New()}
    sub := &model.Subscription{ID: uuid.New()}
    plan := &model.Plan{ID: uuid.New()}

    SetUserContext(c, user, sub, plan)

    if v, ok := c.Get(ContextKeyUser); !ok || v.(*model.User).ID != user.ID {
      t.Error("ContextKeyUser not set correctly")
    }
    if v, ok := c.Get(ContextKeySubscription); !ok || v.(*model.Subscription).ID != sub.ID {
      t.Error("ContextKeySubscription not set correctly")
    }
    if v, ok := c.Get(ContextKeyPlan); !ok || v.(*model.Plan).ID != plan.ID {
      t.Error("ContextKeyPlan not set correctly")
    }
  }
  ```

- [ ] **Step 2: 验证红色测试失败（因函数未在 context.go 中定义）**

  ```
  cd ai-gateway && go test ./internal/middleware/... -run "TestGetUserFromContext|TestGetSubscriptionFromContext|TestGetPlanFromContext|TestSetUserContext" -v -count=1 2>&1
  ```

  预期结果：编译错误 `undefined: GetUserFromContext` 或类似红色失败

---

## Chunk 3: 创建 context.go — 实现绿色代码

- [ ] **Step 1: 创建 `context.go`**

  文件：`ai-gateway/internal/middleware/context.go`

  ```go
  package middleware

  import (
    "git.woa.com/wisp/mono/ai-gateway/internal/model"
    "github.com/gin-gonic/gin"
  )

  // Context keys for user/subscription/plan data set by auth middleware.
  const (
    ContextKeyUser         = "gateway_user"
    ContextKeySubscription = "gateway_subscription"
    ContextKeyPlan         = "gateway_plan"
  )

  // SetUserContext stores user, subscription, and plan in the gin context.
  func SetUserContext(c *gin.Context, user *model.User, sub *model.Subscription, plan *model.Plan) {
    c.Set(ContextKeyUser, user)
    c.Set(ContextKeySubscription, sub)
    c.Set(ContextKeyPlan, plan)
  }

  // GetUserFromContext retrieves the authenticated user from gin context.
  func GetUserFromContext(c *gin.Context) *model.User {
    v, exists := c.Get(ContextKeyUser)
    if !exists {
      return nil
    }
    user, _ := v.(*model.User)
    return user
  }

  // GetSubscriptionFromContext retrieves the active subscription from gin context.
  func GetSubscriptionFromContext(c *gin.Context) *model.Subscription {
    v, exists := c.Get(ContextKeySubscription)
    if !exists {
      return nil
    }
    sub, _ := v.(*model.Subscription)
    return sub
  }

  // GetPlanFromContext retrieves the plan from gin context.
  func GetPlanFromContext(c *gin.Context) *model.Plan {
    v, exists := c.Get(ContextKeyPlan)
    if !exists {
      return nil
    }
    plan, _ := v.(*model.Plan)
    return plan
  }
  ```

- [ ] **Step 2: 从 `ratelimit.go` 删除已迁移的代码（第 3-55 行）**

  删除 `ratelimit.go` 中的以下内容：
  - `import` 中的 `gin.woa.com/.../model`（如无其他 model 使用）
  - `ContextKey*` 常量块（第 13-18 行）
  - `SetUserContext` 函数（第 20-25 行）
  - `GetUserFromContext` 函数（第 27-35 行）
  - `GetSubscriptionFromContext` 函数（第 37-45 行）
  - `GetPlanFromContext` 函数（第 47-55 行）

  保留 `RateLimiter` 函数不变，调整 import。

- [ ] **Step 3: 验证绿色测试通过**

  ```
  cd ai-gateway && go test ./internal/middleware/... -run "TestGetUserFromContext|TestGetSubscriptionFromContext|TestGetPlanFromContext|TestSetUserContext" -v -count=1
  ```

  预期：全部 PASS

---

## Chunk 4: 全面验证

- [ ] **Step 1: 全量编译**

  ```
  cd ai-gateway && go build ./...
  ```

  预期：exit 0

- [ ] **Step 2: 全量测试**

  ```
  cd ai-gateway && go test ./internal/middleware/... -v -count=1
  ```

  预期：所有 middleware 测试 PASS（含 `ratelimit_test.go` 和新的 `context_test.go`）

- [ ] **Step 3: 端到端集成测试（可选）**

  ```
  cd ai-gateway && go test ./... -count=1 2>&1 | tail -20
  ```

  预期：无新增失败

- [ ] **Step 4: GitNexus 影响范围确认**

  用 gitnexus_detect_changes(scope=all) 确认只有预期文件变更：
  - 新增：`context.go`、`context_test.go`
  - 修改：`ratelimit.go`（删除已迁移代码）
  - 其他文件：无变化

---

## Chunk 5: 提交

- [ ] **Step 1: 提交**

  ```bash
  cd ai-gateway && git add internal/middleware/context.go internal/middleware/context_test.go internal/middleware/ratelimit.go
  git commit -m "refactor(middleware): extract context helpers to context.go

  - Move ContextKey*, SetUserContext, GetUserFromContext, GetSubscriptionFromContext,
    GetPlanFromContext from ratelimit.go to new context.go
  - Add unit tests for all context helpers (context_test.go)
  - RateLimiter in ratelimit.go unchanged
  "
  ```

---

## 变更文件清单

| 操作 | 文件 |
|------|------|
| 新增 | `ai-gateway/internal/middleware/context.go` |
| 新增 | `ai-gateway/internal/middleware/context_test.go` |
| 修改 | `ai-gateway/internal/middleware/ratelimit.go`（删除已迁移代码，保留 `RateLimiter`） |

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 跨包引用漏改 | 低 | 高 | 已确认所有跨包调用均为 `middleware.xxx`，移动后路径不变 |
| `ratelimit.go` import 清理不完整 | 低 | 中 | 编译验证会捕获 |
| 测试覆盖不足 | 低 | 中 | 新增 `context_test.go` 直接测试所有 helper |
| 破坏现有功能 | 低 | 高 | TDD 红色→绿色 + 全量测试验证 |
