// Package whitelist 提供用户白名单查询功能
package whitelist

import (
	"fmt"

	"go.uber.org/zap"

	"ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/cache"
	"ctl/pkg/context"
	"ctl/pkg/resource"
	"ctl/pkg/util"
)

const (
	// WhitelistCacheExpireSeconds 缓存过期时间（秒），15分钟
	WhitelistCacheExpireSeconds = 900
)

// Whitelist 白名单服务接口
type Whitelist interface {
	// IsInWhitelist 检查用户是否在指定白名单中
	IsInWhitelist(ctx context.Context, userID string, whitelistType string) (bool, error)
}

// whitelistService 白名单服务实现
type whitelistService struct {
	whitelistAdapter whitelist.Adapter
	cache            cache.Cache
	logger           *zap.Logger
}

// NewWhitelist 创建新的白名单服务
func NewWhitelist() Whitelist {
	return &whitelistService{
		whitelistAdapter: factory.DefaultAdapterFactory.WhitelistAdapter(),
		cache:            cache.New(),
		logger:           resource.ZapLogger,
	}
}

// IsInWhitelist 检查用户是否在指定白名单中
func (w *whitelistService) IsInWhitelist(ctx context.Context, userID string, whitelistType string) (bool, error) {
	cacheKey := w.buildCacheKey(userID, whitelistType)
	var cached bool
	found, err := w.cache.Get(cacheKey, &cached)
	if err != nil {
		w.logger.Warn(fmt.Sprintf("cache get error: %v", err))
	} else if found {
		w.logger.Info(fmt.Sprintf("cache hit for user_id: %s, type: %s", userID, whitelistType))
		return cached, nil
	}

	// 请求接口查询
	whitelistCtx := &whitelist.Context{
		Context: ctx,
	}
	resp, err := w.whitelistAdapter.QConfigBatchGetWhiteList(whitelistCtx, []string{whitelistType}, []string{userID})
	if err != nil {
		return false, fmt.Errorf("adapter call error: %w", err)
	}

	inWhitelist := false
	if userIDList, exists := resp[whitelistType]; exists {
		inWhitelist = util.Contains(userIDList, userID)
	}

	err = w.cache.Set(cacheKey, inWhitelist, WhitelistCacheExpireSeconds)
	if err != nil {
		w.logger.Warn(fmt.Sprintf("cache set error: %v", err))
	}

	return inWhitelist, nil
}

// buildCacheKey 构建缓存键
func (w *whitelistService) buildCacheKey(userID string, whitelistType string) string {
	return fmt.Sprintf("whitelist:user_id:%s:type:%s", userID, whitelistType)
}
