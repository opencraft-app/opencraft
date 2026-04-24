package service

import (
	"encoding/json"
	"log/slog"
	"sync"

	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
)

const routingConfigKey = "routing"

// PortkeyStrategyConfig路由策略配置。
type PortkeyStrategyConfig struct {
	Mode             string `json:"mode"`               // "loadbalance" | "fallback"
	OnStatusCodes    []int  `json:"on_status_codes"`    // strategy 触发状态码
	RetryAttempts    int    `json:"retry_attempts"`     // 0-5
	RetryStatusCodes []int  `json:"retry_status_codes"` // retry 触发状态码
}

// DefaultPortkeyStrategy 返回默认的路由策略。
func DefaultPortkeyStrategy() PortkeyStrategyConfig {
	return PortkeyStrategyConfig{
		Mode:             "fallback",
		OnStatusCodes:    []int{429, 500, 502, 503, 504},
		RetryAttempts:    3,
		RetryStatusCodes: []int{429, 503},
	}
}

// RoutingConfig 路由配置，包含熔断和路由策略参数。
type RoutingConfig struct {
	FailureThreshold  int    `json:"failure_threshold"`
	CooldownDurationS int    `json:"cooldown_duration_s"`
	DefaultModel      string `json:"default_model"`
	// 路由策略
	Strategy PortkeyStrategyConfig `json:"strategy"`
}

// RuntimeConfigStore 运行时配置存储，支持内存缓存 + DB 持久化。
type RuntimeConfigStore struct {
	mu     sync.RWMutex
	config RoutingConfig
	repo   repository.RuntimeConfigRepo
}

// NewRuntimeConfigStore 创建 RuntimeConfigStore，先使用默认值，再从 DB 加载覆盖。
func NewRuntimeConfigStore(repo repository.RuntimeConfigRepo, defaults RoutingConfig) *RuntimeConfigStore {
	s := &RuntimeConfigStore{
		config: defaults,
		repo:   repo,
	}
	// 从 DB 加载覆盖
	s.loadFromDB()
	return s
}

// loadFromDB 从数据库加载配置，失败时保持默认值。
func (s *RuntimeConfigStore) loadFromDB() {
	rc, err := s.repo.Get(routingConfigKey)
	if err != nil {
		slog.Warn("加载运行时配置失败，使用默认值", "error", err)
		return
	}
	if rc == nil {
		return // DB 中没有，使用默认值
	}
	var cfg RoutingConfig
	if err := json.Unmarshal(rc.Value, &cfg); err != nil {
		slog.Warn("解析运行时配置失败，使用默认值", "error", err)
		return
	}
	// 兼容旧配置：DB 中无 strategy 字段时补充默认值
	if cfg.Strategy.Mode == "" {
		cfg.Strategy = DefaultPortkeyStrategy()
	}
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
	slog.Info("从数据库加载路由配置", "config", cfg)
}

// Get 获取当前路由配置（线程安全）。
func (s *RuntimeConfigStore) Get() RoutingConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// Update 更新路由配置到 DB 和内存。
func (s *RuntimeConfigStore) Update(cfg RoutingConfig) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	if err := s.repo.Upsert(routingConfigKey, data); err != nil {
		return err
	}
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
	return nil
}

// SetForTest 仅用于测试，直接设置内存中的配置（不写 DB）。
func (s *RuntimeConfigStore) SetForTest(cfg RoutingConfig) {
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
}
