package scheduler

import (
	"log/slog"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
)

// HealthChecker 定期检查 registry 来源提供商的健康状态。
type HealthChecker struct {
	providerRepo repository.ProviderRepo
	mappingRepo  repository.ModelMappingRepo
	staleTimeout time.Duration
	httpClient   *http.Client
}

// NewHealthChecker 创建健康检查器。
func NewHealthChecker(providerRepo repository.ProviderRepo, mappingRepo repository.ModelMappingRepo, staleTimeoutS int) *HealthChecker {
	return &HealthChecker{
		providerRepo: providerRepo,
		mappingRepo:  mappingRepo,
		staleTimeout: time.Duration(staleTimeoutS) * time.Second,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// Check 执行一轮健康检查。
func (hc *HealthChecker) Check() {
	providers, err := hc.providerRepo.ListForHealthCheck(model.RegistrationSourceRegistry)
	if err != nil {
		slog.Error("获取 registry 提供商列表失败", "error", err)
		return
	}

	for _, p := range providers {
		if p.HealthCheckURL != "" {
			hc.checkHTTP(&p)
		} else {
			hc.checkHeartbeat(&p)
		}
	}
}

// checkHTTP 通过 HTTP GET 检查提供商健康状态。
func (hc *HealthChecker) checkHTTP(p *model.Provider) {
	resp, err := hc.httpClient.Get(p.HealthCheckURL)
	if err != nil || resp.StatusCode >= 400 {
		if p.Status == model.ProviderStatusActive {
			if err := hc.providerRepo.UpdateStatus(p.ID, model.ProviderStatusUnhealthy); err != nil {
				slog.Error("标记提供商 unhealthy 失败", "provider_id", p.ID, "error", err)
			} else {
				slog.Warn("提供商健康检查失败，标记为 unhealthy",
					"provider_id", p.ID, "name", p.Name, "health_check_url", p.HealthCheckURL)
			}
		}
		if resp != nil {
			resp.Body.Close()
		}
		return
	}
	resp.Body.Close()

	// 健康检查通过，如果之前是 unhealthy 则恢复
	if p.Status == model.ProviderStatusUnhealthy {
		if err := hc.providerRepo.UpdateStatus(p.ID, model.ProviderStatusActive); err != nil {
			slog.Error("恢复提供商 active 失败", "provider_id", p.ID, "error", err)
		} else {
			slog.Info("提供商健康检查通过，恢复为 active", "provider_id", p.ID, "name", p.Name)
		}
	}
}

// checkHeartbeat 通过心跳时间检查提供商是否过期。
func (hc *HealthChecker) checkHeartbeat(p *model.Provider) {
	if p.LastHeartbeat == nil {
		return
	}

	staleDuration := time.Since(*p.LastHeartbeat)

	// 超过 3 倍超时 → 自动删除
	if staleDuration > 3*hc.staleTimeout {
		slog.Warn("提供商超时过久，自动删除",
			"provider_id", p.ID, "name", p.Name, "last_heartbeat", p.LastHeartbeat)
		// 先删除映射
		if err := hc.mappingRepo.DeleteByProviderID(p.ID); err != nil {
			slog.Error("删除提供商映射失败", "provider_id", p.ID, "error", err)
		}
		if err := hc.providerRepo.Delete(p.ID); err != nil {
			slog.Error("删除超时提供商失败", "provider_id", p.ID, "error", err)
		}
		return
	}

	// 超过超时 → 标记 unhealthy
	if staleDuration > hc.staleTimeout && p.Status == model.ProviderStatusActive {
		if err := hc.providerRepo.UpdateStatus(p.ID, model.ProviderStatusUnhealthy); err != nil {
			slog.Error("标记提供商 unhealthy 失败", "provider_id", p.ID, "error", err)
		} else {
			slog.Warn("提供商心跳超时，标记为 unhealthy",
				"provider_id", p.ID, "name", p.Name,
				"last_heartbeat", p.LastHeartbeat, "stale_duration", staleDuration)
		}
	}
}
