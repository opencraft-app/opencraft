// Package ratelimitadapter 提供 SQLite 单进程模式的内存限流实现。
package ratelimitadapter

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	clockport "chatserver/internal/ports/clock"
	ratelimitport "chatserver/internal/ports/ratelimit"
)

var (
	// ErrInvalidConfig 表示内存 limiter 配置不完整或冲突。
	ErrInvalidConfig = errors.New("内存限流配置无效")
	// ErrInvalidRequest 表示限流请求不能形成稳定 bucket。
	ErrInvalidRequest = errors.New("限流请求无效")
	// ErrPolicyNotFound 表示操作类和主体类型没有匹配策略。
	ErrPolicyNotFound = errors.New("未配置限流策略")
	// ErrBucketCapacity 表示本地 limiter 已达到安全容量上限。
	ErrBucketCapacity = errors.New("本地限流容量已满")
)

// Rule 定义某类主体在某操作类下的固定窗口策略。
type Rule struct {
	SubjectKind    ratelimitport.SubjectKind
	OperationClass string
	Limit          uint64
	Window         time.Duration
}

// Config 定义进程内 limiter 规则和安全容量。
type Config struct {
	Rules      []Rule
	MaxBuckets int
}

type policy struct {
	limit  uint64
	window time.Duration
}

type bucket struct {
	used    uint64
	resetAt time.Time
}

// Memory 是多主体原子固定窗口 limiter。
type Memory struct {
	mu         sync.Mutex
	clock      clockport.Clock
	policies   map[string]policy
	buckets    map[string]bucket
	maxBuckets int
}

// NewMemory 创建进程内 limiter。
func NewMemory(clock clockport.Clock, config Config) (*Memory, error) {
	if clock == nil || len(config.Rules) == 0 || config.MaxBuckets <= 0 {
		return nil, ErrInvalidConfig
	}
	policies := make(map[string]policy, len(config.Rules))
	for _, rule := range config.Rules {
		operationClass := strings.TrimSpace(rule.OperationClass)
		if operationClass == "" ||
			rule.SubjectKind == "" ||
			rule.Limit == 0 ||
			rule.Window <= 0 {
			return nil, ErrInvalidConfig
		}
		key := policyKey(rule.SubjectKind, operationClass)
		if _, exists := policies[key]; exists {
			return nil, ErrInvalidConfig
		}
		policies[key] = policy{limit: rule.Limit, window: rule.Window}
	}
	return &Memory{
		clock:      clock,
		policies:   policies,
		buckets:    make(map[string]bucket),
		maxBuckets: config.MaxBuckets,
	}, nil
}

// Allow 对请求中的所有主体执行一次原子判定。
func (limiter *Memory) Allow(
	ctx context.Context,
	request ratelimitport.Request,
) (ratelimitport.Decision, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return ratelimitport.Decision{}, err
	}
	operationClass := strings.TrimSpace(request.OperationClass)
	if limiter == nil ||
		limiter.clock == nil ||
		operationClass == "" ||
		request.Cost == 0 ||
		len(request.Subjects) == 0 {
		return ratelimitport.Decision{}, ErrInvalidRequest
	}

	now := limiter.clock.Now()
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return ratelimitport.Decision{}, err
	}

	type plannedBucket struct {
		key   string
		value bucket
	}
	planned := make([]plannedBucket, 0, len(request.Subjects))
	seen := make(map[string]struct{}, len(request.Subjects))
	var retryAfter time.Duration
	blocked := false

	for _, subject := range request.Subjects {
		key := bucketKey(request.ServerID, operationClass, subject)
		if subject.Kind() == "" || subject.Key() == "" {
			return ratelimitport.Decision{}, ErrInvalidRequest
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}

		rule, ok := limiter.policies[policyKey(subject.Kind(), operationClass)]
		if !ok {
			return ratelimitport.Decision{}, ErrPolicyNotFound
		}
		value, exists := limiter.buckets[key]
		if !exists || !now.Before(value.resetAt) {
			value = bucket{resetAt: now.Add(rule.window)}
		}
		if request.Cost > rule.limit || value.used > rule.limit-request.Cost {
			blocked = true
			remaining := value.resetAt.Sub(now)
			if remaining > retryAfter {
				retryAfter = remaining
			}
		}
		planned = append(planned, plannedBucket{
			key:   key,
			value: value,
		})
	}

	if blocked {
		return ratelimitport.Decision{
			Allowed:    false,
			RetryAfter: retryAfter,
		}, nil
	}
	if err := ctx.Err(); err != nil {
		return ratelimitport.Decision{}, err
	}

	missing := 0
	for _, item := range planned {
		if _, exists := limiter.buckets[item.key]; !exists {
			missing++
		}
	}
	if len(limiter.buckets)+missing > limiter.maxBuckets {
		limiter.pruneExpired(now)
		missing = 0
		for _, item := range planned {
			if _, exists := limiter.buckets[item.key]; !exists {
				missing++
			}
		}
		if len(limiter.buckets)+missing > limiter.maxBuckets {
			return ratelimitport.Decision{}, ErrBucketCapacity
		}
	}

	for _, item := range planned {
		item.value.used += request.Cost
		limiter.buckets[item.key] = item.value
	}
	return ratelimitport.Decision{Allowed: true}, nil
}

func (limiter *Memory) pruneExpired(now time.Time) {
	for key, value := range limiter.buckets {
		if !now.Before(value.resetAt) {
			delete(limiter.buckets, key)
		}
	}
}

func policyKey(
	kind ratelimitport.SubjectKind,
	operationClass string,
) string {
	return string(kind) + "\x00" + operationClass
}

func bucketKey(
	serverID string,
	operationClass string,
	subject ratelimitport.Subject,
) string {
	return serverID + "\x00" +
		operationClass + "\x00" +
		string(subject.Kind()) + "\x00" +
		subject.Key()
}
