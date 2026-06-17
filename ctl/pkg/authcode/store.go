// Package authcode 提供"一次性鉴权 ticket"的存储抽象。
//
// 用途：契约文档《CodeBuddy AuthCode 模式》中转页支付链路 — PC 端下单时签发
// ticket，中转页（手机微信浏览器无 Bearer）调 order-url 时凭 ticket 反查
// user_id，并立即作废。
//
// 设计要点（详见 .tmp/ctl-authcode-codebuddy-design.md §4.1）：
//   - 严格一次性：消费走 Lua 脚本 GET + DEL 原子化（不能用 Cache.Get + Cache.Del
//     二步式，前者会出现 TOCTOU）
//   - 绑定校验：ticket 携带 deal_names + 可选 pass_id；消费时由调用方在 Go 侧
//     校验 deal_names 匹配（Lua 字符串处理弱，不放进脚本）
//   - TTL：默认 600s（10 min），与前端二维码过期时间对齐
package authcode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Ticket 是一次性鉴权 ticket 的内容（Redis value 反序列化为本结构体）。
type Ticket struct {
	// UserID 必填：签发时绑定的 user_id；Consume 后由 handler 透传给 logic。
	UserID string `json:"user_id"`
	// DealNames 必填：签发时绑定的订单号集合；Consume 后调用方必须再校验
	// req.DealNames 与本字段完全一致（A2 不变量）。
	DealNames []string `json:"deal_names"`
	// PassID 可选：续费场景填，新购为空（A3 不变量：跨 pass 撞 ticket 校验依据）。
	PassID string `json:"pass_id,omitempty"`
	// IssuedAt 签发时间（unix seconds），用于审计 / 排查。
	IssuedAt int64 `json:"issued_at"`
}

// Store 提供 ticket 签发 / 消费 / 作废能力。
type Store interface {
	// Issue 签发新 ticket，返回 auth_code（UUID v4 字符串，36 字节）。
	//
	// 入参约束：
	//   - t 必须非 nil，t.UserID 与 t.DealNames 必须非空，否则返参数错。
	//   - t.IssuedAt 为 0 时由本函数填入 time.Now().Unix()。
	//
	// Redis Key Schema：auth_code:<uuid-v4>，TTL = New 时注入的 ttl。
	Issue(ctx context.Context, t *Ticket) (string, error)

	// Consume 原子消费：GET + DEL 一次完成；返回反序列化后的 ticket。
	//
	// 错误语义：
	//   - 找不到 / 已过期 / 已被消费 → ErrTicketNotFound（哨兵错，调用方走 errors.Is）
	//   - 反序列化失败 / Redis 网络错 → 包装错（含 "authcode: " 前缀）
	//
	// 调用方职责：拿到 ticket 后必须自行校验 ticket.DealNames / ticket.PassID
	// 与请求参数匹配（A2 / A3 不变量）。
	Consume(ctx context.Context, authCode string) (*Ticket, error)

	// Revoke 主动作废（如用户在 PC 端取消订单时同步作废 ticket）。
	//
	// authCode 为空字符串时直接返 nil（noop）；其他场景透传 Redis DEL 错。
	Revoke(ctx context.Context, authCode string) error
}

// ErrTicketNotFound ticket 在 Redis 中不存在（不存在 / 过期 / 已被消费）。
//
// 哨兵错；handler 层用 errors.Is(err, authcode.ErrTicketNotFound) 判别，
// 映射为 errcode.ErrAuthCodeInvalid（HTTP 401 AUTH_CODE_INVALID）。
var ErrTicketNotFound = errors.New("authcode: ticket not found or already consumed")

// keyPrefix Redis key 前缀；消费 / 作废 / 签发统一拼接 keyPrefix + uuid。
const keyPrefix = "auth_code:"

// DefaultTTL 默认 ticket 有效期（10 min），与前端二维码过期时间对齐。
const DefaultTTL = 600 * time.Second

// consumeScript 是 GET + DEL 原子消费脚本（与 ctl/pkg/logic/lock/logic.go::unlockScript
// 同范式：用 Lua 保证强一致，避免 Go 侧 GET 后第二个 client 抢先 GET 拿到同值的 TOCTOU）。
//
// 返回：
//   - 命中 → ticket raw JSON 字符串
//   - 未命中 → nil（go-redis 把 nil 翻译为 redis.Nil 错）
var consumeScript = redis.NewScript(`
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
redis.call("DEL", KEYS[1])
return raw
`)

// store 是 Store 接口的 Redis 实现。
type store struct {
	client *redis.Client
	ttl    time.Duration
}

// New 构造 Store；client 必须非 nil（Init 调用方在启动期保证）；ttl <= 0 时
// 走 DefaultTTL 兜底。
func New(client *redis.Client, ttl time.Duration) Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &store{client: client, ttl: ttl}
}

// Issue 详见 Store.Issue。
func (s *store) Issue(ctx context.Context, t *Ticket) (string, error) {
	if t == nil || t.UserID == "" || len(t.DealNames) == 0 {
		return "", fmt.Errorf("authcode: ticket missing user_id or deal_names")
	}
	if t.IssuedAt == 0 {
		t.IssuedAt = time.Now().Unix()
	}
	code := uuid.New().String()
	raw, err := json.Marshal(t)
	if err != nil {
		return "", fmt.Errorf("authcode marshal: %w", err)
	}
	if err := s.client.Set(ctx, keyPrefix+code, raw, s.ttl).Err(); err != nil {
		return "", fmt.Errorf("authcode set: %w", err)
	}
	return code, nil
}

// Consume 详见 Store.Consume。
func (s *store) Consume(ctx context.Context, authCode string) (*Ticket, error) {
	if authCode == "" {
		return nil, ErrTicketNotFound
	}
	raw, err := consumeScript.Run(ctx, s.client, []string{keyPrefix + authCode}).Text()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, ErrTicketNotFound
		}
		return nil, fmt.Errorf("authcode consume: %w", err)
	}
	var t Ticket
	if err := json.Unmarshal([]byte(raw), &t); err != nil {
		return nil, fmt.Errorf("authcode unmarshal: %w", err)
	}
	return &t, nil
}

// Revoke 详见 Store.Revoke。
func (s *store) Revoke(ctx context.Context, authCode string) error {
	if authCode == "" {
		return nil
	}
	if err := s.client.Del(ctx, keyPrefix+authCode).Err(); err != nil {
		return fmt.Errorf("authcode revoke: %w", err)
	}
	return nil
}

// DefaultStore 是 Store 的全局默认实例；由 main 启动期通过 Init 注入，logic /
// handler 层通过 DefaultStore.Issue / Consume / Revoke 调用，避免改造一片
// logic 工厂签名（设计稿 §4.6 同范式）。
//
// 启动期 Init 失败 / 未调用 Init 时为 nil；调用方应做 nil 兜底（A8 不变量：
// Issue 失败时降级返回空 auth_code，不阻断主链路）。
var DefaultStore Store

// Init 在启动期注入全局 Store；client 必须为 ctl 主 Redis 客户端
// （resource.RedisMainClient）。重复调用以最后一次为准。
func Init(client *redis.Client, ttl time.Duration) {
	DefaultStore = New(client, ttl)
}
